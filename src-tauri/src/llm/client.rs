use crate::error::{AppError, AppResult};
use crate::llm::types::*;
use reqwest::Client;

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

    pub async fn chat_stream(
        &self,
        req: &ChatRequest,
    ) -> AppResult<reqwest::Response> {
        let http_req = self.http.post(self.url("/chat/completions")).json(req);
        let res = self.auth(http_req).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(AppError::Provider(format!("chat/completions {status}: {body}")));
        }
        Ok(res)
    }
}
