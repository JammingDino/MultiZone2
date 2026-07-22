//! `smart_fetch` — read one or more web pages or PDFs in full as clean markdown.
//!
//! Hound-based searching tool: <https://github.com/dondai1234/master-fetch>.
//! This is the HTTP-first half of Hound's `smart_fetch`, minus the stealth
//! browser escalation: pure-Rust retrieval + extraction. It reads HTML and PDF,
//! optionally reranks a long page against a relevance query, and — because there
//! is no headless browser to run JavaScript or clear an interactive bot
//! challenge — reports those cases honestly instead of returning a blank page.
//!
//! It supersedes the older `extract_url`: same clean-markdown output and
//! per-URL relevance trimming, but adds PDF support and human-readable failure
//! reasons for blocked / not-found / rate-limited responses.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use crate::tools::web_util::fetch_and_render;
use serde_json::{json, Value};

const DEFAULT_MAX_CHARS: usize = 8000;
const HARD_MAX_CHARS: usize = 40000;
const MAX_URLS: usize = 10;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "smart_fetch".into(),
            description: "Fetch one or more web pages or PDFs and return their clean main text as \
                lightweight markdown, with navigation, scripts, and boilerplate removed. Handles \
                both HTML pages and PDF documents. Use it after smart_search to read a promising \
                result in full, or whenever the user gives you a URL. An optional `query` trims a \
                long page to its most relevant parts. Note: this is an HTTP-only reader with no \
                headless browser, so pages that render entirely via JavaScript, or that sit behind \
                an interactive bot challenge, are reported as such rather than returned blank."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "urls": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "One or more absolute http(s) URLs to read (max 10). A single URL may also be passed in `url`."
                    },
                    "url": {
                        "type": "string",
                        "description": "Convenience single-URL form; ignored when `urls` is provided."
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional. Reranks the extracted content by relevance to this query, dropping the least-relevant parts first if the page exceeds max_chars."
                    },
                    "max_chars": {
                        "type": "integer",
                        "minimum": 500,
                        "maximum": HARD_MAX_CHARS,
                        "default": DEFAULT_MAX_CHARS,
                        "description": "Per-URL character budget for the returned text (default 8000)."
                    },
                    "include_images": {
                        "type": "boolean",
                        "default": false,
                        "description": "When true, also return a list of the page's image URLs (absolute). HTML pages only."
                    }
                },
                "required": []
            }),
        },
    }
}

pub async fn run(args: &Value) -> AppResult<String> {
    // Accept `urls: [...]` or a single `url: "..."`.
    let mut urls: Vec<String> = args
        .get("urls")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .collect()
        })
        .unwrap_or_default();
    if urls.is_empty() {
        if let Some(u) = args.get("url").and_then(|v| v.as_str()) {
            let u = u.trim();
            if !u.is_empty() {
                urls.push(u.to_string());
            }
        }
    }
    urls.retain(|u| u.starts_with("http://") || u.starts_with("https://"));
    urls.truncate(MAX_URLS);

    if urls.is_empty() {
        return Ok(json!({
            "error": "No valid URL supplied. Pass `urls` (array) or `url` (string) with absolute http(s) links."
        })
        .to_string());
    }

    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let max_chars = args
        .get("max_chars")
        .and_then(|v| v.as_u64())
        .map(|n| (n as usize).clamp(500, HARD_MAX_CHARS))
        .unwrap_or(DEFAULT_MAX_CHARS);
    let include_images = args.get("include_images").and_then(|v| v.as_bool()).unwrap_or(false);

    // Fetch all URLs concurrently (all share the one emulated client).
    let futures = urls.iter().enumerate().map(|(i, url)| {
        let url = url.clone();
        let query = query.clone();
        async move {
            let out = fetch_and_render(&url, query.as_deref(), max_chars, include_images, false).await;
            (i, url, out)
        }
    });
    let mut results = futures_util::future::join_all(futures).await;
    results.sort_by_key(|(i, _, _)| *i);

    let pages: Vec<Value> = results
        .into_iter()
        .map(|(i, url, out)| match out {
            Ok(page) => {
                let mut obj = json!({
                    "ref": i + 1,
                    "url": url,
                    "type": page.kind,
                    "title": page.title,
                    "content": page.content,
                    "truncated": page.truncated,
                });
                if include_images {
                    obj["images"] = json!(page.images);
                }
                obj
            }
            Err(e) => json!({ "ref": i + 1, "url": url, "error": e }),
        })
        .collect();

    Ok(json!({
        "results": pages,
        "citation_instructions": "When you use information from a page, cite it inline with its \
            `ref` number in square brackets immediately after the claim, e.g. \"The API is \
            rate-limited [1].\" Only cite pages you actually used."
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live smoke test — reads a real page through the emulated client.
    /// Run with: cargo test --lib smart_fetch::tests::live_fetch -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the live network"]
    async fn live_fetch() {
        let args = json!({ "url": "https://example.com", "max_chars": 2000 });
        let out = run(&args).await.unwrap();
        println!("{out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        let page = &v["results"][0];
        assert!(page.get("error").is_none(), "fetch errored: {page}");
        assert!(page["content"].as_str().unwrap().to_lowercase().contains("example"));
    }
}
