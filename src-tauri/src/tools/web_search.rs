use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use scraper::{Html, Selector};
use serde_json::{json, Value};
use tracing::warn;

// ── User-agent pool ───────────────────────────────────────────────────────────
// Rotate based on query length so requests look like different browsers.
const USER_AGENTS: &[&str] = &[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
];

fn pick_ua(query: &str) -> &'static str {
    USER_AGENTS[query.len() % USER_AGENTS.len()]
}

// ── Shared result type ────────────────────────────────────────────────────────

#[derive(Clone)]
struct SearchHit {
    title: String,
    url: String,
    snippet: String,
}

// ── Public interface ──────────────────────────────────────────────────────────

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "web_search".into(),
            description:
                "Search the web. Returns a list of result URLs with titles and snippets."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "The search query" },
                    "num_results": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 20,
                        "default": 8,
                        "description": "Number of results to return (default 8)"
                    }
                },
                "required": ["query"]
            }),
        },
    }
}

/// Zone config shape (per-tool):
/// ```json
/// {
///   "web_search": {
///     "provider": "duckduckgo" | "searxng" | "brave" | "tavily" | "serper",
///     "endpoint": "https://...",   // SearXNG only
///     "api_key": "..."             // Brave / Tavily / Serper only
///   }
/// }
/// ```
/// Default: `"provider": "duckduckgo"` — no API key required.
/// For SearXNG, use a public instance like `https://searx.be` or your own.
pub async fn run(args: &Value, zone_config: &Value, http: &reqwest::Client) -> AppResult<String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim();
    let n = args
        .get("num_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(8)
        .clamp(1, 20) as usize;

    if query.is_empty() {
        return Ok(json!({ "error": "query parameter required" }).to_string());
    }

    let cfg = zone_config.get("web_search").cloned().unwrap_or(Value::Null);
    // Legacy configs may still say "multi" (the old DDG+Marginalia fan-out) or
    // "marginalia"; both engines are gone, so they fall back to DuckDuckGo
    // rather than erroring out on an existing user's saved zone config.
    let provider = match cfg.get("provider").and_then(|v| v.as_str()).unwrap_or("duckduckgo") {
        "multi" | "marginalia" => "duckduckgo",
        other => other,
    };
    let endpoint = cfg.get("endpoint").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = cfg.get("api_key").and_then(|v| v.as_str()).unwrap_or("");

    let hits = match provider {
        "duckduckgo" => search_duckduckgo(http, query, n).await,
        "searxng" => search_searxng(http, query, n, endpoint).await,
        "brave" => search_brave(http, query, n, api_key).await,
        "tavily" => search_tavily(http, query, n, api_key).await,
        "serper" => search_serper(http, query, n, api_key).await,
        other => {
            return Ok(json!({
                "error": format!(
                    "Unknown provider '{}'. Valid options: duckduckgo (default, no key), \
                     searxng, brave, tavily, serper.",
                    other
                )
            })
            .to_string());
        }
    };

    match hits {
        Ok(hits) if hits.is_empty() => Ok(json!({
            "query": query,
            "results": [],
            "note": "No results found."
        })
        .to_string()),
        Ok(hits) => {
            // Number each result and surface its source URL so the model can cite
            // it inline (0.4.1 inline citations). The frontend maps `[n]` markers
            // in the answer back to these sources.
            let results: Vec<Value> = hits
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    json!({ "ref": i + 1, "title": h.title, "url": h.url, "snippet": h.snippet })
                })
                .collect();
            Ok(json!({
                "query": query,
                "results": results,
                "citation_instructions": "When you use information from a result, cite it inline \
                    with its `ref` number in square brackets immediately after the claim, e.g. \
                    \"The crate is memory-safe [1].\" Combine multiple sources as [1][3]. Only cite \
                    results you actually used."
            })
            .to_string())
        }
        Err(e) => Ok(json!({ "error": format!("Search failed: {e}") }).to_string()),
    }
}

// ── DuckDuckGo Lite ───────────────────────────────────────────────────────────
//
// Uses the intentionally-simple lite.duckduckgo.com endpoint — server-rendered
// HTML, stable selectors, no JS required. POST as a form submission so it looks
// exactly like a human clicking the search button.

// NOTE: a 2.5s inter-query gate was tried here and removed -- measurement showed
// the challenge still tripping on the *second* request of a shared client at
// that spacing, so it cost latency without preventing anything. The challenge
// appears to key on the client/connection rather than on request rate: an
// ordinary browser on the same IP is unaffected, while curl and reqwest are
// both challenged. Detection below is the honest mitigation; a real fix likely
// needs cookie/session handling, or a different provider for heavy use.

async fn search_duckduckgo(
    http: &reqwest::Client,
    query: &str,
    n: usize,
) -> Result<Vec<SearchHit>, String> {
    let ua = pick_ua(query);
    // html.duckduckgo.com/html/ is server-rendered and uses stable double-underscore
    // class names (result__a, result__snippet). Do NOT set Accept-Encoding —
    // reqwest is built without gzip/brotli features.
    let resp = http
        .get("https://html.duckduckgo.com/html/")
        .header("User-Agent", ua)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.5")
        .header("Referer", "https://duckduckgo.com/")
        .query(&[("q", query), ("kl", "en-us")])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("DuckDuckGo request failed: {e}"))?;

    let status = resp.status();
    let html = resp
        .text()
        .await
        .map_err(|e| format!("DuckDuckGo read failed: {e}"))?;

    if !status.is_success() {
        return Err(format!("DuckDuckGo returned HTTP {status}"));
    }
    // DDG does not answer a throttle with 429. It returns 202 (or occasionally
    // 200) carrying an anti-bot challenge page, which `is_success()` happily
    // accepts and the parser then finds zero results in — so a rate limit used
    // to reach the model as "No results found.", i.e. a confident false
    // negative rather than a visible failure. That is the important fix here:
    // the challenge is transient and recovers on its own, but silently
    // reporting it as an empty web is a wrong answer, not merely a slow one.
    if is_ddg_challenge(status.as_u16(), &html) {
        return Err(
            "DuckDuckGo is rate-limiting this IP (anti-bot challenge, not a real \
             empty result set). It is temporary, but repeated requests while \
             blocked appear to prolong it -- do NOT retry this query. Prefer \
             reading pages you already have, or answer from what you have and \
             say that search was unavailable. This is NOT evidence that no \
             results exist for the query."
                .to_string(),
        );
    }
    warn!(
        "DDG HTML response: {} bytes, starts with: {:?}",
        html.len(),
        &html.chars().take(120).collect::<String>()
    );
    let hits = parse_ddg_html(&html, n)?;
    warn!("DDG HTML parsed {} hits", hits.len());
    Ok(hits)
}

/// Detect DDG's anti-bot challenge page.
///
/// Keyed on markers observed in a real throttled response: the body is a short
/// document (~14KB) mentioning "anomaly" and a challenge platform, served with
/// 202. Requiring a *marker* — not just the status — keeps a genuinely empty
/// result set distinguishable from a block.
fn is_ddg_challenge(status: u16, html: &str) -> bool {
    let lower = html.to_lowercase();
    let challenged = lower.contains("anomaly")
        || lower.contains("challenge-platform")
        || lower.contains("unusual traffic");
    // 202 on this endpoint is itself the throttle signal; otherwise require a
    // marker so a legitimately empty page is not misreported as a block.
    (status == 202 && challenged) || (status == 200 && challenged && !lower.contains("result__a"))
}

/// Parse html.duckduckgo.com/html/ results.
/// Title links use class `result__a`, snippets use class `result__snippet`.
/// Hrefs are DDG redirect URLs (`//duckduckgo.com/l/?uddg=...`) — decoded via decode_ddg_url.
fn parse_ddg_html(html: &str, n: usize) -> Result<Vec<SearchHit>, String> {
    let doc = Html::parse_document(html);
    let link_sel = Selector::parse("a.result__a").map_err(|e| e.to_string())?;
    let snip_sel = Selector::parse(".result__snippet").map_err(|e| e.to_string())?;

    let links: Vec<_> = doc.select(&link_sel).collect();
    let snippets: Vec<_> = doc.select(&snip_sel).collect();

    let mut hits = Vec::new();
    let mut snip_idx = 0usize;
    for link in links.iter() {
        if hits.len() >= n {
            break;
        }
        let title = link.text().collect::<String>();
        let title = title.trim().to_string();
        let href = link.value().attr("href").unwrap_or("");
        let url = decode_ddg_url(href);
        if url.is_empty() || url.contains("duckduckgo.com") || !url.starts_with("http") {
            continue;
        }
        let snippet = snippets
            .get(snip_idx)
            .map(|s| s.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        snip_idx += 1;
        hits.push(SearchHit { title, url, snippet });
    }
    Ok(hits)
}

/// DDG Lite links look like: `//duckduckgo.com/l/?uddg=https%3A%2F%2F...&rut=...`
/// Extract and percent-decode the `uddg` parameter value.
fn decode_ddg_url(href: &str) -> String {
    if let Some(pos) = href.find("uddg=") {
        let encoded = &href[pos + 5..];
        let encoded = encoded.split('&').next().unwrap_or(encoded);
        percent_decode(encoded)
    } else if href.starts_with("http") {
        href.to_string()
    } else if let Some(rest) = href.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        String::new()
    }
}

/// Minimal percent-decoder (handles the subset DDG actually uses).
fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte as char);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

// ── API-key providers (unchanged from before) ─────────────────────────────────

async fn search_searxng(
    http: &reqwest::Client,
    query: &str,
    n: usize,
    endpoint: &str,
) -> Result<Vec<SearchHit>, String> {
    if endpoint.is_empty() {
        return Err("SearXNG endpoint not configured. Use a public instance like https://searx.be or https://searx.nyc or your own self-hosted instance.".into());
    }
    let url = format!("{}/search", endpoint.trim_end_matches('/'));
    let resp = http
        .get(&url)
        .header("User-Agent", pick_ua(query))
        .header("Accept", "application/json")
        .query(&[("q", query), ("format", "json"), ("language", "en")])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("SearXNG request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "SearXNG returned HTTP {}: {}...",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }

    let text = resp.text().await.map_err(|e| format!("SearXNG read failed: {e}"))?;
    if !text.trim_start().starts_with('{') {
        return Err(format!(
            "SearXNG returned non-JSON response. The instance may be rate-limiting or not support JSON. Got: {}...",
            text.chars().take(200).collect::<String>()
        ));
    }
    let data: Value = serde_json::from_str(&text).map_err(|e| format!("SearXNG JSON parse failed: {e}"))?;
    let results = extract_from_array(data.get("results"), n, "url", "title", "content");

    // SearXNG returns HTTP 200 with an empty `results` array when its *upstream*
    // engines fail — typically because Google/Bing/etc. are rate-limiting this
    // SearXNG instance's IP (the classic "one good search, then empties for a
    // while" pattern). The reason is in `unresponsive_engines`; surface it so the
    // caller sees an actionable error instead of a silent "no results".
    if results.is_empty() {
        if let Some(unresp) = data.get("unresponsive_engines").and_then(|v| v.as_array()) {
            if !unresp.is_empty() {
                let reasons: Vec<String> = unresp
                    .iter()
                    .filter_map(|e| {
                        let arr = e.as_array()?;
                        let engine = arr.first()?.as_str()?;
                        let reason = arr.get(1).and_then(|v| v.as_str()).unwrap_or("no reason given");
                        Some(format!("{engine} ({reason})"))
                    })
                    .collect();
                if !reasons.is_empty() {
                    return Err(format!(
                        "SearXNG returned no results because its upstream engines did not \
                         respond: {}. This almost always means those engines are rate-limiting \
                         your instance's IP — not SearXNG limiting you. Wait a minute, enable \
                         more/different engines in SearXNG, or switch to the 'duckduckgo' provider, which \
                         queries DuckDuckGo directly.",
                        reasons.join(", ")
                    ));
                }
            }
        }
    }
    Ok(results)
}

async fn search_brave(
    http: &reqwest::Client,
    query: &str,
    n: usize,
    api_key: &str,
) -> Result<Vec<SearchHit>, String> {
    if api_key.is_empty() {
        return Err("Brave API key not configured (set api_key in tool_config)".into());
    }
    let resp = http
        .get("https://api.search.brave.com/res/v1/web/search")
        .header("X-Subscription-Token", api_key)
        .header("Accept", "application/json")
        .query(&[("q", query), ("count", &n.to_string())])
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = data.get("web").and_then(|w| w.get("results"));
    Ok(extract_from_array(arr, n, "url", "title", "description"))
}

async fn search_tavily(
    http: &reqwest::Client,
    query: &str,
    n: usize,
    api_key: &str,
) -> Result<Vec<SearchHit>, String> {
    if api_key.is_empty() {
        return Err("Tavily API key not configured (set api_key in tool_config)".into());
    }
    let resp = http
        .post("https://api.tavily.com/search")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&json!({ "query": query, "max_results": n, "include_answer": false }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(extract_from_array(data.get("results"), n, "url", "title", "content"))
}

async fn search_serper(
    http: &reqwest::Client,
    query: &str,
    n: usize,
    api_key: &str,
) -> Result<Vec<SearchHit>, String> {
    if api_key.is_empty() {
        return Err("Serper API key not configured (set api_key in tool_config)".into());
    }
    let resp = http
        .post("https://google.serper.dev/search")
        .header("X-API-KEY", api_key)
        .json(&json!({ "q": query, "num": n }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(extract_from_array(data.get("organic"), n, "link", "title", "snippet"))
}

// ── Helper ────────────────────────────────────────────────────────────────────

fn extract_from_array(
    arr: Option<&Value>,
    n: usize,
    url_field: &str,
    title_field: &str,
    snippet_field: &str,
) -> Vec<SearchHit> {
    let Some(arr) = arr.and_then(|v| v.as_array()) else {
        return vec![];
    };
    arr.iter()
        .take(n)
        .filter_map(|r| {
            let url = r.get(url_field).and_then(|v| v.as_str())?;
            if url.is_empty() {
                return None;
            }
            Some(SearchHit {
                url: url.to_string(),
                title: r
                    .get(title_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                snippet: r
                    .get(snippet_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}
