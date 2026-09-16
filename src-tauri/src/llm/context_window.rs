//! How big a model's context window is (0.17.9).
//!
//! The meter has always shown how much context a chat carries and never how
//! much it *may* carry, because no OpenAI-compatible `/models` response says.
//! The harnesses that do show a ceiling get it from several places, and so
//! does this, in order of how much each is to be trusted:
//!
//! 1. **The provider's own model entry.** Some servers do put it on `/models`:
//!    OpenRouter as `context_length`, vLLM as `max_model_len`, a few gateways
//!    as `context_window` or `max_context_length`. When the server that will
//!    run the request says, that is the answer.
//! 2. **A local server's native API.** Ollama's `POST /api/show` reports the
//!    architecture's `context_length` (and a `num_ctx` override, when the
//!    Modelfile set one — that is the figure it will actually honour). LM
//!    Studio's `GET /api/v0/models` carries `max_context_length`. These are
//!    tried only against a private address, so a cloud provider never sees a
//!    stray request.
//! 3. **The models.dev catalogue** — the community-maintained database that
//!    opencode reads: every model on every notable provider with its
//!    `limit.context`. Fetched once a day and kept on disk under the app data
//!    dir, so an offline start still has yesterday's copy.
//! 4. **A short table of family names**, for a model nobody has catalogued,
//!    which is mostly a local fine-tune whose name still says what it is.
//!
//! Every answer says where it came from, and the panel repeats that, because
//! a ceiling from a catalogue is a claim about the model and a ceiling from
//! the server is a fact about this deployment. Failures return `None` rather
//! than an error: this is a readout, and a provider that will not answer is
//! not a reason to blank the rest of the meter.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::db::models::Provider;

/// A model's context ceiling and the evidence for it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextWindow {
    pub tokens: i64,
    /// `provider`, `ollama`, `lmstudio`, `catalog` or `heuristic`.
    pub source: &'static str,
}

const CATALOG_URL: &str = "https://models.dev/api.json";
const CATALOG_FILE: &str = "models-dev.json";
const CATALOG_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a resolved (or failed) lookup is held before the provider is asked
/// again. The meter polls every few seconds while a turn runs; the answer does
/// not change on that timescale.
const LOOKUP_TTL: Duration = Duration::from_secs(60 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

struct Cached {
    at: Instant,
    value: Option<ContextWindow>,
}

fn lookup_cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The ceiling for `model` as served by `provider`, from the best source that
/// will answer, or `None` if nothing knows. Cached per provider+model for an
/// hour, misses included.
pub async fn lookup(
    http: &reqwest::Client,
    app_data_dir: &Path,
    provider: &Provider,
    model: &str,
) -> Option<ContextWindow> {
    let key = format!("{}\u{0}{}", provider.base_url.trim_end_matches('/'), model);
    if let Some(hit) = lookup_cache().lock().ok().and_then(|c| {
        c.get(&key)
            .filter(|c| c.at.elapsed() < LOOKUP_TTL)
            .map(|c| c.value.clone())
    }) {
        return hit;
    }
    let value = resolve(http, app_data_dir, provider, model).await;
    if let Ok(mut c) = lookup_cache().lock() {
        c.insert(key, Cached { at: Instant::now(), value: value.clone() });
    }
    value
}

async fn resolve(
    http: &reqwest::Client,
    app_data_dir: &Path,
    provider: &Provider,
    model: &str,
) -> Option<ContextWindow> {
    let base = provider.base_url.trim_end_matches('/');
    if let Some(t) = from_models_endpoint(http, base, provider.api_key.as_deref(), model).await {
        return Some(ContextWindow { tokens: t, source: "provider" });
    }
    if is_private_host(base) {
        if let Some(t) = from_ollama(http, base, model).await {
            return Some(ContextWindow { tokens: t, source: "ollama" });
        }
        if let Some(t) = from_lmstudio(http, base, model).await {
            return Some(ContextWindow { tokens: t, source: "lmstudio" });
        }
    }
    if let Some(catalog) = catalog(http, app_data_dir).await {
        if let Some(t) = catalog.find(base, model) {
            return Some(ContextWindow { tokens: t, source: "catalog" });
        }
    }
    heuristic(model).map(|t| ContextWindow { tokens: t, source: "heuristic" })
}

// ── 1. The provider's /models entry ─────────────────────────────────────────

/// The fields a `/models` entry might carry the ceiling in. Each is what one
/// family of servers calls it; none of them is standard.
fn window_field(entry: &Value) -> Option<i64> {
    const KEYS: &[&str] = &[
        "context_length",
        "max_model_len",
        "context_window",
        "max_context_length",
        "max_input_tokens",
        "n_ctx",
    ];
    for key in KEYS {
        if let Some(n) = entry.get(key).and_then(positive) {
            return Some(n);
        }
    }
    // OpenRouter repeats it under `top_provider`; LiteLLM's /model/info shape
    // nests it under `model_info`.
    for nest in ["top_provider", "model_info", "limits", "limit"] {
        if let Some(inner) = entry.get(nest) {
            for key in KEYS.iter().chain(["context"].iter()) {
                if let Some(n) = inner.get(key).and_then(positive) {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn positive(v: &Value) -> Option<i64> {
    let n = v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))?;
    (n > 0).then_some(n)
}

async fn from_models_endpoint(
    http: &reqwest::Client,
    base: &str,
    api_key: Option<&str>,
    model: &str,
) -> Option<i64> {
    let mut req = http.get(format!("{base}/models")).timeout(PROBE_TIMEOUT);
    if let Some(k) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let body: Value = req.send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
    let list = body.get("data").and_then(Value::as_array)?;
    list.iter()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(model))
        .and_then(window_field)
}

// ── 2. Local servers ────────────────────────────────────────────────────────

/// True for an address that can only be this machine or its network — the
/// only kind worth probing with a non-OpenAI request.
pub fn is_private_host(base: &str) -> bool {
    let host = host_of(base);
    host == "localhost"
        || host == "127.0.0.1"
        || host == "0.0.0.0"
        || host == "::1"
        || host.ends_with(".local")
        || host.ends_with(".lan")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || {
            let mut it = host.split('.');
            it.next() == Some("172")
                && it
                    .next()
                    .and_then(|s| s.parse::<u8>().ok())
                    .map_or(false, |n| (16..=31).contains(&n))
        }
}

/// `scheme://host:port` with any path removed, for a server whose native API
/// sits beside its OpenAI-compatible one rather than under it.
fn origin_of(base: &str) -> String {
    let (scheme, rest) = base.split_once("://").unwrap_or(("http", base));
    let authority = rest.split('/').next().unwrap_or(rest);
    format!("{scheme}://{authority}")
}

fn host_of(base: &str) -> String {
    let rest = base.split_once("://").map_or(base, |(_, r)| r);
    let authority = rest.split('/').next().unwrap_or(rest);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    // `[::1]:11434` keeps its brackets; `host:port` loses the port.
    if let Some(v6) = authority.strip_prefix('[') {
        return v6.split(']').next().unwrap_or(v6).to_lowercase();
    }
    authority.split(':').next().unwrap_or(authority).to_lowercase()
}

async fn from_ollama(http: &reqwest::Client, base: &str, model: &str) -> Option<i64> {
    let url = format!("{}/api/show", origin_of(base));
    let body: Value = http
        .post(url)
        .timeout(PROBE_TIMEOUT)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    ollama_window(&body)
}

/// A Modelfile `num_ctx` wins over the architecture's ceiling: it is the size
/// the server will actually allocate, and it is usually smaller.
fn ollama_window(show: &Value) -> Option<i64> {
    if let Some(params) = show.get("parameters").and_then(Value::as_str) {
        for line in params.lines() {
            let mut it = line.split_whitespace();
            if it.next() == Some("num_ctx") {
                if let Some(n) = it.next().and_then(|s| s.parse::<i64>().ok()).filter(|n| *n > 0) {
                    return Some(n);
                }
            }
        }
    }
    let info = show.get("model_info")?.as_object()?;
    info.iter()
        .find(|(k, _)| k.ends_with(".context_length"))
        .and_then(|(_, v)| positive(v))
}

async fn from_lmstudio(http: &reqwest::Client, base: &str, model: &str) -> Option<i64> {
    let url = format!("{}/api/v0/models", origin_of(base));
    let body: Value = http
        .get(url)
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    body.get("data")?
        .as_array()?
        .iter()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(model))
        .and_then(|e| e.get("max_context_length"))
        .and_then(positive)
}

// ── 3. The models.dev catalogue ─────────────────────────────────────────────

/// The catalogue reduced to what this module asks of it.
pub struct Catalog {
    /// Provider id → its API base host (when the catalogue names one).
    hosts: HashMap<String, String>,
    /// Model id → every (provider id, context) pair that lists it.
    models: HashMap<String, Vec<(String, i64)>>,
}

#[derive(Deserialize)]
struct CatalogProvider {
    #[serde(default)]
    api: Option<String>,
    #[serde(default)]
    models: HashMap<String, CatalogModel>,
}

#[derive(Deserialize)]
struct CatalogModel {
    #[serde(default)]
    limit: Option<CatalogLimit>,
}

#[derive(Deserialize)]
struct CatalogLimit {
    #[serde(default)]
    context: Option<i64>,
}

impl Catalog {
    pub fn parse(json: &str) -> Option<Catalog> {
        let raw: HashMap<String, CatalogProvider> = serde_json::from_str(json).ok()?;
        let mut hosts = HashMap::new();
        let mut models: HashMap<String, Vec<(String, i64)>> = HashMap::new();
        for (pid, p) in raw {
            if let Some(api) = p.api.as_deref() {
                hosts.insert(pid.clone(), host_of(api));
            }
            for (mid, m) in p.models {
                if let Some(ctx) = m.limit.and_then(|l| l.context).filter(|c| *c > 0) {
                    models.entry(mid.to_lowercase()).or_default().push((pid.clone(), ctx));
                }
            }
        }
        Some(Catalog { hosts, models })
    }

    /// The ceiling for `model` on the provider at `base`, or the commonest
    /// answer across providers when this one is not in the catalogue.
    ///
    /// The id is tried as given, then without a `vendor/` prefix (a router's
    /// `openai/gpt-4o` is the catalogue's `gpt-4o` on OpenAI), then without an
    /// Ollama-style `:tag`.
    pub fn find(&self, base: &str, model: &str) -> Option<i64> {
        let host = host_of(base);
        let m = model.to_lowercase();
        let mut candidates: Vec<&str> = vec![&m];
        if let Some((_, rest)) = m.split_once('/') {
            candidates.push(rest);
        }
        if let Some((stem, _)) = m.split_once(':') {
            candidates.push(stem);
        }
        for id in candidates {
            let Some(entries) = self.models.get(id) else { continue };
            // The provider we are actually talking to, if the catalogue knows
            // its host.
            if let Some((_, ctx)) = entries.iter().find(|(pid, _)| {
                self.hosts.get(pid).map_or(false, |h| !h.is_empty() && h == &host)
            }) {
                return Some(*ctx);
            }
            // A well-known host the catalogue lists without an `api` field.
            if let Some(pid) = provider_for_host(&host) {
                if let Some((_, ctx)) = entries.iter().find(|(p, _)| p == pid) {
                    return Some(*ctx);
                }
            }
            // Otherwise the value most providers agree on: the model's own
            // ceiling, rather than one router's truncation of it.
            let mut counts: HashMap<i64, usize> = HashMap::new();
            for (_, ctx) in entries {
                *counts.entry(*ctx).or_default() += 1;
            }
            if let Some((ctx, _)) = counts.into_iter().max_by_key(|(ctx, n)| (*n, *ctx)) {
                return Some(ctx);
            }
        }
        None
    }
}

/// First-party hosts whose catalogue entry carries no `api` field.
fn provider_for_host(host: &str) -> Option<&'static str> {
    Some(match host {
        "api.openai.com" => "openai",
        "api.anthropic.com" => "anthropic",
        "api.groq.com" => "groq",
        "api.mistral.ai" => "mistral",
        "api.x.ai" => "xai",
        "generativelanguage.googleapis.com" => "google",
        "api.deepseek.com" => "deepseek",
        "api.together.xyz" => "togetherai",
        "api.fireworks.ai" => "fireworks-ai",
        "api.cerebras.ai" => "cerebras",
        _ => return None,
    })
}

fn catalog_slot() -> &'static Mutex<Option<std::sync::Arc<Catalog>>> {
    static SLOT: OnceLock<Mutex<Option<std::sync::Arc<Catalog>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn catalog_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CATALOG_FILE)
}

/// The catalogue, from memory, else from the disk copy, else from the network
/// — refreshed in the background once the disk copy is a day old.
async fn catalog(http: &reqwest::Client, app_data_dir: &Path) -> Option<std::sync::Arc<Catalog>> {
    if let Some(c) = catalog_slot().lock().ok().and_then(|s| s.clone()) {
        return Some(c);
    }
    let path = catalog_path(app_data_dir);
    let age = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok());
    let fresh = age.map_or(false, |a| a < CATALOG_MAX_AGE);

    let text = if fresh {
        tokio::fs::read_to_string(&path).await.ok()
    } else {
        match fetch_catalog(http).await {
            Some(t) => {
                if let Some(parent) = path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&path, &t).await;
                Some(t)
            }
            // Offline: a stale copy beats no copy.
            None => tokio::fs::read_to_string(&path).await.ok(),
        }
    }?;
    let parsed = std::sync::Arc::new(Catalog::parse(&text)?);
    if let Ok(mut s) = catalog_slot().lock() {
        *s = Some(parsed.clone());
    }
    Some(parsed)
}

async fn fetch_catalog(http: &reqwest::Client) -> Option<String> {
    http.get(CATALOG_URL)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()
}

// ── 4. Family names ─────────────────────────────────────────────────────────

/// A ceiling by what the name says the model is. Ordered so the more specific
/// pattern is tried first.
pub fn heuristic(model: &str) -> Option<i64> {
    let m = model.to_lowercase();
    const TABLE: &[(&str, i64)] = &[
        ("claude", 200_000),
        ("gpt-5", 400_000),
        ("gpt-4.1", 1_047_576),
        ("gpt-4o", 128_000),
        ("o3", 200_000),
        ("o4", 200_000),
        ("gemini", 1_048_576),
        ("grok", 131_072),
        ("deepseek", 128_000),
        ("qwen3", 131_072),
        ("qwen2.5", 32_768),
        ("llama-4", 1_048_576),
        ("llama4", 1_048_576),
        ("llama-3", 131_072),
        ("llama3", 131_072),
        ("mistral", 128_000),
        ("mixtral", 32_768),
        ("gemma-3", 131_072),
        ("gemma3", 131_072),
        ("gemma", 8_192),
        ("phi-4", 16_384),
        ("phi4", 16_384),
        ("phi", 128_000),
        ("command-r", 128_000),
        ("codestral", 32_768),
    ];
    TABLE.iter().find(|(needle, _)| m.contains(needle)).map(|(_, n)| *n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_each_servers_name_for_the_field() {
        assert_eq!(window_field(&json!({ "context_length": 200000 })), Some(200_000));
        assert_eq!(window_field(&json!({ "max_model_len": 32768 })), Some(32_768));
        assert_eq!(window_field(&json!({ "top_provider": { "context_length": 128000 } })), Some(128_000));
        assert_eq!(window_field(&json!({ "model_info": { "max_input_tokens": 100000 } })), Some(100_000));
        assert_eq!(window_field(&json!({ "id": "x" })), None);
        assert_eq!(window_field(&json!({ "context_length": 0 })), None);
    }

    #[test]
    fn ollama_prefers_the_modelfile_num_ctx() {
        let show = json!({
            "parameters": "num_ctx 16384\nstop \"<|eot|>\"",
            "model_info": { "llama.context_length": 131072, "general.architecture": "llama" }
        });
        assert_eq!(ollama_window(&show), Some(16_384));
        let show = json!({ "model_info": { "qwen2.context_length": 32768 } });
        assert_eq!(ollama_window(&show), Some(32_768));
    }

    #[test]
    fn private_hosts_are_the_only_ones_probed() {
        assert!(is_private_host("http://localhost:11434/v1"));
        assert!(is_private_host("http://192.168.1.20:1234/v1"));
        assert!(is_private_host("http://172.20.0.5:8000/v1"));
        assert!(is_private_host("http://[::1]:11434/v1"));
        assert!(!is_private_host("https://api.openai.com/v1"));
        assert!(!is_private_host("http://172.40.0.5/v1"));
    }

    #[test]
    fn origin_drops_the_path() {
        assert_eq!(origin_of("http://localhost:11434/v1"), "http://localhost:11434");
        assert_eq!(host_of("https://user@openrouter.ai/api/v1"), "openrouter.ai");
    }

    #[test]
    fn the_catalogue_matches_by_host_then_by_consensus() {
        let json = r#"{
            "openrouter": { "api": "https://openrouter.ai/api/v1", "models": {
                "openai/gpt-4o": { "limit": { "context": 128000 } } } },
            "openai": { "models": { "gpt-4o": { "limit": { "context": 128000 } } } },
            "azure": { "models": { "gpt-4o": { "limit": { "context": 64000 } } } },
            "other": { "models": { "gpt-4o": { "limit": { "context": 128000 } } } }
        }"#;
        let c = Catalog::parse(json).unwrap();
        assert_eq!(c.find("https://openrouter.ai/api/v1", "openai/gpt-4o"), Some(128_000));
        assert_eq!(c.find("https://api.openai.com/v1", "gpt-4o"), Some(128_000));
        // Unknown host: the commonest figure, not the outlier.
        assert_eq!(c.find("https://gateway.example/v1", "gpt-4o"), Some(128_000));
        // A router prefix and an Ollama tag are both peeled.
        assert_eq!(c.find("https://gateway.example/v1", "vendor/gpt-4o"), Some(128_000));
        assert_eq!(c.find("http://localhost:11434/v1", "gpt-4o:latest"), Some(128_000));
        assert_eq!(c.find("https://gateway.example/v1", "nothing"), None);
    }

    #[test]
    fn family_names_fall_back() {
        assert_eq!(heuristic("my-claude-finetune"), Some(200_000));
        assert_eq!(heuristic("Llama-3.1-8B-Instruct-Q4"), Some(131_072));
        assert_eq!(heuristic("totally-unknown"), None);
    }
}
