//! URL content extraction — the read-the-full-page complement to `web_search`.
//!
//! Where `web_search` returns result *snippets*, `extract` fetches one or more
//! URLs in full and returns clean, readable text (light markdown) with the page
//! chrome — nav, scripts, styles, headers/footers — stripped out. This closes
//! the research loop: the model can search, pick promising URLs, then read them.
//!
//! Pure-Rust, no headless browser (consistent with the project's
//! native-dependency-avoidance stance). Server-rendered HTML extracts cleanly;
//! JS-only pages return whatever static markup they ship. An optional `query`
//! reranks the extracted paragraphs by keyword overlap so a long page can be
//! trimmed to the parts that actually matter, and `include_images` opts into a
//! list of the page's image URLs.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use scraper::{ElementRef, Html, Selector};
use serde_json::{json, Value};

const DEFAULT_MAX_CHARS: usize = 8000;
const HARD_MAX_CHARS: usize = 40000;
/// Cap concurrent fetches so a big `urls` list can't open dozens of sockets.
const MAX_URLS: usize = 10;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "extract_url".into(),
            description: "Read the full content of one or more web pages. Unlike web_search \
                (which returns short snippets), this fetches each URL and returns its clean main \
                text as lightweight markdown, with navigation, scripts, and boilerplate removed. \
                Use it after web_search to read a promising result in full, or whenever the user \
                gives you a URL to read. Note: pages that render entirely via JavaScript may \
                return little text (no headless browser)."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "urls": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "One or more absolute http(s) URLs to read (max 10). A single URL may also be passed as a string in `url`."
                    },
                    "url": {
                        "type": "string",
                        "description": "Convenience single-URL form; ignored when `urls` is provided."
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional. When set, the extracted paragraphs are reranked by relevance to this query and the least-relevant ones dropped first if the page exceeds max_chars — use it to focus a long page on what you need."
                    },
                    "max_chars": {
                        "type": "integer",
                        "minimum": 500,
                        "maximum": HARD_MAX_CHARS,
                        "default": DEFAULT_MAX_CHARS,
                        "description": "Per-URL character budget for the returned text (default 8000). Content beyond the budget is truncated."
                    },
                    "include_images": {
                        "type": "boolean",
                        "default": false,
                        "description": "When true, also return a list of the page's image URLs (absolute)."
                    }
                },
                "required": []
            }),
        },
    }
}

pub async fn run(args: &Value, http: &reqwest::Client) -> AppResult<String> {
    // Accept either `urls: [...]` or a single `url: "..."`.
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

    let query = args.get("query").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let max_chars = args
        .get("max_chars")
        .and_then(|v| v.as_u64())
        .map(|n| (n as usize).clamp(500, HARD_MAX_CHARS))
        .unwrap_or(DEFAULT_MAX_CHARS);
    let include_images = args.get("include_images").and_then(|v| v.as_bool()).unwrap_or(false);

    // Fetch all URLs concurrently.
    let futures = urls.iter().enumerate().map(|(i, url)| {
        let http = http.clone();
        let url = url.clone();
        let query = query.clone();
        async move {
            let out = fetch_one(&http, &url, query.as_deref(), max_chars, include_images).await;
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
                    "title": page.title,
                    "content": page.content,
                    "truncated": page.truncated,
                });
                if let Some(imgs) = page.images {
                    obj["images"] = json!(imgs);
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

struct Page {
    title: String,
    content: String,
    truncated: bool,
    images: Option<Vec<String>>,
}

async fn fetch_one(
    http: &reqwest::Client,
    url: &str,
    query: Option<&str>,
    max_chars: usize,
    include_images: bool,
) -> Result<Page, String> {
    let resp = http
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.5")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    // Guard against binary payloads (PDFs, images) — this tool reads HTML.
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !content_type.is_empty()
        && !content_type.contains("html")
        && !content_type.contains("text/plain")
        && !content_type.contains("xml")
    {
        return Err(format!(
            "unsupported content-type '{content_type}' — extract reads HTML/text pages only"
        ));
    }

    let html = resp.text().await.map_err(|e| format!("read failed: {e}"))?;

    // Parsing touches a non-Send scraper type, so keep it out of the await path.
    let (title, mut paragraphs, images) = parse_html(&html, url, include_images);

    // Optional relevance rerank: order paragraphs by keyword overlap with the
    // query so truncation drops the least-relevant content first. The original
    // reading order is otherwise preserved.
    if let Some(q) = query {
        let terms: Vec<String> = q
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.len() >= 3)
            .map(|t| t.to_string())
            .collect();
        if !terms.is_empty() {
            let mut scored: Vec<(usize, i64, &Para)> = paragraphs
                .iter()
                .enumerate()
                .map(|(idx, p)| (idx, score_paragraph(&p.text, &terms), p))
                .collect();
            // Highest score first; ties keep document order.
            scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            paragraphs = scored.into_iter().map(|(_, _, p)| p.clone()).collect();
        }
    }

    let mut content = String::new();
    let mut truncated = false;
    for p in &paragraphs {
        if content.len() + p.rendered.len() + 2 > max_chars {
            truncated = true;
            break;
        }
        if !content.is_empty() {
            content.push_str("\n\n");
        }
        content.push_str(&p.rendered);
    }
    if content.is_empty() {
        content = "(no readable text extracted — the page may render its content with JavaScript)".to_string();
    }

    Ok(Page {
        title,
        content,
        truncated,
        images: if include_images { Some(images) } else { None },
    })
}

#[derive(Clone)]
struct Para {
    /// Plain text (used for relevance scoring).
    text: String,
    /// Markdown-rendered form (used for output).
    rendered: String,
}

fn score_paragraph(text: &str, terms: &[String]) -> i64 {
    let lower = text.to_lowercase();
    terms.iter().map(|t| lower.matches(t.as_str()).count() as i64).sum()
}

/// Walk the page's main content, emitting block-level elements as lightweight
/// markdown paragraphs. Chrome (nav/header/footer/aside/script/style/forms) is
/// dropped. Returns (title, paragraphs, image_urls).
fn parse_html(html: &str, base_url: &str, include_images: bool) -> (String, Vec<Para>, Vec<String>) {
    let doc = Html::parse_document(html);

    let title = Selector::parse("title")
        .ok()
        .and_then(|sel| doc.select(&sel).next())
        .map(|t| collapse_ws(&t.text().collect::<String>()))
        .unwrap_or_default();

    // Prefer a semantic content root so we skip site chrome entirely; fall back
    // to <body>, then the whole document.
    let root = ["main", "article", "body"]
        .iter()
        .find_map(|s| Selector::parse(s).ok().and_then(|sel| doc.select(&sel).next()))
        .unwrap_or_else(|| doc.root_element());

    let block_sel =
        Selector::parse("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre").expect("valid selector");

    let mut paragraphs: Vec<Para> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for el in root.select(&block_sel) {
        if is_in_chrome(&el) {
            continue;
        }
        let text = collapse_ws(&el.text().collect::<String>());
        if text.len() < 2 {
            continue;
        }
        // Skip nested duplicates (e.g. a <p> inside a <li> we already captured).
        if !seen.insert(text.clone()) {
            continue;
        }
        let rendered = render_block(el.value().name(), &text);
        paragraphs.push(Para { text, rendered });
    }

    let images = if include_images {
        collect_images(&doc, base_url)
    } else {
        Vec::new()
    };

    (title, paragraphs, images)
}

/// True when the element sits inside page chrome we don't want to read.
fn is_in_chrome(el: &ElementRef) -> bool {
    let mut cur = Some(*el);
    while let Some(node) = cur {
        match node.value().name() {
            "nav" | "header" | "footer" | "aside" | "form" | "script" | "style" | "noscript"
            | "template" | "svg" | "button" => return true,
            _ => {}
        }
        cur = node
            .parent()
            .and_then(ElementRef::wrap);
    }
    false
}

fn render_block(tag: &str, text: &str) -> String {
    match tag {
        "h1" => format!("# {text}"),
        "h2" => format!("## {text}"),
        "h3" => format!("### {text}"),
        "h4" | "h5" | "h6" => format!("#### {text}"),
        "li" => format!("- {text}"),
        "blockquote" => format!("> {text}"),
        "pre" => format!("```\n{text}\n```"),
        _ => text.to_string(),
    }
}

fn collect_images(doc: &Html, base_url: &str) -> Vec<String> {
    let Ok(sel) = Selector::parse("img") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for img in doc.select(&sel) {
        if let Some(src) = img.value().attr("src") {
            let abs = resolve_url(base_url, src);
            if abs.starts_with("http") && seen.insert(abs.clone()) {
                out.push(abs);
                if out.len() >= 30 {
                    break;
                }
            }
        }
    }
    out
}

/// Resolve a possibly-relative URL against the page's URL. Handles the common
/// cases (absolute, protocol-relative, root-relative, path-relative) without an
/// external URL-parsing crate.
fn resolve_url(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    if let Some(rest) = href.strip_prefix("//") {
        let scheme = base.split(':').next().unwrap_or("https");
        return format!("{scheme}://{rest}");
    }
    // Origin = scheme://host (everything up to the third '/').
    let origin_end = base
        .char_indices()
        .filter(|(_, c)| *c == '/')
        .nth(2)
        .map(|(i, _)| i)
        .unwrap_or(base.len());
    let origin = &base[..origin_end];
    if href.starts_with('/') {
        return format!("{origin}{href}");
    }
    // Path-relative: strip the last path segment of the base.
    let path_base = base.rsplit_once('/').map(|(a, _)| a).unwrap_or(base);
    format!("{path_base}/{href}")
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"
        <html><head><title>  Widgets  Explained </title></head>
        <body>
          <nav><a href="/">Home</a><p>Skip nav junk</p></nav>
          <header><p>Site header tagline</p></header>
          <main>
            <h1>Widgets</h1>
            <p>A widget is a small reusable component.</p>
            <ul><li>First point about widgets</li><li>Second point</li></ul>
            <script>var x = 'ignore me';</script>
            <blockquote>Widgets are great.</blockquote>
            <img src="/img/w.png">
            <img src="https://cdn.example.com/a.jpg">
          </main>
          <footer><p>Copyright footer text</p></footer>
        </body></html>
    "#;

    #[test]
    fn extracts_title_and_main_text_dropping_chrome() {
        let (title, paras, _) = parse_html(PAGE, "https://example.com/widgets", false);
        assert_eq!(title, "Widgets Explained");
        let joined: String = paras.iter().map(|p| p.rendered.clone()).collect::<Vec<_>>().join("\n");
        assert!(joined.contains("# Widgets"));
        assert!(joined.contains("- First point about widgets"));
        assert!(joined.contains("> Widgets are great."));
        // Chrome and scripts are excluded.
        assert!(!joined.contains("Skip nav junk"));
        assert!(!joined.contains("Site header tagline"));
        assert!(!joined.contains("Copyright footer text"));
        assert!(!joined.contains("ignore me"));
    }

    #[test]
    fn collects_and_resolves_image_urls() {
        let (_, _, images) = parse_html(PAGE, "https://example.com/widgets", true);
        assert!(images.contains(&"https://example.com/img/w.png".to_string()));
        assert!(images.contains(&"https://cdn.example.com/a.jpg".to_string()));
    }

    #[test]
    fn resolve_url_handles_relative_forms() {
        assert_eq!(resolve_url("https://a.com/x/y", "https://b.com/z"), "https://b.com/z");
        assert_eq!(resolve_url("https://a.com/x/y", "//cdn.com/z"), "https://cdn.com/z");
        assert_eq!(resolve_url("https://a.com/x/y", "/root"), "https://a.com/root");
        assert_eq!(resolve_url("https://a.com/x/y", "sib"), "https://a.com/x/sib");
    }

    #[test]
    fn scores_paragraph_by_term_overlap() {
        let terms = vec!["widget".to_string(), "reusable".to_string()];
        assert_eq!(score_paragraph("a widget is reusable widget", &terms), 3);
        assert_eq!(score_paragraph("unrelated content", &terms), 0);
    }
}
