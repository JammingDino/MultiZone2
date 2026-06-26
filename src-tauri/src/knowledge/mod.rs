//! RAG / local document knowledge (0.4.3).
//!
//! Knowledge is project-scoped and sourced from the project's `directory`. One
//! index per project: indexing walks that folder, reads text-bearing files,
//! splits them into overlapping chunks, embeds each chunk via the project's
//! chosen provider+model, and stores the vectors as raw f32 BLOBs in `kb_chunks`.
//! Retrieval (`search`) embeds the query the same way and ranks chunks by
//! brute-force cosine similarity — no native vector extension, which is ample at
//! desktop scale (tens of thousands of chunks score in a few milliseconds).
//!
//! The embedding model is bound to the index: every chunk and every query must
//! share one vector space, so changing the project's `kb_embedding_model`
//! requires a re-index (the UI surfaces this).

use crate::commands::{new_id, now_ts};
use crate::db::models::{Project, Provider};
use crate::error::{AppError, AppResult};
use crate::llm::client::LlmClient;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Files larger than this are skipped — they're almost always data dumps or
/// generated artifacts, not prose worth retrieving.
const MAX_FILE_BYTES: u64 = 2_000_000;
/// Target chunk size in characters, with overlap so a passage split across a
/// boundary still surfaces from either side.
const CHUNK_CHARS: usize = 1200;
const CHUNK_OVERLAP: usize = 200;
/// Inputs per `/embeddings` request. Keeps payloads reasonable while amortizing
/// round-trips over many chunks.
const EMBED_BATCH: usize = 64;

/// Directory names never descended into during the walk.
const SKIP_DIRS: &[&str] = &[
    ".git", ".svn", ".hg", "node_modules", "target", "dist", "build", "out",
    ".next", ".cache", ".venv", "venv", "__pycache__", ".idea", ".vscode",
];

/// Extensions treated as indexable text. `.pdf` is handled separately via
/// `pdf-extract`; everything else here is read as UTF-8.
const TEXT_EXTS: &[&str] = &[
    "md", "markdown", "txt", "text", "rst", "org",
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt",
    "c", "h", "cpp", "hpp", "cc", "cs", "swift", "rb", "php", "scala", "sh",
    "bash", "zsh", "ps1", "lua", "sql", "r", "jl", "dart", "vue", "svelte",
    "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
    "xml", "html", "htm", "css", "scss", "less", "csv", "tsv", "tex",
];

/// Outcome of an index run, surfaced to the UI.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    /// Files (re)embedded this run.
    pub indexed: usize,
    /// Files skipped because their content hash was unchanged since last index.
    pub unchanged: usize,
    /// Files removed from the index because they no longer exist on disk.
    pub removed: usize,
    /// Files that failed to read/embed; their messages are collected here.
    pub failed: usize,
    pub total_chunks: usize,
    pub dimensions: Option<usize>,
    pub errors: Vec<String>,
}

/// A retrieved chunk, ordered most-relevant first.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub ordinal: i64,
    pub text: String,
    pub score: f32,
}

// ── vector <-> blob ───────────────────────────────────────────────────────────

fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Cosine similarity. Returns 0 if either vector is zero-length or all-zero.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

// ── text handling ─────────────────────────────────────────────────────────────

/// Deterministic content hash for change detection across runs. SipHash with
/// fixed keys (std's `DefaultHasher`) is stable within and across app launches —
/// enough to tell "did this file change", which is all we need here.
fn content_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
}

fn is_indexable(path: &Path) -> bool {
    match ext_lower(path) {
        Some(e) => e == "pdf" || TEXT_EXTS.contains(&e.as_str()),
        None => false,
    }
}

/// Read a file's text. PDFs go through `pdf-extract`; everything else is read as
/// UTF-8 (binary / non-UTF-8 files return None and are skipped).
fn read_document_text(path: &Path) -> Option<String> {
    let ext = ext_lower(path)?;
    if ext == "pdf" {
        return pdf_extract::extract_text(path).ok().filter(|s| !s.trim().is_empty());
    }
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Split text into overlapping chunks of roughly `CHUNK_CHARS`, preferring to
/// break on a paragraph or line boundary near the target so chunks stay
/// semantically whole. Operates on char boundaries (UTF-8 safe).
fn chunk_text(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= CHUNK_CHARS {
        let t = text.trim();
        return if t.is_empty() { Vec::new() } else { vec![t.to_string()] };
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let hard_end = (start + CHUNK_CHARS).min(chars.len());
        // Prefer a break (paragraph, then newline, then space) in the last
        // quarter of the window so we don't slice mid-sentence.
        let mut end = hard_end;
        if hard_end < chars.len() {
            let window_start = start + (CHUNK_CHARS * 3 / 4);
            if let Some(b) = find_break(&chars, window_start, hard_end) {
                end = b;
            }
        }
        let piece: String = chars[start..end].iter().collect();
        let piece = piece.trim();
        if !piece.is_empty() {
            chunks.push(piece.to_string());
        }
        if end >= chars.len() {
            break;
        }
        // Step forward with overlap, but always make progress.
        start = end.saturating_sub(CHUNK_OVERLAP).max(start + 1);
    }
    chunks
}

/// Find the best place to break within `[from, to)`: last double-newline, else
/// last newline, else last space. Returns the index just after the break.
fn find_break(chars: &[char], from: usize, to: usize) -> Option<usize> {
    let mut last_newline = None;
    let mut last_space = None;
    let mut i = from;
    while i + 1 < to {
        if chars[i] == '\n' && chars[i + 1] == '\n' {
            return Some(i + 2);
        }
        if chars[i] == '\n' {
            last_newline = Some(i + 1);
        }
        if chars[i] == ' ' {
            last_space = Some(i + 1);
        }
        i += 1;
    }
    last_newline.or(last_space)
}

/// Recursively collect indexable files under `root`, skipping noise directories,
/// hidden entries, and oversized files.
fn collect_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Skip hidden entries (dotfiles/dotdirs) except a few useful docs.
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file() {
                if name.starts_with('.') {
                    continue;
                }
                if !is_indexable(&path) {
                    continue;
                }
                if entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX) > MAX_FILE_BYTES {
                    continue;
                }
                out.push(path);
            }
        }
    }
    out
}

// ── provider/client helpers ──────────────────────────────────────────────────

async fn load_project(db: &SqlitePool, project_id: &str) -> AppResult<Project> {
    let cols = crate::commands::projects::PROJECT_COLS;
    sqlx::query_as::<_, Project>(&format!("SELECT {cols} FROM projects WHERE id = ?1"))
        .bind(project_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("project {project_id}")))
}

async fn load_provider(db: &SqlitePool, provider_id: &str) -> AppResult<Provider> {
    sqlx::query_as::<_, Provider>(
        "SELECT id, name, base_url, api_key, default_model, created_at FROM providers WHERE id = ?1",
    )
    .bind(provider_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("provider {provider_id}")))
}

/// Resolve a project's embedding config into a ready client + model name, or a
/// descriptive error if it isn't configured.
async fn embedding_target<'a>(
    db: &SqlitePool,
    http: &'a reqwest::Client,
    project: &Project,
) -> AppResult<(LlmClient<'a>, String)> {
    let provider_id = project
        .kb_provider_id
        .as_deref()
        .ok_or_else(|| AppError::Provider("no embedding provider set for this project".into()))?;
    let model = project
        .kb_embedding_model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::Provider("no embedding model set for this project".into()))?;
    let provider = load_provider(db, provider_id).await?;
    let client = LlmClient::new(http, &provider.base_url, provider.api_key.as_deref());
    Ok((client, model))
}

/// Embed inputs in batches, flattening into one vector list in input order.
async fn embed_all(
    client: &LlmClient<'_>,
    model: &str,
    inputs: &[String],
) -> AppResult<Vec<Vec<f32>>> {
    let mut out = Vec::with_capacity(inputs.len());
    for batch in inputs.chunks(EMBED_BATCH) {
        let vecs = client.embed(model, batch).await?;
        out.extend(vecs);
    }
    Ok(out)
}

// ── public API ────────────────────────────────────────────────────────────────

/// Whether a project currently has any indexed chunks. Drives whether the
/// `search_knowledge` tool is offered to a chat.
pub async fn has_index(db: &SqlitePool, project_id: &str) -> bool {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM kb_chunks WHERE project_id = ?1")
        .bind(project_id)
        .fetch_one(db)
        .await
        .unwrap_or(0);
    count > 0
}

/// (Re)index a project's directory. Unchanged files (same content hash) are
/// skipped; changed/new files are re-embedded; files gone from disk are pruned.
/// Per-file failures are recorded without aborting the whole run.
pub async fn index_project(
    db: &SqlitePool,
    http: &reqwest::Client,
    project_id: &str,
) -> AppResult<IndexSummary> {
    let project = load_project(db, project_id).await?;
    let dir = project
        .directory
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::Provider("this project has no directory set".into()))?;
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(AppError::Provider(format!("project directory not found: {dir}")));
    }
    let (client, model) = embedding_target(db, http, &project).await?;

    // Existing index: path -> (document id, content hash).
    let existing: HashMap<String, (String, String)> = sqlx::query_as::<_, (String, String, String)>(
        "SELECT path, id, hash FROM kb_documents WHERE project_id = ?1",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(path, id, hash)| (path, (id, hash)))
    .collect();

    let files = collect_files(&root);
    let mut summary = IndexSummary::default();
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut dimensions: Option<usize> = project.kb_dimensions.map(|d| d as usize);

    for abs in files {
        let rel = abs
            .strip_prefix(&root)
            .unwrap_or(&abs)
            .to_string_lossy()
            .replace('\\', "/");
        seen_paths.insert(rel.clone());

        let text = match read_document_text(&abs) {
            Some(t) => t,
            None => continue, // unreadable / empty / non-UTF-8 — silently skip
        };
        let hash = content_hash(&text);

        // Unchanged since last index → leave its chunks in place.
        if let Some((_, prev_hash)) = existing.get(&rel) {
            if prev_hash == &hash {
                summary.unchanged += 1;
                continue;
            }
        }

        let chunks = chunk_text(&text);
        if chunks.is_empty() {
            continue;
        }

        let doc_id = existing
            .get(&rel)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(new_id);
        let title = abs
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| rel.clone());
        let now = now_ts();

        match embed_all(&client, &model, &chunks).await {
            Ok(vectors) => {
                if let Some(v) = vectors.first() {
                    dimensions = Some(v.len());
                }
                // Replace this document's chunks atomically.
                let mut tx = db.begin().await?;
                sqlx::query("DELETE FROM kb_chunks WHERE document_id = ?1")
                    .bind(&doc_id)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query(
                    "INSERT INTO kb_documents (id, project_id, path, title, hash, chunk_count, status, error, indexed_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'indexed', NULL, ?7)
                     ON CONFLICT(project_id, path) DO UPDATE SET
                       title = excluded.title, hash = excluded.hash,
                       chunk_count = excluded.chunk_count, status = 'indexed',
                       error = NULL, indexed_at = excluded.indexed_at",
                )
                .bind(&doc_id)
                .bind(project_id)
                .bind(&rel)
                .bind(&title)
                .bind(&hash)
                .bind(chunks.len() as i64)
                .bind(now)
                .execute(&mut *tx)
                .await?;
                for (ordinal, (chunk, vector)) in chunks.iter().zip(vectors.iter()).enumerate() {
                    sqlx::query(
                        "INSERT INTO kb_chunks (id, project_id, document_id, ordinal, text, embedding, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    )
                    .bind(new_id())
                    .bind(project_id)
                    .bind(&doc_id)
                    .bind(ordinal as i64)
                    .bind(chunk)
                    .bind(vec_to_blob(vector))
                    .bind(now)
                    .execute(&mut *tx)
                    .await?;
                }
                tx.commit().await?;
                summary.indexed += 1;
                summary.total_chunks += chunks.len();
            }
            Err(e) => {
                summary.failed += 1;
                summary.errors.push(format!("{rel}: {e}"));
            }
        }
    }

    // Prune documents whose files are gone (chunks cascade-delete).
    for (path, (id, _)) in &existing {
        if !seen_paths.contains(path) {
            sqlx::query("DELETE FROM kb_documents WHERE id = ?1")
                .bind(id)
                .execute(db)
                .await?;
            summary.removed += 1;
        }
    }

    summary.dimensions = dimensions;
    let now = now_ts();
    sqlx::query("UPDATE projects SET kb_dimensions = ?1, kb_indexed_at = ?2 WHERE id = ?3")
        .bind(dimensions.map(|d| d as i64))
        .bind(now)
        .bind(project_id)
        .execute(db)
        .await?;

    Ok(summary)
}

/// Embed `query` and return the top-`k` chunks for the project by cosine
/// similarity. Returns an error if the project isn't configured for embeddings.
pub async fn search(
    db: &SqlitePool,
    http: &reqwest::Client,
    project_id: &str,
    query: &str,
    k: usize,
) -> AppResult<Vec<SearchHit>> {
    let project = load_project(db, project_id).await?;
    let (client, model) = embedding_target(db, http, &project).await?;
    let query_vec = client
        .embed(&model, std::slice::from_ref(&query.to_string()))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Provider("embedding provider returned no vector".into()))?;

    let rows = sqlx::query_as::<_, (String, String, i64, String, Vec<u8>)>(
        "SELECT d.path, d.title, c.ordinal, c.text, c.embedding
         FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
         WHERE c.project_id = ?1",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;

    let mut scored: Vec<SearchHit> = rows
        .into_iter()
        .map(|(path, title, ordinal, text, blob)| {
            let score = cosine(&query_vec, &blob_to_vec(&blob));
            SearchHit { path, title, ordinal, text, score }
        })
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(k);
    Ok(scored)
}
