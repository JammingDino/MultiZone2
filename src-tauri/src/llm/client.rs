use crate::error::{AppError, AppResult};
use crate::llm::responses::{self, Dialect};
use crate::llm::types::*;
use reqwest::Client;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// (base URL, model) pairs that rejected the thinking fields
/// (`reasoning_effort` / `chat_template_kwargs`). The profile in
/// `llm::thinking` is a guess from the model's name; a provider that says no
/// is believed, once, and not asked again.
fn no_thinking_controls() -> &'static Mutex<HashSet<(String, String)>> {
    static SET: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Base URLs that rejected `stream_options`. Asking for token counts is not
/// worth a failed turn, but neither is paying a wasted round trip on every
/// single request to a provider that has already said no once.
fn no_stream_options() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

// ---------------------------------------------------------------------------
// Backoff and retry (0.14.1, revised 0.18)
// ---------------------------------------------------------------------------
//
// Until 0.14.1 there was no 429 path at all: a rate limit came back as a
// provider error and ended the turn. One chat rarely meets a rate limit; a
// seven-member panel meets it constantly, and every member hitting the same
// provider in the same second is exactly the pattern that triggers one.
// Retrying immediately — all seven at once — is how a brief limit becomes a
// sustained one. So: exponential backoff with full jitter.
//
// There used to be a per-provider cooldown on top of that, which refused to
// even send after three failures in a minute. Wrong shape: a user watching a
// transient blip was locked out of their own app for thirty seconds by a
// message about backing off. Retrying is the app's job; giving up is the
// user's call. So the cooldown is gone, the retry budget is generous, and
// every wait is reported to the UI with a stop button already attached.

/// Attempts after the first, for one request.
const MAX_RETRIES: u32 = 10;
/// First backoff. Doubles each attempt, before jitter.
const BASE_BACKOFF_MS: u64 = 500;
/// Ceiling for a single wait. Long enough to let a busy provider recover,
/// short enough that the countdown on screen keeps moving.
const MAX_BACKOFF_MS: u64 = 8_000;
/// The provider's own `Retry-After` is honoured up to here. Beyond it, waiting
/// is worse than failing with a message the user can act on.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(20);

/// Called once a second while a retry waits: attempt, budget, seconds left.
/// Returning `false` abandons the retry — this is the turn's stop button
/// reaching in here.
pub type RetryHook<'h> = &'h (dyn Fn(u32, u32, u64) -> bool + Send + Sync);

/// Wait before attempt `attempt` (1-based), given a jitter factor in `[0, 1)`.
///
/// Full jitter, not "exponential ± a bit": the point is to *spread* a panel's
/// retries, and seven agents that all wait 1s ± 10% arrive together again. The
/// jitter is a parameter so the arithmetic can be tested without a clock or a
/// random source.
fn backoff_delay(attempt: u32, jitter: f64) -> Duration {
    let exp = BASE_BACKOFF_MS.saturating_mul(1u64 << attempt.min(16).saturating_sub(1));
    let capped = exp.min(MAX_BACKOFF_MS);
    // Never zero — a "retry" that waits no time at all is just a second
    // simultaneous request.
    let ms = (capped as f64 * (0.25 + 0.75 * jitter.clamp(0.0, 1.0))) as u64;
    Duration::from_millis(ms.max(50))
}

/// A cheap jitter source. No `rand` in the tree, and spreading retries needs
/// unpredictability of milliseconds, not cryptographic quality.
fn jitter() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos % 1_000) as f64 / 1_000.0
}

/// Is this worth trying again? A 429 or a 5xx is the provider saying "not now";
/// a transport failure (`None`) is a socket that never got an answer. Everything
/// else — a bad key, an unknown model, a malformed request — will fail
/// identically the second time and retrying only delays the message that says so.
fn is_transient(status: Option<reqwest::StatusCode>) -> bool {
    match status {
        None => true,
        Some(s) => s.as_u16() == 429 || s.is_server_error(),
    }
}

/// `Retry-After`, in seconds, clamped. Providers that answer a 429 with one are
/// telling us the actual answer; guessing when we have been told is rude and
/// usually wrong in the expensive direction.
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let secs: u64 = raw.trim().parse().ok()?;
    Some(Duration::from_secs(secs).min(MAX_RETRY_AFTER))
}

/// Sleep out a backoff, telling `on_retry` how long is left once a second and
/// stopping early if it says to. A second's granularity keeps the event stream
/// quiet and still answers a stop button faster than anyone can notice.
async fn wait_out(delay: Duration, attempt: u32, on_retry: RetryHook<'_>) -> bool {
    let tick = Duration::from_secs(1);
    let mut left = delay;
    loop {
        // Round up: "0s left" for the last 900ms reads as a stall.
        let secs = (left.as_millis() as u64).div_ceil(1_000);
        if !on_retry(attempt, MAX_RETRIES, secs) {
            return false;
        }
        if left.is_zero() {
            return true;
        }
        let step = tick.min(left);
        tokio::time::sleep(step).await;
        left -= step;
    }
}

pub struct LlmClient<'a> {
    pub http: &'a Client,
    pub base_url: String,
    pub api_key: Option<String>,
    /// The conversation this client speaks for, sent as `x-opencode-session`.
    ///
    /// opencode's Go gateway refuses a request without it (400 MissingSessionID)
    /// because it routes and caches per conversation. Other OpenAI-compatible
    /// providers ignore an unknown header, so it goes out unconditionally rather
    /// than being guessed at from the base URL.
    pub session: String,
}

/// The fallback session id for work that belongs to no chat — listing models,
/// embedding a document. Stable for the life of the process, which is the most
/// a sessionless request can honestly claim.
fn process_session() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| format!("multizone-{}", uuid::Uuid::new_v4()))
}

impl<'a> LlmClient<'a> {
    pub fn new(http: &'a Client, base_url: &str, api_key: Option<&str>) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.map(|s| s.to_string()),
            session: process_session().to_string(),
        }
    }

    /// Tie this client to a chat, so every request it sends carries that chat's
    /// id as its session. Chat ids are already stable and unique per
    /// conversation, which is exactly what the header wants.
    pub fn for_chat(mut self, chat_id: &str) -> Self {
        if !chat_id.is_empty() {
            self.session = chat_id.to_string();
        }
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let req = req.header("x-opencode-session", &self.session);
        if let Some(key) = &self.api_key {
            if !key.is_empty() {
                return req.bearer_auth(key);
            }
        }
        req
    }

    pub async fn list_models(&self) -> AppResult<Vec<String>> {
        let req = self.http.get(self.url("/models"));
        let res = self.auth(req).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(AppError::Provider(format!("models endpoint {status}: {body}")));
        }
        let list: ModelList = res.json().await?;
        let mut ids: Vec<String> = list.data.into_iter().map(|m| m.id).collect();
        ids.sort();
        Ok(ids)
    }

    /// Embed a batch of input strings via the OpenAI-compatible `/embeddings`
    /// endpoint. Returns one vector per input, in request order. Works against
    /// OpenAI (`text-embedding-3-*`), Ollama's `/v1/embeddings`
    /// (`nomic-embed-text`, etc.), and any other compatible provider — an
    /// embedding model is just a model id on a normal provider.
    pub async fn embed(&self, model: &str, inputs: &[String]) -> AppResult<Vec<Vec<f32>>> {
        #[derive(serde::Serialize)]
        struct EmbeddingRequest<'a> {
            model: &'a str,
            input: &'a [String],
        }
        #[derive(serde::Deserialize)]
        struct EmbeddingData {
            embedding: Vec<f32>,
            #[serde(default)]
            index: usize,
        }
        #[derive(serde::Deserialize)]
        struct EmbeddingResponse {
            data: Vec<EmbeddingData>,
        }

        let body = EmbeddingRequest { model, input: inputs };
        let http_req = self.http.post(self.url("/embeddings")).json(&body);
        let res = self.auth(http_req).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(AppError::Provider(format!("embeddings {status}: {text}")));
        }
        let mut resp: EmbeddingResponse = res.json().await?;
        // Providers should return embeddings in input order, but sort by the
        // echoed index defensively so chunk N always maps to vector N.
        resp.data.sort_by_key(|d| d.index);
        Ok(resp.data.into_iter().map(|d| d.embedding).collect())
    }

    /// Which endpoint this model is served on here. Almost always chat
    /// completions; see `llm::responses` for the exceptions and why.
    pub fn dialect(&self, model: &str) -> Dialect {
        responses::dialect_for(model, &self.base_url)
    }

    /// The request as it goes on the wire: the endpoint path and the body.
    fn wire(&self, req: &ChatRequest) -> (&'static str, serde_json::Value) {
        match self.dialect(&req.model) {
            Dialect::ChatCompletions => (
                "/chat/completions",
                serde_json::to_value(req).unwrap_or(serde_json::Value::Null),
            ),
            Dialect::Responses => ("/responses", responses::request(req)),
        }
    }

    pub async fn chat_completion(&self, req: &ChatRequest) -> AppResult<ChatResponse> {
        let (path, body) = self.wire(req);
        let http_req = self.http.post(self.url(path)).json(&body);
        let res = self.auth(http_req).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(AppError::Provider(format!("{} {status}: {body}", &path[1..])));
        }
        match self.dialect(&req.model) {
            Dialect::ChatCompletions => Ok(res.json().await?),
            Dialect::Responses => {
                let v: serde_json::Value = res.json().await?;
                Ok(responses::response(&v))
            }
        }
    }

    /// Stream a completion, asking the provider to report its own token counts.
    ///
    /// `stream_options.include_usage` is an OpenAI field that most compatible
    /// servers honour and a few reject outright. Those counts are the only exact
    /// token figures available — everything else in the app is a character-based
    /// estimate — so it is worth one wasted round trip to find out, once, which
    /// kind of provider this is. After that the answer is remembered and the
    /// field is simply omitted.
    /// Send it, and try again if the provider was merely busy (0.14.1).
    ///
    /// Retries happen here, before a single byte has been streamed, which is the
    /// only place they are safe: once tokens have reached the transcript a retry
    /// would duplicate them.
    pub async fn chat_stream(
        &self,
        req: &ChatRequest,
        on_retry: RetryHook<'_>,
    ) -> AppResult<LlmStream> {
        let mut attempt = 0;
        loop {
            match self.chat_stream_once(req).await {
                Ok(res) => {
                    return Ok(LlmStream { response: res, dialect: self.dialect(&req.model) });
                }
                Err((status, wait, e)) => {
                    // Not the provider's health — a bad key, an unknown model, a
                    // malformed body. It will fail identically next time, and
                    // retrying only delays the message that says so.
                    if !is_transient(status) {
                        return Err(e);
                    }
                    attempt += 1;
                    if attempt > MAX_RETRIES {
                        return Err(e);
                    }
                    let delay = wait.unwrap_or_else(|| backoff_delay(attempt, jitter()));
                    tracing::debug!(
                        "{} returned {:?}; retry {attempt}/{MAX_RETRIES} in {}ms",
                        self.base_url,
                        status.map(|s| s.as_u16()),
                        delay.as_millis(),
                    );
                    if !wait_out(delay, attempt, on_retry).await {
                        return Err(e);
                    }
                }
            }
        }
    }

    /// One attempt, including the optional-field probes and their fallbacks.
    ///
    /// Two optional shapes ride on a request — `stream_options` and the
    /// thinking fields (0.17.9) — and a provider that rejects one says so with
    /// the same 400 it uses for the other. When the body names a field, that
    /// one is blamed; otherwise `stream_options` is dropped first (the more
    /// commonly refused of the two), then the thinking fields. Each refusal is
    /// remembered so the wasted round trip happens once per provider (and, for
    /// thinking, per model: the same gateway serves models that do and do not
    /// take `reasoning_effort`).
    async fn chat_stream_once(
        &self,
        req: &ChatRequest,
    ) -> Result<reqwest::Response, (Option<reqwest::StatusCode>, Option<Duration>, AppError)> {
        let key = (self.base_url.clone(), req.model.clone());
        let mut req = req.clone();
        // The Responses body has no `stream_options`; usage rides on the
        // final event unasked. Dropping the field keeps the probe below from
        // blaming it for a rejection it could not have caused.
        if self.dialect(&req.model) == Dialect::Responses
            || no_stream_options().lock().map(|s| s.contains(&self.base_url)).unwrap_or(false)
        {
            req.stream_options = None;
        }
        if no_thinking_controls().lock().map(|s| s.contains(&key)).unwrap_or(false) {
            req.reasoning_effort = None;
            req.chat_template_kwargs = None;
        }

        loop {
            let has_usage = req.stream_options.is_some();
            let has_thinking = req.reasoning_effort.is_some() || req.chat_template_kwargs.is_some();
            match self.post_stream(&req).await {
                Ok(res) => return Ok(res),
                // Only an "I don't understand this request" answer is evidence
                // about a field. A bad key, a rate limit or a provider outage
                // says nothing about them, and retrying those would double
                // every failure and then blame the wrong thing.
                Err(e) if !rejects_the_request(e.0) => return Err(e),
                Err(e) if !has_usage && !has_thinking => return Err(e),
                Err(e) => {
                    let body = e.2.to_string();
                    let blame_thinking = has_thinking
                        && (!has_usage || crate::llm::thinking::rejection_names_thinking(&body));
                    if blame_thinking {
                        tracing::debug!(
                            "{} refused thinking fields for {} ({body}); retrying without",
                            self.base_url,
                            req.model,
                        );
                        if let Ok(mut set) = no_thinking_controls().lock() {
                            set.insert(key.clone());
                        }
                        req.reasoning_effort = None;
                        req.chat_template_kwargs = None;
                    } else {
                        tracing::debug!(
                            "{} refused stream_options ({body}); retrying without usage reporting",
                            self.base_url,
                        );
                        if let Ok(mut set) = no_stream_options().lock() {
                            set.insert(self.base_url.clone());
                        }
                        req.stream_options = None;
                    }
                }
            }
        }
    }

    /// The response status and any `Retry-After`, alongside the error, so the
    /// caller can tell an unusable request apart from a busy provider.
    async fn post_stream(
        &self,
        req: &ChatRequest,
    ) -> Result<reqwest::Response, (Option<reqwest::StatusCode>, Option<Duration>, AppError)> {
        let (path, body) = self.wire(req);
        let http_req = self.http.post(self.url(path)).json(&body);
        let res = self
            .auth(http_req)
            .send()
            .await
            .map_err(|e| (None, None, AppError::from(e)))?;
        if !res.status().is_success() {
            let status = res.status();
            let wait = retry_after(res.headers());
            let body = res.text().await.unwrap_or_default();
            return Err((
                Some(status),
                wait,
                AppError::Provider(format!("{} {status}: {body}", &path[1..])),
            ));
        }
        Ok(res)
    }
}

/// An open streaming reply and the protocol it speaks, so the consumer can
/// read it without asking the client again.
pub struct LlmStream {
    pub response: reqwest::Response,
    pub dialect: Dialect,
}

/// Did the provider reject the request itself, as opposed to failing to serve
/// it? 400 and 422 are how OpenAI-compatible servers report an unrecognised
/// field; 404 covers the shims that route on the request body and can't find a
/// handler for one carrying an option they don't implement.
fn rejects_the_request(status: Option<reqwest::StatusCode>) -> bool {
    matches!(
        status.map(|s| s.as_u16()),
        Some(400) | Some(404) | Some(422)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;
    use std::time::Instant;

    fn code(n: u16) -> Option<StatusCode> {
        Some(StatusCode::from_u16(n).unwrap())
    }

    #[test]
    fn a_busy_provider_is_retried_and_a_broken_request_is_not() {
        assert!(is_transient(code(429)), "rate limit");
        assert!(is_transient(code(500)));
        assert!(is_transient(code(503)));
        assert!(is_transient(None), "a socket that never answered");

        // These fail identically the second time; retrying only delays the
        // message that explains them.
        assert!(!is_transient(code(401)), "a bad key");
        assert!(!is_transient(code(404)), "a model that does not exist");
        assert!(!is_transient(code(400)));
    }

    #[test]
    fn backoff_doubles_and_is_capped() {
        // Same jitter throughout, so this measures the curve rather than luck.
        let at = |n| backoff_delay(n, 1.0).as_millis();
        assert_eq!(at(1), BASE_BACKOFF_MS as u128);
        assert_eq!(at(2), (BASE_BACKOFF_MS * 2) as u128);
        assert_eq!(at(3), (BASE_BACKOFF_MS * 4) as u128);
        assert_eq!(at(20), MAX_BACKOFF_MS as u128, "capped, and no overflow");
    }

    /// The reason jitter is here at all: seven panel members that all wait the
    /// same 1s arrive together and trigger the same limit again.
    #[test]
    fn jitter_spreads_retries_without_ever_waiting_nothing() {
        let low = backoff_delay(3, 0.0);
        let high = backoff_delay(3, 0.999);
        assert!(low < high, "{low:?} !< {high:?}");
        assert!(low.as_millis() >= 50, "a retry that waits no time is a second request");
    }

    #[test]
    fn retry_after_is_read_and_clamped() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(reqwest::header::RETRY_AFTER, "7".parse().unwrap());
        assert_eq!(retry_after(&h), Some(Duration::from_secs(7)));

        // A provider asking for ten minutes is telling us to fail instead.
        h.insert(reqwest::header::RETRY_AFTER, "600".parse().unwrap());
        assert_eq!(retry_after(&h), Some(MAX_RETRY_AFTER));

        // An HTTP-date form is valid per the RFC and not understood here; the
        // fallback is the ordinary backoff, not a panic.
        h.insert(reqwest::header::RETRY_AFTER, "Wed, 21 Oct 2026 07:28:00 GMT".parse().unwrap());
        assert_eq!(retry_after(&h), None);
    }

    /// The stop button, from the inside: a hook that says no ends the wait
    /// instead of sleeping out the full backoff.
    #[tokio::test]
    async fn a_refusing_hook_abandons_the_wait() {
        let seen = std::sync::Mutex::new(Vec::new());
        let start = Instant::now();
        let kept = wait_out(Duration::from_secs(8), 2, &|attempt, max, left| {
            seen.lock().unwrap().push((attempt, max, left));
            false
        })
        .await;
        assert!(!kept, "the hook said stop");
        assert_eq!(*seen.lock().unwrap(), vec![(2, MAX_RETRIES, 8)]);
        assert!(start.elapsed() < Duration::from_secs(1), "and it did not sleep");
    }

    #[tokio::test]
    async fn a_wait_counts_down_to_zero() {
        let seen = std::sync::Mutex::new(Vec::new());
        let kept = wait_out(Duration::from_millis(1_200), 1, &|_, _, left| {
            seen.lock().unwrap().push(left);
            true
        })
        .await;
        assert!(kept);
        assert_eq!(*seen.lock().unwrap(), vec![2, 1, 0], "rounded up, ending at zero");
    }
}
