//! `smart_search` — keyless, multi-engine web search.
//!
//! Hound-based searching tool: <https://github.com/dondai1234/master-fetch>.
//! Hound fans out to ~10 engines and merges them with an ONNX neural
//! cross-encoder. This is the simplified take on the same idea: seven keyless
//! engines queried in parallel through the browser-emulating client and merged
//! with Reciprocal Rank Fusion — no API key, no neural model, no headless
//! browser. The engines are DuckDuckGo, Bing, Brave, Yandex, Ecosia, Yahoo, and
//! Wikipedia. (Hound's Google / Startpage / Qwant were dropped: all three answer
//! a keyless HTTP client with a challenge or 403 that only a stealth browser
//! clears, and Mojeek serves a captcha to non-residential IPs — including one
//! anyway would just add a dead engine and a failure line.)
//!
//! The point is resilience and breadth. MultiZone's original single-engine
//! `web_search` went silently empty whenever DuckDuckGo served an anti-bot
//! challenge. Here, one engine being blocked doesn't sink the query: whatever
//! engines answer are fused, the same URL found by several engines is rewarded
//! and deduped, and the result reports which engines contributed (and which
//! failed and why), so a total wipeout is visible instead of masquerading as
//! "no results".

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use crate::tools::web_util::{client, percent_decode};
use scraper::{Html, Selector};
use serde_json::{json, Value};
use std::pin::Pin;

// ── Result type ───────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Hit {
    title: String,
    url: String,
    snippet: String,
}

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "smart_search".into(),
            description:
                "Search the web across seven independent engines at once (DuckDuckGo, Bing, Brave, \
                 Yandex, Ecosia, Yahoo, Wikipedia) and merge the results. More resilient than a \
                 single-engine search: if one engine is rate-limiting or blocked, the others still \
                 return results, so you rarely get a false 'no results'. Keyless and local — no API \
                 key or paid service. Returns ranked results with title, url, and snippet, plus \
                 which engines found each."
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
                        "description": "Number of merged results to return (default 8)"
                    }
                },
                "required": ["query"]
            }),
        },
    }
}

pub async fn run(args: &Value) -> AppResult<String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim();
    let n = args
        .get("num_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(8)
        .clamp(1, 20) as usize;

    if query.is_empty() {
        return Ok(json!({ "error": "query parameter required" }).to_string());
    }

    // Fan out to every engine in parallel. Each over-fetches a little (n + 5) so
    // the fusion has room to reorder before we cut to n. Boxed futures let the
    // engine list live in a Vec despite each async fn having a distinct type.
    let want = n + 5;
    // `+ Send` matters: these futures are awaited inside a Tauri command handler,
    // whose future must be Send. Each engine parses `scraper` (non-Send) types
    // only in a synchronous span after its last await, so the futures stay Send.
    type EngineFut<'a> = Pin<
        Box<dyn std::future::Future<Output = (&'static str, Result<Vec<Hit>, String>)> + Send + 'a>,
    >;
    let searches: Vec<EngineFut> = vec![
        Box::pin(tagged("duckduckgo", search_duckduckgo(query, want))),
        Box::pin(tagged("bing", search_bing(query, want))),
        Box::pin(tagged("brave", search_brave(query, want))),
        Box::pin(tagged("yandex", search_yandex(query, want))),
        Box::pin(tagged("ecosia", search_ecosia(query, want))),
        Box::pin(tagged("yahoo", search_yahoo(query, want))),
        Box::pin(tagged("wikipedia", search_wikipedia(query, want))),
    ];
    let engine_results = futures_util::future::join_all(searches).await;

    let mut engine_lists: Vec<(&str, Vec<Hit>)> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    for (name, res) in engine_results {
        match res {
            Ok(hits) if !hits.is_empty() => engine_lists.push((name, hits)),
            Ok(_) => failures.push(format!("{name}: no results")),
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }

    if engine_lists.is_empty() {
        // Every engine failed — surface the reasons rather than an empty set, so
        // the model doesn't tell the user a well-covered topic has no coverage.
        return Ok(json!({
            "query": query,
            "results": [],
            "error": "All search engines failed or returned nothing. This is almost certainly \
                temporary rate-limiting / anti-bot blocking of this IP, NOT evidence that the topic \
                has no results. Do not retry immediately. Reasons per engine follow.",
            "engine_failures": failures,
        })
        .to_string());
    }

    let merged = fuse(&engine_lists, n);
    let engines_used: Vec<&str> = engine_lists.iter().map(|(n, _)| *n).collect();

    let results: Vec<Value> = merged
        .iter()
        .enumerate()
        .map(|(i, m)| {
            json!({
                "ref": i + 1,
                "title": m.hit.title,
                "url": m.hit.url,
                "snippet": m.hit.snippet,
                "found_by": m.engines,
            })
        })
        .collect();

    let mut out = json!({
        "query": query,
        "engines_used": engines_used,
        "results": results,
        "citation_instructions": "When you use information from a result, cite it inline with its \
            `ref` number in square brackets immediately after the claim, e.g. \"The crate is \
            memory-safe [1].\" Combine multiple sources as [1][3]. Only cite results you used.",
    });
    if !failures.is_empty() {
        // Non-fatal: some engines answered, but say which didn't so a thin result
        // set is understood as partial coverage, not the whole web.
        out["partial_engine_failures"] = json!(failures);
    }
    Ok(out.to_string())
}

/// Tag an engine's future with its name so `join_all` returns labelled results.
async fn tagged(
    name: &'static str,
    fut: impl std::future::Future<Output = Result<Vec<Hit>, String>>,
) -> (&'static str, Result<Vec<Hit>, String>) {
    (name, fut.await)
}

// ── Reciprocal Rank Fusion ────────────────────────────────────────────────────

struct Merged {
    hit: Hit,
    engines: Vec<String>,
}

/// Fuse per-engine ranked lists into one. RRF scores a URL as the sum over
/// engines of `1/(k + rank)` (k = 60, the standard constant); appearing high in
/// several engines beats ranking first in only one. URLs are keyed by a
/// normalized form so the same page from two engines merges into one row that
/// records both as `found_by`.
fn fuse(engine_lists: &[(&str, Vec<Hit>)], n: usize) -> Vec<Merged> {
    const K: f64 = 60.0;
    use std::collections::HashMap;

    struct Acc {
        score: f64,
        hit: Hit,
        engines: Vec<String>,
    }
    let mut acc: HashMap<String, Acc> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for (engine, hits) in engine_lists {
        for (rank, hit) in hits.iter().enumerate() {
            let key = norm_url(&hit.url);
            if key.is_empty() {
                continue;
            }
            let contribution = 1.0 / (K + rank as f64 + 1.0);
            let entry = acc.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                Acc {
                    score: 0.0,
                    hit: hit.clone(),
                    engines: Vec::new(),
                }
            });
            entry.score += contribution;
            entry.engines.push((*engine).to_string());
            // Prefer the longest snippet / title seen across engines.
            if hit.snippet.len() > entry.hit.snippet.len() {
                entry.hit.snippet = hit.snippet.clone();
            }
            if entry.hit.title.trim().is_empty() && !hit.title.trim().is_empty() {
                entry.hit.title = hit.title.clone();
            }
        }
    }

    let mut merged: Vec<(f64, Merged)> = acc
        .into_values()
        .map(|a| {
            (
                a.score,
                Merged {
                    hit: a.hit,
                    engines: a.engines,
                },
            )
        })
        .collect();
    // Highest fused score first; stable enough for a search result list.
    merged.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    merged.into_iter().take(n).map(|(_, m)| m).collect()
}

/// Normalize a URL for cross-engine dedup: lowercase host, drop scheme, `www.`,
/// a trailing slash, and any `#fragment`. Keeps the path + query so distinct
/// pages stay distinct.
fn norm_url(url: &str) -> String {
    let no_frag = url.split('#').next().unwrap_or(url);
    let after = no_frag.split("://").nth(1).unwrap_or(no_frag);
    let mut s = after.to_string();
    if let Some(rest) = s.strip_prefix("www.") {
        s = rest.to_string();
    }
    let s = s.trim_end_matches('/');
    // lowercase only the host portion; leave the path case-sensitive
    match s.split_once('/') {
        Some((host, path)) => format!("{}/{}", host.to_lowercase(), path),
        None => s.to_lowercase(),
    }
}

// ── Engine: DuckDuckGo (html.duckduckgo.com) ──────────────────────────────────

async fn search_duckduckgo(query: &str, n: usize) -> Result<Vec<Hit>, String> {
    let resp = client()
        .get("https://html.duckduckgo.com/html/")
        .header("Referer", "https://duckduckgo.com/")
        .query(&[("q", query), ("kl", "en-us")])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let html = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() && !status.is_redirection() {
        // DDG answers a throttle with 202 carrying a challenge page, not an error
        // code, so check the body rather than trusting the status alone.
        return Err(format!("HTTP {status}"));
    }
    let lower = html.to_lowercase();
    if (status.as_u16() == 202 || !lower.contains("result__a"))
        && (lower.contains("anomaly") || lower.contains("challenge-platform") || lower.contains("unusual traffic"))
    {
        return Err("anti-bot challenge (rate-limited, not an empty result set)".into());
    }

    let doc = Html::parse_document(&html);
    let link_sel = Selector::parse("a.result__a").map_err(|e| e.to_string())?;
    let snip_sel = Selector::parse(".result__snippet").map_err(|e| e.to_string())?;
    let links: Vec<_> = doc.select(&link_sel).collect();
    let snippets: Vec<_> = doc.select(&snip_sel).collect();

    let mut hits = Vec::new();
    for (i, link) in links.iter().enumerate() {
        if hits.len() >= n {
            break;
        }
        let title = link.text().collect::<String>().trim().to_string();
        let href = link.value().attr("href").unwrap_or("");
        let url = decode_ddg_url(href);
        if url.is_empty() || !url.starts_with("http") || url.contains("duckduckgo.com") {
            continue;
        }
        let snippet = snippets
            .get(i)
            .map(|s| s.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        hits.push(Hit { title, url, snippet });
    }
    Ok(hits)
}

/// DDG links look like `//duckduckgo.com/l/?uddg=<percent-encoded-url>&rut=...`.
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

// ── Generic HTML helpers ──────────────────────────────────────────────────────

/// GET an engine's HTML through the emulated client, erroring on non-success.
async fn fetch_html(url: &str, query: &[(&str, &str)]) -> Result<String, String> {
    let resp = client()
        .get(url)
        .query(query)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    resp.text().await.map_err(|e| format!("read failed: {e}"))
}

/// Parse an engine whose organic result is a single title anchor with a *direct*
/// (non-redirect) href, matched by `title_css`. `skip_host` drops the engine's
/// own links. Snippets aren't paired (engine-specific); fusion fills them in
/// from whichever engine did carry one.
fn parse_direct_anchors(
    html: &str,
    title_css: &str,
    skip_host: &str,
    n: usize,
) -> Result<Vec<Hit>, String> {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(title_css).map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for a in doc.select(&sel) {
        if hits.len() >= n {
            break;
        }
        let href = a.value().attr("href").unwrap_or("");
        if !href.starts_with("http") || href.contains(skip_host) {
            continue;
        }
        if !seen.insert(href.to_string()) {
            continue;
        }
        let title = a.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
        hits.push(Hit {
            title,
            url: href.to_string(),
            snippet: String::new(),
        });
    }
    Ok(hits)
}

// ── Engine: Brave ─────────────────────────────────────────────────────────────
// Independent index. Organic result titles are `<a class="… l1">` with a direct
// href; the enrichment / deep-link / "similar page" cards use other classes, so
// selecting `a.l1` skips the noise.

async fn search_brave(query: &str, n: usize) -> Result<Vec<Hit>, String> {
    let html = fetch_html("https://search.brave.com/search", &[("q", query), ("source", "web")]).await?;
    parse_direct_anchors(&html, "a.l1", "brave.com", n)
}

// ── Engine: Yandex ────────────────────────────────────────────────────────────
// Fully independent (non-Bing/Google) index. Organic titles are
// `<a class="… OrganicTitle-Link">` with direct hrefs.

async fn search_yandex(query: &str, n: usize) -> Result<Vec<Hit>, String> {
    let html = fetch_html("https://yandex.com/search/", &[("text", query)]).await?;
    parse_direct_anchors(&html, "a.OrganicTitle-Link", "yandex", n)
}

// ── Engine: Ecosia ────────────────────────────────────────────────────────────
// Bing-backed but independently presented; direct result links `a.result__link`.

async fn search_ecosia(query: &str, n: usize) -> Result<Vec<Hit>, String> {
    let html = fetch_html("https://www.ecosia.org/search", &[("q", query)]).await?;
    parse_direct_anchors(&html, "a.result__link", "ecosia.org", n)
}

// ── Engine: Yahoo ─────────────────────────────────────────────────────────────
// Result titles are `<h3 ...> <a>` whose href is an `r.search.yahoo.com/…/RU=…`
// redirect wrapping the real target (percent-encoded in the `RU=` path segment).
// The anchor text prepends a breadcrumb URL to the title; we keep it as-is
// (display only — fusion keys on the decoded URL).

async fn search_yahoo(query: &str, n: usize) -> Result<Vec<Hit>, String> {
    let html = fetch_html("https://search.yahoo.com/search", &[("p", query)]).await?;
    let doc = Html::parse_document(&html);
    let sel = Selector::parse("h3 a[href]").map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for a in doc.select(&sel) {
        if hits.len() >= n {
            break;
        }
        let href = a.value().attr("href").unwrap_or("");
        let url = decode_yahoo_url(href);
        // Skip empties, the vertical tabs (video/image/news search), and self-links.
        if url.is_empty() || !url.starts_with("http") || url.contains("yahoo.com") {
            continue;
        }
        if !seen.insert(url.clone()) {
            continue;
        }
        let title = a.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
        hits.push(Hit { title, url, snippet: String::new() });
    }
    Ok(hits)
}

/// Yahoo wraps targets as `https://r.search.yahoo.com/…/RU=<percent-encoded>/RK=…`.
/// Extract and decode the `RU=` segment; pass a direct http href through.
fn decode_yahoo_url(href: &str) -> String {
    if let Some(pos) = href.find("/RU=") {
        let rest = &href[pos + 4..];
        let enc = rest.split("/RK=").next().unwrap_or(rest);
        let enc = enc.split('/').next().unwrap_or(enc);
        return percent_decode(enc);
    }
    if href.starts_with("http") && !href.contains("search.yahoo.com") {
        return href.to_string();
    }
    String::new()
}

// ── Engine: Wikipedia ─────────────────────────────────────────────────────────
// Not a web engine — the encyclopedia's keyless OpenSearch JSON API. Adds an
// authoritative reference result to the mix (Hound carries Wikipedia too). The
// response is `[query, [titles…], [descriptions…], [urls…]]`.

async fn search_wikipedia(query: &str, n: usize) -> Result<Vec<Hit>, String> {
    let resp = client()
        .get("https://en.wikipedia.org/w/api.php")
        .query(&[
            ("action", "opensearch"),
            ("format", "json"),
            ("limit", &n.to_string()),
            ("search", query),
        ])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    // wreq's Response has no typed `.json()`; parse the body text ourselves.
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    let data: Value = serde_json::from_str(&body).map_err(|e| format!("json parse failed: {e}"))?;
    let titles = data.get(1).and_then(|v| v.as_array());
    let descs = data.get(2).and_then(|v| v.as_array());
    let urls = data.get(3).and_then(|v| v.as_array());
    let (Some(titles), Some(urls)) = (titles, urls) else {
        return Ok(Vec::new());
    };
    let mut hits = Vec::new();
    for (i, url) in urls.iter().enumerate() {
        if hits.len() >= n {
            break;
        }
        let Some(url) = url.as_str() else { continue };
        let title = titles.get(i).and_then(|t| t.as_str()).unwrap_or("").to_string();
        let snippet = descs
            .and_then(|d| d.get(i))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        hits.push(Hit { title, url: url.to_string(), snippet });
    }
    Ok(hits)
}

// ── Engine: Bing ──────────────────────────────────────────────────────────────
// Third independent opinion. Result links are usually direct; some are wrapped
// in a bing.com/ck/a tracking redirect whose real target is a base64url `u=a1…`
// parameter, which we decode.

async fn search_bing(query: &str, n: usize) -> Result<Vec<Hit>, String> {
    let html = fetch_html("https://www.bing.com/search", &[("q", query), ("setlang", "en-us")]).await?;
    let doc = Html::parse_document(&html);
    let item_sel = Selector::parse("li.b_algo").map_err(|e| e.to_string())?;
    let title_sel = Selector::parse("h2 a").map_err(|e| e.to_string())?;
    let snip_sel = Selector::parse(".b_caption p, p").map_err(|e| e.to_string())?;

    let mut hits = Vec::new();
    for li in doc.select(&item_sel) {
        if hits.len() >= n {
            break;
        }
        let Some(a) = li.select(&title_sel).next() else {
            continue;
        };
        let href = a.value().attr("href").unwrap_or("");
        let url = decode_bing_url(href);
        if url.is_empty() || !url.starts_with("http") || url.contains("bing.com") {
            continue;
        }
        let title = a.text().collect::<String>().trim().to_string();
        let snippet = li
            .select(&snip_sel)
            .next()
            .map(|s| s.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        hits.push(Hit { title, url, snippet });
    }
    Ok(hits)
}

/// Direct Bing hrefs pass through. A `bing.com/ck/a?...&u=a1<base64url>&...`
/// redirect is decoded by base64url-decoding the `u` value (minus its `a1`
/// prefix); if that fails we drop the link rather than emit the tracker.
fn decode_bing_url(href: &str) -> String {
    if href.starts_with("http") && !href.contains("bing.com/ck/") {
        return href.to_string();
    }
    let Some(pos) = href.find("u=a1") else {
        return String::new();
    };
    let raw = &href[pos + 4..];
    let raw = raw.split('&').next().unwrap_or(raw);
    use base64::Engine;
    match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw) {
        Ok(bytes) => String::from_utf8(bytes).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_dedups_www_and_slash_and_frag() {
        assert_eq!(norm_url("https://www.Example.com/Path/"), norm_url("http://example.com/Path"));
        assert_eq!(norm_url("https://example.com/a#top"), "example.com/a");
    }

    #[test]
    fn fusion_rewards_agreement() {
        let a = vec![
            Hit { title: "A".into(), url: "https://x.com/1".into(), snippet: "".into() },
            Hit { title: "B".into(), url: "https://x.com/2".into(), snippet: "long snippet".into() },
        ];
        let b = vec![
            Hit { title: "B".into(), url: "https://x.com/2".into(), snippet: "".into() },
        ];
        // /2 is found by both engines, so it should rank first despite being #2 in A.
        let merged = fuse(&[("e1", a), ("e2", b)], 5);
        assert_eq!(merged[0].hit.url, "https://x.com/2");
        assert_eq!(merged[0].engines.len(), 2);
        assert_eq!(merged[0].hit.snippet, "long snippet");
    }

    #[test]
    fn ddg_url_decodes() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&rut=abc";
        assert_eq!(decode_ddg_url(href), "https://rust-lang.org/");
    }

    #[test]
    fn bing_direct_url_passthrough() {
        assert_eq!(decode_bing_url("https://rust-lang.org/"), "https://rust-lang.org/");
        assert_eq!(decode_bing_url("/ck/a?u=a1garbage"), "");
    }

    /// Live smoke test — hits the real engines through the emulated client.
    /// Ignored by default (needs network); run with:
    ///   cargo test --lib smart_search::tests::live_smoke -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the live network"]
    async fn live_smoke() {
        let args = json!({ "query": "rust programming language", "num_results": 5 });
        let out = super::run(&args).await.unwrap();
        println!("{out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        let got_results = v
            .get("results")
            .and_then(|r| r.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        // Either we got results, or an honest engine-failure report — never a silent empty.
        assert!(got_results || v.get("error").is_some());
    }

    #[test]
    fn yahoo_url_decodes() {
        let href = "https://r.search.yahoo.com/_ylt=Awr;_ylu=abc/RU=https%3A%2F%2Frust-lang.org%2F/RK=2/RS=xyz";
        assert_eq!(decode_yahoo_url(href), "https://rust-lang.org/");
        assert_eq!(decode_yahoo_url("https://example.com/x"), "https://example.com/x");
        assert_eq!(decode_yahoo_url("https://video.search.yahoo.com/search"), "");
    }

    #[test]
    fn direct_anchor_parser_dedupes_and_skips_self_and_relative() {
        let html = r#"<html><body>
            <a class="l1" href="https://rust-lang.org/">Rust</a>
            <a class="l1" href="https://rust-lang.org/">Rust dup</a>
            <a class="l1" href="https://search.brave.com/settings">self</a>
            <a class="l1" href="/relative">rel</a>
            <a class="l1" href="https://en.wikipedia.org/wiki/Rust">Wiki</a>
        </body></html>"#;
        let hits = parse_direct_anchors(html, "a.l1", "brave.com", 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://rust-lang.org/");
        assert_eq!(hits[1].url, "https://en.wikipedia.org/wiki/Rust");
    }

    /// Live diversity check — confirms several engines actually answer, not one.
    /// Run with: cargo test --lib smart_search::tests::live_diversity -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the live network"]
    async fn live_diversity() {
        let args = json!({ "query": "rust programming language", "num_results": 8 });
        let out = super::run(&args).await.unwrap();
        println!("{out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        let engines = v.get("engines_used").and_then(|e| e.as_array()).cloned().unwrap_or_default();
        assert!(engines.len() >= 3, "expected several engines to answer, got {engines:?}");
    }
}
