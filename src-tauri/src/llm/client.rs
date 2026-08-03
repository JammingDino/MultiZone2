use crate::error::{AppError, AppResult};
use crate::llm::types::*;
use reqwest::Client;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// Base URLs that rejected `stream_options`. Asking for token counts is not
/// worth a failed turn, but neither is paying a wasted round trip on every
/// single request to a provider that has already said no once.
fn no_stream_options() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

pub struct LlmClient<'a> {
    pub http: &'a Client,
    pub base_url: String,
    pub api_key: Option<String>,
}

impl<'a> LlmClient<'a> {
    pub fn new(http: &'a Client, base_url: &str, api_key: Option<&str>) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.map(|s| s.to_string()),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
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

    pub async fn chat_completion(&self, req: &ChatRequest) -> AppResult<ChatResponse> {
        let http_req = self.http.post(self.url("/chat/completions")).json(req);
        let res = self.auth(http_req).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(AppError::Provider(format!("chat/completions {status}: {body}")));
        }
        let resp: ChatResponse = res.json().await?;
        Ok(resp)
    }

    /// Stream a completion, asking the provider to report its own token counts.
    ///
    /// `stream_options.include_usage` is an OpenAI field that most compatible
    /// servers honour and a few reject outright. Those counts are the only exact
    /// token figures available — everything else in the app is a character-based
    /// estimate — so it is worth one wasted round trip to find out, once, which
    /// kind of provider this is. After that the answer is remembered and the
    /// field is simply omitted.
    pub async fn chat_stream(&self, req: &ChatRequest) -> AppResult<reqwest::Response> {
        let refused = no_stream_options()
            .lock()
            .map(|s| s.contains(&self.base_url))
            .unwrap_or(false);

        if !refused && req.stream_options.is_some() {
            match self.post_stream(req).await {
                Ok(res) => return Ok(res),
                // Only an "I don't understand this request" answer is evidence
                // about the field. A bad key, a rate limit or a provider outage
                // says nothing about `stream_options`, and retrying those would
                // double every failure and then blame the wrong thing.
                Err((status, e)) if !rejects_the_request(status) => return Err(e),
                Err((_, e)) => {
                    tracing::debug!(
                        "{} refused stream_options ({e}); retrying without usage reporting",
                        self.base_url,
                    );
                    if let Ok(mut set) = no_stream_options().lock() {
                        set.insert(self.base_url.clone());
                    }
                }
            }
        }

        let plain = ChatRequest { stream_options: None, ..req.clone() };
        self.post_stream(&plain).await.map_err(|(_, e)| e)
    }

    /// The response status, alongside the error, so the caller can tell an
    /// unusable request apart from an unusable provider.
    async fn post_stream(
        &self,
        req: &ChatRequest,
    ) -> Result<reqwest::Response, (Option<reqwest::StatusCode>, AppError)> {
        let http_req = self.http.post(self.url("/chat/completions")).json(req);
        let res = self.auth(http_req).send().await.map_err(|e| (None, AppError::from(e)))?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err((
                Some(status),
                AppError::Provider(format!("chat/completions {status}: {body}")),
            ));
        }
        Ok(res)
    }
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
