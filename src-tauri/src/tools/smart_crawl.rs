//! `smart_crawl` — read several pages within one site, best-first.
//!
//! Hound-based searching tool: <https://github.com/dondai1234/master-fetch>.
//! A simplified take on Hound's `smart_crawl`: a shallow, same-site, best-first
//! traversal. Starting from a seed URL it fetches the page, harvests same-site
//! links, and — when given a `query` — visits the links whose anchor text and
//! path look most relevant next, up to a small page budget. No stealth browser,
//! no JS execution; it reads what the server renders as HTML.
//!
//! Use it to pull a topic off a documentation site or a section of a site in one
//! call, rather than fetching page after page by hand.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use crate::tools::web_util::{
    fetch_and_render, host_of, query_terms, same_site, score_text, strip_fragment,
};
use serde_json::{json, Value};
use std::collections::HashSet;

const DEFAULT_MAX_PAGES: u64 = 5;
const HARD_MAX_PAGES: u64 = 15;
const DEFAULT_MAX_CHARS: usize = 4000;
const HARD_MAX_CHARS: usize = 15000;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "smart_crawl".into(),
            description: "Starting from one URL, follow links within the same site and read several \
                pages, returning each page's clean text. Best-first: when you give a `query`, pages \
                whose links look most relevant are visited first; without one it fans out breadth-\
                first. Use it to gather a topic from a documentation site or a section of a site in \
                a single call instead of reading one page at a time. Same-site only, shallow, and \
                capped by `max_pages`. HTTP-only — no JavaScript execution."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The seed URL to start from (absolute http(s))."
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional. Guides which links to follow first and trims each page's text to what's relevant."
                    },
                    "max_pages": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": HARD_MAX_PAGES,
                        "default": DEFAULT_MAX_PAGES,
                        "description": "How many pages to read in total, including the seed (default 5, max 15)."
                    },
                    "max_chars_per_page": {
                        "type": "integer",
                        "minimum": 500,
                        "maximum": HARD_MAX_CHARS,
                        "default": DEFAULT_MAX_CHARS,
                        "description": "Character budget for each page's returned text (default 4000)."
                    },
                    "include_subdomains": {
                        "type": "boolean",
                        "default": true,
                        "description": "When true, subdomains of the seed's site count as same-site (docs.example.com from example.com). When false, only the exact host is followed."
                    }
                },
                "required": ["url"]
            }),
        },
    }
}

pub async fn run(args: &Value) -> AppResult<String> {
    let seed = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if !(seed.starts_with("http://") || seed.starts_with("https://")) {
        return Ok(json!({
            "error": "url parameter required — an absolute http(s) seed URL to crawl from."
        })
        .to_string());
    }
    let Some(seed_host) = host_of(&seed) else {
        return Ok(json!({ "error": format!("could not parse a host from '{seed}'") }).to_string());
    };

    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let terms = query.as_deref().map(query_terms).unwrap_or_default();
    let max_pages = args
        .get("max_pages")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_MAX_PAGES)
        .clamp(1, HARD_MAX_PAGES) as usize;
    let max_chars = args
        .get("max_chars_per_page")
        .and_then(|v| v.as_u64())
        .map(|n| (n as usize).clamp(500, HARD_MAX_CHARS))
        .unwrap_or(DEFAULT_MAX_CHARS);
    let include_subdomains = args
        .get("include_subdomains")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    // Best-first frontier. `priority` is the link's relevance score (higher =
    // visited sooner); without a query every link scores 0, so `discovery`
    // breaks ties in insertion order → breadth-first. Sequential fetching keeps
    // the crawl gentle on the target site.
    struct Candidate {
        url: String,
        priority: i64,
        discovery: usize,
    }
    let mut frontier: Vec<Candidate> = vec![Candidate {
        url: strip_fragment(&seed),
        priority: i64::MAX, // seed always first
        discovery: 0,
    }];
    let mut visited: HashSet<String> = HashSet::new();
    let mut queued: HashSet<String> = HashSet::new();
    queued.insert(strip_fragment(&seed));
    let mut discovery_counter = 1usize;

    let mut pages: Vec<Value> = Vec::new();
    let mut errors = 0usize;

    while pages.len() < max_pages && !frontier.is_empty() {
        // Pop the highest-priority candidate (ties: earliest discovered).
        let best_idx = frontier
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| {
                a.priority
                    .cmp(&b.priority)
                    .then(b.discovery.cmp(&a.discovery)) // smaller discovery wins
            })
            .map(|(i, _)| i)
            .unwrap();
        let current = frontier.swap_remove(best_idx);
        let url = current.url;
        if !visited.insert(url.clone()) {
            continue;
        }

        match fetch_and_render(&url, query.as_deref(), max_chars, false, true).await {
            Ok(page) => {
                pages.push(json!({
                    "ref": pages.len() + 1,
                    "url": url,
                    "type": page.kind,
                    "title": page.title,
                    "content": page.content,
                    "truncated": page.truncated,
                }));

                // Enqueue same-site links we haven't seen, scored for best-first.
                for link in page.links {
                    let norm = strip_fragment(&link.url);
                    if visited.contains(&norm) || queued.contains(&norm) {
                        continue;
                    }
                    let Some(h) = host_of(&norm) else { continue };
                    if !same_site(&seed_host, &h, include_subdomains) {
                        continue;
                    }
                    // Score on anchor text + the URL path, so a relevant-looking
                    // link is visited before a nav/footer one.
                    let priority = if terms.is_empty() {
                        0
                    } else {
                        let hay = format!("{} {}", link.anchor, norm);
                        score_text(&hay, &terms)
                    };
                    queued.insert(norm.clone());
                    frontier.push(Candidate {
                        url: norm,
                        priority,
                        discovery: discovery_counter,
                    });
                    discovery_counter += 1;
                }
                // Keep the frontier bounded on link-heavy sites: retain the best
                // candidates by priority (then earliest discovered).
                if frontier.len() > 400 {
                    frontier.sort_by(|a, b| {
                        b.priority.cmp(&a.priority).then(a.discovery.cmp(&b.discovery))
                    });
                    frontier.truncate(400);
                }
            }
            Err(e) => {
                errors += 1;
                pages.push(json!({
                    "ref": pages.len() + 1,
                    "url": url,
                    "error": e,
                }));
            }
        }
    }

    Ok(json!({
        "seed": seed,
        "pages_read": pages.iter().filter(|p| p.get("error").is_none()).count(),
        "pages_errored": errors,
        "pages": pages,
        "note": "Same-site, HTTP-only crawl (no JavaScript execution, robots.txt not consulted). \
            Increase max_pages to go wider; give a query to steer which links are followed first.",
        "citation_instructions": "When you use information from a page, cite it inline with its \
            `ref` number in square brackets immediately after the claim. Only cite pages you used."
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live smoke test — shallow-crawls a real site through the emulated client.
    /// Run with: cargo test --lib smart_crawl::tests::live_crawl -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the live network"]
    async fn live_crawl() {
        let args = json!({ "url": "https://www.rust-lang.org/", "query": "install cargo", "max_pages": 3 });
        let out = run(&args).await.unwrap();
        println!("{out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        // At least the seed page should have been read.
        assert!(v["pages_read"].as_u64().unwrap() >= 1, "no pages read: {v}");
        assert!(v["pages"].as_array().unwrap().iter().any(|p| p.get("error").is_none()));
    }
}
