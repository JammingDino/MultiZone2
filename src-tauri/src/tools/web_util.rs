//! Shared plumbing for the "smart" web tools (`smart_search`, `smart_fetch`,
//! `smart_crawl`).
//!
//! These tools are a from-scratch, dependency-light reimplementation of the
//! ideas in **Hound** — the keyless, host-driven web research MCP server:
//! <https://github.com/dondai1234/master-fetch>. Hound's design is the better
//! one; this is a deliberately simplified take that fits MultiZone's
//! native-dependency-avoidance stance. The single biggest divergence: Hound
//! escalates to a stealth headless browser (Patchright) to defeat Cloudflare /
//! Turnstile, whereas everything here is **HTTP-only, pure Rust**. That means we
//! cannot solve interactive bot challenges or read JS-only pages — so instead of
//! faking content we report those cases honestly (the same ethic Hound follows
//! for its own out-of-scope limits).
//!
//! This module holds the pieces the three tools share: a rotating user-agent
//! pool, small URL helpers (no `url` crate), HTML → lightweight-markdown
//! extraction that also harvests links and images, PDF text extraction, a
//! keyword relevance reranker, and `fetch_and_render` — the one function that
//! turns a URL into clean text (HTML or PDF), with HTTP status mapped to a
//! human-readable reason rather than a silent empty.

use scraper::{ElementRef, Html, Selector};
use std::sync::OnceLock;

// ── Browser-emulating HTTP client ─────────────────────────────────────────────
// One shared `wreq` client carrying a real Chrome fingerprint (JA3/JA4 TLS +
// HTTP/2 settings + header order). This is what lets the keyless engines and
// page fetches get through: `reqwest`'s rustls fingerprint is trivially
// detectable as "not a browser" and the engines answer it with an anti-bot
// challenge instead of results. wreq owns the browser-consistent header set —
// crucially the User-Agent — so callers here deliberately do NOT set User-Agent
// (an emulated TLS handshake paired with a hand-typed UA is an inconsistent,
// more-suspicious fingerprint than either alone). The rest of the app keeps
// using the plain reqwest client; only the smart web tools use this one.
static SMART_CLIENT: OnceLock<wreq::Client> = OnceLock::new();

pub fn client() -> &'static wreq::Client {
    SMART_CLIENT.get_or_init(|| {
        wreq::Client::builder()
            .emulation(wreq_util::Emulation::Chrome137)
            // wreq, unlike reqwest, does NOT follow redirects by default. A bare
            // `https://site/` answering 301 → `https://site/en-US/` would surface
            // as an error otherwise; follow up to 10 hops like a browser does.
            .redirect(wreq::redirect::Policy::limited(10))
            .build()
            .expect("build wreq browser-emulation client")
    })
}

// ── URL helpers (no `url` crate — keep the dependency tree lean) ───────────────

/// Lowercased host of an absolute URL, userinfo and port stripped.
/// `https://user@Docs.Example.com:8443/x` → `docs.example.com`.
pub fn host_of(url: &str) -> Option<String> {
    let after = url.split("://").nth(1)?;
    let authority = after.split(['/', '?', '#']).next()?;
    let hostport = authority.rsplit('@').next().unwrap_or(authority);
    let host = hostport.split(':').next().unwrap_or(hostport);
    if host.is_empty() {
        None
    } else {
        Some(host.to_lowercase())
    }
}

/// Registrable-domain approximation: the last two labels of a host. This is a
/// deliberate simplification — it treats `bbc.co.uk` as `co.uk` — but it is only
/// used to keep a shallow same-site crawl on the same site, where "same last two
/// labels" is close enough and never leaves the seed's neighbourhood.
fn registrable(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').filter(|s| !s.is_empty()).collect();
    let n = labels.len();
    if n <= 2 {
        host.to_string()
    } else {
        labels[n - 2..].join(".")
    }
}

/// True when `candidate` belongs to the same site as `seed_host`.
/// With `include_subdomains`, `docs.example.com` counts as same-site as
/// `example.com`; without it, only an exact host match does.
pub fn same_site(seed_host: &str, candidate: &str, include_subdomains: bool) -> bool {
    if include_subdomains {
        registrable(seed_host) == registrable(candidate)
    } else {
        seed_host == candidate
    }
}

/// Drop a `#fragment` so `page` and `page#section` are treated as one URL.
pub fn strip_fragment(url: &str) -> String {
    url.split('#').next().unwrap_or(url).to_string()
}

/// Resolve a possibly-relative href against the page URL. Handles the common
/// forms (absolute, protocol-relative, root-relative, path-relative) without an
/// external URL parser. Returns an empty string for non-navigable schemes
/// (`javascript:`, `mailto:`, `tel:`, `data:`) so callers can drop them.
pub fn resolve_url(base: &str, href: &str) -> String {
    let href = href.trim();
    if href.is_empty() {
        return String::new();
    }
    let lower = href.to_ascii_lowercase();
    if lower.starts_with("javascript:")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:")
        || lower.starts_with("data:")
        || href.starts_with('#')
    {
        return String::new();
    }
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    if let Some(rest) = href.strip_prefix("//") {
        let scheme = base.split(':').next().unwrap_or("https");
        return format!("{scheme}://{rest}");
    }
    // origin = scheme://host (up to the third '/')
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
    // path-relative: drop the base's last segment (and any query) first
    let base_path = base.split(['?', '#']).next().unwrap_or(base);
    let path_base = base_path.rsplit_once('/').map(|(a, _)| a).unwrap_or(origin);
    format!("{path_base}/{href}")
}

/// Minimal percent-decoder for the subset search engines actually emit in their
/// redirect links (`%3A`, `%2F`, `+` → space).
pub fn percent_decode(s: &str) -> String {
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

pub fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── Relevance scoring ─────────────────────────────────────────────────────────

/// Split a query into lowercased alphanumeric terms of length ≥ 3.
pub fn query_terms(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3)
        .map(|t| t.to_string())
        .collect()
}

/// Count how many query terms (with multiplicity) appear in `text`.
pub fn score_text(text: &str, terms: &[String]) -> i64 {
    if terms.is_empty() {
        return 0;
    }
    let lower = text.to_lowercase();
    terms.iter().map(|t| lower.matches(t.as_str()).count() as i64).sum()
}

// ── Page extraction ───────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Link {
    pub url: String,
    pub anchor: String,
}

pub struct RenderedPage {
    pub title: String,
    pub content: String,
    pub truncated: bool,
    /// "html" | "pdf" | "text"
    pub kind: &'static str,
    /// Same-document absolute links with anchor text (HTML only).
    pub links: Vec<Link>,
    pub images: Vec<String>,
}

#[derive(Clone)]
struct Para {
    text: String,
    rendered: String,
}

/// Fetch a URL over HTTP and render it to clean text. Routes HTML → markdown and
/// PDF → extracted text; anything else is refused. On a non-success status the
/// error string explains *why* (blocked, auth-required, not-found, rate-limited)
/// rather than returning blank — we have no headless browser to solve an
/// interactive challenge, so the honest report is the useful output.
///
/// `want_links` controls whether same-document links are harvested (crawl needs
/// them; fetch does not). Parsing uses `scraper`, whose types are not `Send`, so
/// all parsing happens in the synchronous `render_html` after the last `.await`
/// — nothing non-`Send` is ever held across an await point.
pub async fn fetch_and_render(
    url: &str,
    query: Option<&str>,
    max_chars: usize,
    include_images: bool,
    want_links: bool,
) -> Result<RenderedPage, String> {
    // No User-Agent / Accept overrides: the emulated client supplies a
    // browser-consistent header set (see `client()`).
    let resp = client()
        .get(url)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(explain_status(status.as_u16()));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let looks_pdf = content_type.contains("pdf")
        || (content_type.contains("octet-stream") && url.to_lowercase().ends_with(".pdf"));

    if looks_pdf {
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("read failed: {e}"))?
            .to_vec();
        // pdf_extract is CPU-bound and blocking — keep it off the async runtime.
        let text = tokio::task::spawn_blocking(move || pdf_extract::extract_text_from_mem(&bytes))
            .await
            .map_err(|e| format!("pdf task failed: {e}"))?
            .map_err(|e| format!("could not parse PDF: {e}"))?;
        let text = collapse_blank_lines(&text);
        if text.trim().is_empty() {
            return Err("PDF contained no extractable text (it may be a scanned image — OCR is not applied here)".into());
        }
        let (content, truncated) = trim_to(&text, max_chars);
        return Ok(RenderedPage {
            title: String::new(),
            content,
            truncated,
            kind: "pdf",
            links: Vec::new(),
            images: Vec::new(),
        });
    }

    let is_texty = content_type.is_empty()
        || content_type.contains("html")
        || content_type.contains("xml")
        || content_type.contains("text/plain");
    if !is_texty {
        return Err(format!(
            "unsupported content-type '{content_type}' — smart_fetch reads HTML, plain text, and PDF"
        ));
    }

    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;

    // Plain text that isn't markup: return it as-is, trimmed.
    if content_type.contains("text/plain") && !body.trim_start().starts_with('<') {
        let (content, truncated) = trim_to(&body, max_chars);
        return Ok(RenderedPage {
            title: String::new(),
            content,
            truncated,
            kind: "text",
            links: Vec::new(),
            images: Vec::new(),
        });
    }

    Ok(render_html(&body, url, query, max_chars, include_images, want_links))
}

/// Map an HTTP status to an honest, actionable reason.
fn explain_status(code: u16) -> String {
    match code {
        401 | 403 => format!(
            "HTTP {code} — the page refused the request (login required, or an anti-bot block). \
             There is no headless browser here to solve an interactive challenge, so this page \
             cannot be read automatically."
        ),
        404 | 410 => format!("HTTP {code} — page not found."),
        429 => "HTTP 429 — the site is rate-limiting this IP. Wait before retrying; do not hammer it.".into(),
        500..=599 => format!("HTTP {code} — the site's server errored (their side, not ours)."),
        other => format!("HTTP {other}."),
    }
}

/// Parse HTML into markdown, harvesting links and images. Fully synchronous so
/// no `scraper` (non-`Send`) value is ever held across an await.
fn render_html(
    html: &str,
    base_url: &str,
    query: Option<&str>,
    max_chars: usize,
    include_images: bool,
    want_links: bool,
) -> RenderedPage {
    let doc = Html::parse_document(html);

    let title = Selector::parse("title")
        .ok()
        .and_then(|sel| doc.select(&sel).next())
        .map(|t| collapse_ws(&t.text().collect::<String>()))
        .unwrap_or_default();

    // Prefer a semantic content root so site chrome is skipped; fall back to
    // <body>, then the whole document.
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
        if !seen.insert(text.clone()) {
            continue; // nested duplicate (e.g. <p> inside a captured <li>)
        }
        let rendered = render_block(el.value().name(), &text);
        paragraphs.push(Para { text, rendered });
    }

    // Optional relevance rerank: order paragraphs by term overlap so truncation
    // drops the least-relevant first. Original order is kept on ties / no query.
    if let Some(q) = query {
        let terms = query_terms(q);
        if !terms.is_empty() {
            let mut scored: Vec<(usize, i64, Para)> = paragraphs
                .into_iter()
                .enumerate()
                .map(|(idx, p)| {
                    let s = score_text(&p.text, &terms);
                    (idx, s, p)
                })
                .collect();
            scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            paragraphs = scored.into_iter().map(|(_, _, p)| p).collect();
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
        content =
            "(no readable text extracted — the page likely renders its content with JavaScript, which this HTTP-only reader cannot execute)"
                .to_string();
    }

    let links = if want_links {
        collect_links(&doc, base_url)
    } else {
        Vec::new()
    };
    let images = if include_images {
        collect_images(&doc, base_url)
    } else {
        Vec::new()
    };

    RenderedPage {
        title,
        content,
        truncated,
        kind: "html",
        links,
        images,
    }
}

fn is_in_chrome(el: &ElementRef) -> bool {
    let mut cur = Some(*el);
    while let Some(node) = cur {
        match node.value().name() {
            "nav" | "header" | "footer" | "aside" | "form" | "script" | "style" | "noscript"
            | "template" | "svg" | "button" => return true,
            _ => {}
        }
        cur = node.parent().and_then(ElementRef::wrap);
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

fn collect_links(doc: &Html, base_url: &str) -> Vec<Link> {
    let Ok(sel) = Selector::parse("a[href]") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for a in doc.select(&sel) {
        let Some(href) = a.value().attr("href") else {
            continue;
        };
        let abs = resolve_url(base_url, href);
        if !abs.starts_with("http") {
            continue;
        }
        let key = strip_fragment(&abs);
        if !seen.insert(key.clone()) {
            continue;
        }
        let anchor = collapse_ws(&a.text().collect::<String>());
        out.push(Link { url: key, anchor });
        if out.len() >= 300 {
            break;
        }
    }
    out
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

/// Trim a body of text to a character budget, breaking on a whitespace boundary
/// when possible. Returns (text, truncated?).
fn trim_to(s: &str, max_chars: usize) -> (String, bool) {
    if s.len() <= max_chars {
        return (s.trim().to_string(), false);
    }
    let mut cut = max_chars;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let slice = &s[..cut];
    let end = slice.rfind(char::is_whitespace).unwrap_or(cut);
    (slice[..end].trim().to_string(), true)
}

/// Collapse runs of 3+ newlines (common in PDF text extraction) to a blank line.
fn collapse_blank_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut newlines = 0;
    for ch in s.chars() {
        if ch == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push('\n');
            }
        } else {
            newlines = 0;
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_extraction() {
        assert_eq!(host_of("https://user@Docs.Example.com:8443/x?y#z").as_deref(), Some("docs.example.com"));
        assert_eq!(host_of("http://example.com").as_deref(), Some("example.com"));
        assert_eq!(host_of("not a url"), None);
    }

    #[test]
    fn same_site_matches_subdomains_when_asked() {
        assert!(same_site("example.com", "docs.example.com", true));
        assert!(!same_site("example.com", "docs.example.com", false));
        assert!(!same_site("example.com", "evil.com", true));
        assert!(same_site("example.com", "example.com", false));
    }

    #[test]
    fn resolve_url_forms() {
        assert_eq!(resolve_url("https://a.com/x/y", "https://b.com/z"), "https://b.com/z");
        assert_eq!(resolve_url("https://a.com/x/y", "//cdn.com/z"), "https://cdn.com/z");
        assert_eq!(resolve_url("https://a.com/x/y", "/root"), "https://a.com/root");
        assert_eq!(resolve_url("https://a.com/x/y", "sib"), "https://a.com/x/sib");
        assert_eq!(resolve_url("https://a.com/x/y?q=1", "sib"), "https://a.com/x/sib");
        assert_eq!(resolve_url("https://a.com/x/y", "mailto:a@b.com"), "");
        assert_eq!(resolve_url("https://a.com/x/y", "#frag"), "");
    }

    #[test]
    fn relevance_scoring() {
        let terms = query_terms("reusable Widget");
        assert_eq!(score_text("a widget is a reusable widget", &terms), 3);
        assert_eq!(score_text("unrelated content", &terms), 0);
    }

    #[test]
    fn trims_on_word_boundary() {
        let (t, trunc) = trim_to("hello world this is long", 12);
        assert!(trunc);
        assert!(!t.contains("this"));
        let (t2, trunc2) = trim_to("short", 100);
        assert_eq!(t2, "short");
        assert!(!trunc2);
    }
}
