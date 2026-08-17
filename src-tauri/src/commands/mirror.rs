//! Markdown mirror (0.7.2). When the user enables "Export as markdown" in
//! Settings → Data, every chat is mirrored to a `.md` file on disk under a
//! configurable directory and kept in sync on each message save. Zone configs
//! are written alongside as individual JSON files in a `zones/` subdirectory.
//! The format matches the manual Markdown export (see `src/lib/export.ts`):
//! YAML frontmatter + `## Who · timestamp` message blocks, so a mirrored file
//! can be read back into the DB via [`import_chat_from_markdown`].
//!
//! The live mirror is best-effort: a write failure logs a warning but never
//! blocks the message engine. Files are keyed by chat id (filename suffix
//! `--<chat_id>.md`) so a title change renames cleanly without orphaning.

use crate::commands::{new_id, now_ts};
use crate::db::models::{Chat, Message, Zone};
use crate::error::AppResult;
use crate::llm::types::ContentPart;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::state::AppState;

use crate::commands::chats::CHAT_COLS;
const MSG_COLS: &str =
    "id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, edited, created_at";
use crate::db::models::ZONE_COLS;

/// Resolved mirror configuration. Present only when the feature is on and an
/// output directory is set.
struct MirrorConfig {
    dir: PathBuf,
}

/// Parsed `app_settings` JSON, if any.
async fn app_settings_json(db: &SqlitePool) -> Option<Value> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
}

/// Read the mirror config from `app_settings`. Returns `None` when the feature
/// is disabled or no output directory is configured (the common case), so
/// callers cheaply no-op.
async fn read_config(db: &SqlitePool) -> Option<MirrorConfig> {
    let v = app_settings_json(db).await?;
    if !v.get("markdownMirrorEnabled").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let dir = v
        .get("markdownMirrorDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(MirrorConfig { dir: PathBuf::from(dir) })
}

// ─── Markdown rendering (mirrors src/lib/export.ts buildChatMarkdown) ─────────

/// Visible text of a stored message: the `text` parts only. Hidden
/// context-injection parts are intentionally excluded, matching the export.
fn visible_text(content_json: &str) -> String {
    let parts: Vec<ContentPart> = serde_json::from_str(content_json).unwrap_or_default();
    parts
        .iter()
        .filter_map(|p| match p {
            ContentPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_string()
}

/// Count of visible image parts (hidden images excluded).
fn image_count(content_json: &str) -> usize {
    let parts: Vec<ContentPart> = serde_json::from_str(content_json).unwrap_or_default();
    parts.iter().filter(|p| matches!(p, ContentPart::ImageUrl { .. })).count()
}

/// ISO-8601 timestamp for frontmatter dates.
fn fmt_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

/// Human-readable local timestamp for message-block headers.
fn fmt_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| {
            let local: chrono::DateTime<chrono::Local> = d.into();
            local.format("%Y-%m-%d %H:%M:%S").to_string()
        })
        .unwrap_or_default()
}

/// Filesystem-safe slug from the chat title (matches export.ts slugify).
fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in title.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let slug = out.trim_matches('-').chars().take(60).collect::<String>();
    if slug.is_empty() { "chat".to_string() } else { slug }
}

/// Quote a YAML scalar if it could confuse a parser (matches export.ts `q`).
fn yaml_quote(v: &str) -> String {
    if v.chars().any(|c| ":#[]{}&*!|>'\"%@`".contains(c)) {
        serde_json::to_string(v).unwrap_or_else(|_| v.to_string())
    } else {
        v.to_string()
    }
}

/// Build the full Markdown document for one chat.
fn build_markdown(
    chat: &Chat,
    messages: &[Message],
    zone_name: Option<&str>,
    zone_model: Option<&str>,
    project_name: Option<&str>,
    tags: &[String],
    zones_by_id: &HashMap<String, String>,
) -> String {
    let title = if chat.title.is_empty() { "Untitled chat" } else { &chat.title };
    let mut fm: Vec<String> = vec!["---".into()];
    fm.push(format!("title: {}", yaml_quote(title)));
    fm.push(format!("chat_id: {}", chat.id));
    if let Some(z) = zone_name { fm.push(format!("zone: {}", yaml_quote(z))); }
    if let Some(m) = zone_model { fm.push(format!("model: {}", yaml_quote(m))); }
    if let Some(p) = project_name { fm.push(format!("project: {}", yaml_quote(p))); }
    if !tags.is_empty() {
        let joined = tags.iter().map(|t| yaml_quote(t)).collect::<Vec<_>>().join(", ");
        fm.push(format!("tags: [{joined}]"));
    }
    fm.push(format!("created: {}", fmt_iso(chat.created_at)));
    fm.push(format!("updated: {}", fmt_iso(chat.updated_at)));
    fm.push(format!("exported: {}", fmt_iso(now_ts())));
    fm.push("---".into());
    fm.push(String::new());

    let mut body: Vec<String> = vec![format!("# {title}"), String::new()];
    for m in messages {
        if m.role != "user" && m.role != "assistant" {
            continue;
        }
        let text = visible_text(&m.content);
        let images = image_count(&m.content);
        if text.is_empty() && images == 0 {
            continue;
        }
        let who = if m.role == "user" {
            "User".to_string()
        } else {
            let zid = m.zone_id.as_ref().or(m.active_zone_id.as_ref());
            zid.and_then(|z| zones_by_id.get(z))
                .map(|s| s.as_str())
                .or(zone_name)
                .unwrap_or("Assistant")
                .to_string()
        };
        body.push(format!("## {who} · {}", fmt_date(m.created_at)));
        body.push(String::new());
        if !text.is_empty() {
            body.push(text);
            body.push(String::new());
        }
        if images > 0 {
            body.push(format!("_{images} image{} attached_", if images == 1 { "" } else { "s" }));
            body.push(String::new());
        }
    }

    format!("{}{}\n", fm.join("\n"), body.join("\n").trim_end())
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/// Best-effort mirror of one chat. Logs and swallows any error so it never
/// blocks the message engine.
pub async fn mirror_chat_best_effort(db: &SqlitePool, chat_id: &str) {
    if let Err(e) = mirror_chat(db, chat_id).await {
        tracing::warn!("markdown mirror failed for chat {chat_id}: {e}");
    }
}

/// Mirror one chat to disk (if the feature is enabled). Rewrites the whole file
/// from current DB state, so it's always correct regardless of which save
/// triggered it. Also refreshes the `zones/` JSON exports.
async fn mirror_chat(db: &SqlitePool, chat_id: &str) -> AppResult<()> {
    let Some(cfg) = read_config(db).await else { return Ok(()); };

    let chat = sqlx::query_as::<_, Chat>(&format!("SELECT {CHAT_COLS} FROM chats WHERE id = ?1"))
        .bind(chat_id)
        .fetch_optional(db)
        .await?;
    let Some(chat) = chat else { return Ok(()); }; // deleted out from under us

    // Subchats are an implementation detail (sub-agent transcripts), not
    // user-facing conversations — skip them from the mirror.
    if chat.initiated_by_zone_id.is_some() {
        return Ok(());
    }

    let messages = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE chat_id = ?1 AND zone_id IS NULL ORDER BY created_at ASC"
    ))
    .bind(chat_id)
    .fetch_all(db)
    .await?;

    let (zone_name, zone_model) = match &chat.zone_id {
        Some(zid) => sqlx::query_as::<_, (String, String)>("SELECT name, model FROM zones WHERE id = ?1")
            .bind(zid)
            .fetch_optional(db)
            .await?
            .map(|(n, m)| (Some(n), Some(m)))
            .unwrap_or((None, None)),
        None => (None, None),
    };

    let project_name: Option<String> = match &chat.project_id {
        Some(pid) => sqlx::query_scalar("SELECT name FROM projects WHERE id = ?1")
            .bind(pid)
            .fetch_optional(db)
            .await?,
        None => None,
    };

    let tags: Vec<String> = sqlx::query_scalar(
        "SELECT t.name FROM tags t JOIN chat_tags ct ON ct.tag_id = t.id WHERE ct.chat_id = ?1 ORDER BY t.name",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let zones_by_id: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM zones")
            .fetch_all(db)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect();

    let md = build_markdown(
        &chat,
        &messages,
        zone_name.as_deref(),
        zone_model.as_deref(),
        project_name.as_deref(),
        &tags,
        &zones_by_id,
    );

    write_chat_file(&cfg.dir, &chat.id, &slugify(&chat.title), &md)?;
    mirror_zones(db, &cfg.dir).await?;
    Ok(())
}

/// Write a chat's `.md`, removing any stale file for the same chat id first (so
/// a title change renames cleanly rather than leaving an orphan).
fn write_chat_file(dir: &Path, chat_id: &str, slug: &str, md: &str) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    let suffix = format!("--{chat_id}.md");
    let target = format!("{slug}--{chat_id}.md");
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(&suffix) && *name != *target {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let path = dir.join(target);
    // Record the content we're about to write so the watcher can tell our own
    // write apart from an external edit and skip the round-trip (0.7.2 two-way).
    note_written(&path, md);
    std::fs::write(path, md)?;
    Ok(())
}

/// Export every zone config as `zones/<zone_id>.json` alongside the chats.
async fn mirror_zones(db: &SqlitePool, dir: &Path) -> AppResult<()> {
    let zones = sqlx::query_as::<_, Zone>(&format!("SELECT {ZONE_COLS} FROM zones"))
        .fetch_all(db)
        .await?;
    let zdir = dir.join("zones");
    std::fs::create_dir_all(&zdir)?;
    for z in &zones {
        std::fs::write(zdir.join(format!("{}.json", z.id)), serde_json::to_string_pretty(z)?)?;
    }
    Ok(())
}

/// Remove a chat's mirrored `.md` (called when the chat is deleted).
pub async fn unmirror_chat_best_effort(db: &SqlitePool, chat_id: &str) {
    let Some(cfg) = read_config(db).await else { return; };
    let suffix = format!("--{chat_id}.md");
    if let Ok(rd) = std::fs::read_dir(&cfg.dir) {
        for entry in rd.flatten() {
            if entry.file_name().to_string_lossy().ends_with(&suffix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Re-mirror every chat (plus the zone exports). Invoked when the user turns
/// the feature on or changes the output directory, so existing chats are
/// written out immediately rather than only on their next message.
#[tauri::command]
pub async fn mirror_all_chats(state: State<'_, AppState>) -> AppResult<usize> {
    let Some(cfg) = read_config(&state.db).await else { return Ok(0); };
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM chats WHERE initiated_by_zone_id IS NULL ORDER BY created_at ASC",
    )
    .fetch_all(&state.db)
    .await?;
    for id in &ids {
        if let Err(e) = mirror_chat(&state.db, id).await {
            tracing::warn!("markdown mirror failed for chat {id}: {e}");
        }
    }
    mirror_zones(&state.db, &cfg.dir).await?;
    Ok(ids.len())
}

// ─── Import (read a `.md` chat file back into the DB) ─────────────────────────

/// Strip surrounding quotes from a frontmatter value (JSON-quoted by `yaml_quote`).
fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.starts_with('"') {
        if let Ok(s) = serde_json::from_str::<String>(v) {
            return s;
        }
    }
    v.to_string()
}

/// Parsed pieces of a mirrored markdown file.
struct ParsedChat {
    title: String,
    zone: Option<String>,
    project: Option<String>,
    messages: Vec<(String, String)>, // (role, text)
}

/// Parse a mirrored `.md` document: YAML frontmatter + `## Who · date` blocks.
/// Lenient — anything it can't read degrades to a sensible default.
fn parse_markdown(src: &str) -> ParsedChat {
    let lines: Vec<&str> = src.lines().collect();
    let mut title = String::new();
    let mut zone: Option<String> = None;
    let mut project: Option<String> = None;

    // Frontmatter: between the first two `---` fences.
    let mut idx = 0;
    if lines.first().map(|l| l.trim()) == Some("---") {
        idx = 1;
        while idx < lines.len() && lines[idx].trim() != "---" {
            if let Some((k, v)) = lines[idx].split_once(':') {
                let val = unquote(v);
                match k.trim() {
                    "title" => title = val,
                    "zone" => zone = Some(val).filter(|s| !s.is_empty()),
                    "project" => project = Some(val).filter(|s| !s.is_empty()),
                    _ => {}
                }
            }
            idx += 1;
        }
        idx += 1; // skip closing fence
    }

    // Body: collect `## ` blocks; the leading `# title` heading is ignored.
    let mut messages: Vec<(String, String)> = Vec::new();
    let mut cur_role: Option<String> = None;
    let mut buf: Vec<String> = Vec::new();

    let flush = |role: &Option<String>, buf: &mut Vec<String>, out: &mut Vec<(String, String)>| {
        if let Some(role) = role {
            let mut text = buf.join("\n").trim().to_string();
            // Drop a trailing "_N images attached_" note.
            if let Some(pos) = text.rfind("\n_") {
                if text[pos..].trim_start_matches('\n').starts_with("_") && text.trim_end().ends_with("attached_") {
                    text.truncate(pos);
                    text = text.trim_end().to_string();
                }
            }
            if !text.is_empty() {
                out.push((role.clone(), text));
            }
        }
        buf.clear();
    };

    while idx < lines.len() {
        let line = lines[idx];
        if let Some(rest) = line.strip_prefix("## ") {
            flush(&cur_role, &mut buf, &mut messages);
            let who = rest.split('·').next().unwrap_or("").trim();
            cur_role = Some(if who.eq_ignore_ascii_case("User") {
                "user".to_string()
            } else {
                "assistant".to_string()
            });
        } else if cur_role.is_some() {
            buf.push(line.to_string());
        }
        idx += 1;
    }
    flush(&cur_role, &mut buf, &mut messages);

    if title.is_empty() {
        title = "Imported chat".to_string();
    }
    ParsedChat { title, zone, project, messages }
}

/// Read a mirrored `.md` file from disk and insert it as a new chat (new id, so
/// it never clobbers an existing chat). The zone/project are matched by name
/// when present; messages are recreated as user/assistant text turns.
#[tauri::command]
pub async fn import_chat_from_markdown(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Chat> {
    let src = std::fs::read_to_string(&path)
        .map_err(|e| crate::error::AppError::Invalid(format!("read {path}: {e}")))?;
    let parsed = parse_markdown(&src);

    let zone_id: Option<String> = match &parsed.zone {
        Some(name) => sqlx::query_scalar("SELECT id FROM zones WHERE name = ?1 LIMIT 1")
            .bind(name)
            .fetch_optional(&state.db)
            .await?,
        None => None,
    };
    let project_id: Option<String> = match &parsed.project {
        Some(name) => sqlx::query_scalar("SELECT id FROM projects WHERE name = ?1 LIMIT 1")
            .bind(name)
            .fetch_optional(&state.db)
            .await?,
        None => None,
    };

    let chat_id = new_id();
    let now = now_ts();
    sqlx::query(
        "INSERT INTO chats (id, title, zone_id, project_id, project_context_enabled, knowledge_enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?5)",
    )
    .bind(&chat_id)
    .bind(&parsed.title)
    .bind(&zone_id)
    .bind(&project_id)
    .bind(now)
    .execute(&state.db)
    .await?;

    // Recreate messages in order, with monotonically increasing timestamps so
    // ordering is preserved even though the original per-message times aren't.
    for (i, (role, text)) in parsed.messages.iter().enumerate() {
        let content = serde_json::to_string(&vec![ContentPart::Text { text: text.clone() }])?;
        let ts = now + i as i64;
        let active_zone = if role == "assistant" { zone_id.as_deref() } else { None };
        sqlx::query(
            "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, ?5, ?6)",
        )
        .bind(new_id())
        .bind(&chat_id)
        .bind(role)
        .bind(&content)
        .bind(active_zone)
        .bind(ts)
        .execute(&state.db)
        .await?;
    }

    let chat = sqlx::query_as::<_, Chat>(&format!("SELECT {CHAT_COLS} FROM chats WHERE id = ?1"))
        .bind(&chat_id)
        .fetch_one(&state.db)
        .await?;

    // Reflect the freshly-imported chat into the mirror dir too (best-effort).
    mirror_chat_best_effort(&state.db, &chat_id).await;
    Ok(chat)
}

// ─── Two-way sync: watch the mirror folder, pull external edits into the DB ───
//
// The DB stays canonical; the markdown files are an editable synced copy. When
// the user edits a mirrored `.md` in their editor, the watcher parses it and
// syncs the change back into the DB. To avoid a feedback loop, every file we
// write records its content hash (`note_written`); the watcher ignores a change
// whose content matches what we last wrote. Sync is deliberately conservative —
// the title and same-shape message-text edits flow back losslessly; structural
// rewrites (adding/removing turns, which markdown can't represent unambiguously
// against interleaved tool/perspective turns) are left for the DB to own.

/// Content hashes of files we wrote, so the watcher can skip its own echoes.
fn last_written() -> &'static std::sync::Mutex<HashMap<PathBuf, u64>> {
    static LAST_WRITTEN: OnceLock<std::sync::Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
    LAST_WRITTEN.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn content_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn note_written(path: &Path, content: &str) {
    if let Ok(mut m) = last_written().lock() {
        m.insert(path.to_path_buf(), content_hash(content));
    }
}

/// True when `content` at `path` matches what we last wrote there (our own echo).
fn was_our_write(path: &Path, content: &str) -> bool {
    last_written()
        .lock()
        .ok()
        .and_then(|m| m.get(path).copied())
        == Some(content_hash(content))
}

const DEBOUNCE: Duration = Duration::from_secs(1);

/// Process-global watcher over the mirror directory. Initialised once at
/// startup; `resync` (re)builds the watch from current config.
pub struct MirrorWatcher {
    db: SqlitePool,
    app: AppHandle,
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

static WATCHER: OnceLock<MirrorWatcher> = OnceLock::new();

pub fn init(db: SqlitePool, app: AppHandle) {
    let _ = WATCHER.set(MirrorWatcher { db, app, debouncer: Mutex::new(None) });
}

/// (Re)build the watch from current config: watch the mirror directory when the
/// feature is on, otherwise drop the watch. Called at startup and whenever
/// `app_settings` changes. No-op if the watcher isn't initialised.
pub async fn resync() {
    if let Some(w) = WATCHER.get() {
        w.resync().await;
    }
}

impl MirrorWatcher {
    async fn resync(&self) {
        let cfg = read_config(&self.db).await;
        let Some(cfg) = cfg else {
            *self.debouncer.lock().await = None; // feature off — stop watching
            return;
        };
        if std::fs::create_dir_all(&cfg.dir).is_err() {
            return;
        }

        let db = self.db.clone();
        let app = self.app.clone();
        let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let paths: Vec<PathBuf> = match res {
                Ok(events) => events.into_iter().map(|e| e.path).collect(),
                Err(_) => return,
            };
            let db = db.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                for path in paths {
                    sync_file_into_db(&db, &app, &path).await;
                }
            });
        });

        match debouncer {
            Ok(mut d) => {
                // Non-recursive: only top-level chat `.md` files matter; the
                // `zones/` JSON exports are write-only and shouldn't trigger syncs.
                if let Err(e) = d.watcher().watch(&cfg.dir, RecursiveMode::NonRecursive) {
                    tracing::warn!("mirror watch failed for {}: {e}", cfg.dir.display());
                }
                *self.debouncer.lock().await = Some(d);
            }
            Err(e) => tracing::warn!("mirror debouncer init failed: {e}"),
        }
    }
}

/// Handle one changed path: if it's a managed chat `.md` that was edited
/// externally, pull the change into the DB.
async fn sync_file_into_db(db: &SqlitePool, app: &AppHandle, path: &Path) {
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return; // deleted/locked — leave the DB as the source of truth
    };
    if was_our_write(path, &content) {
        return; // our own mirror write echoing back
    }

    let parsed = parse_markdown(&content);
    // Only files we manage (with a chat_id in frontmatter) are synced; loose
    // markdown is brought in via the explicit "Import from markdown" action.
    let Some(chat_id) = frontmatter_chat_id(&content) else { return };

    match sync_chat_from_parsed(db, &chat_id, &parsed).await {
        Ok(true) => {
            // Record the now-current content so a duplicate event is a no-op.
            note_written(path, &content);
            let _ = app.emit("chat-file-synced", serde_json::json!({ "chatId": chat_id }));
        }
        Ok(false) => {}
        Err(e) => tracing::warn!("mirror sync of {} failed: {e}", path.display()),
    }
}

/// Pull `chat_id` from a document's frontmatter, if present.
fn frontmatter_chat_id(src: &str) -> Option<String> {
    let mut lines = src.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim() == "chat_id" {
                let id = unquote(v);
                return Some(id).filter(|s| !s.is_empty());
            }
        }
    }
    None
}

/// Apply an external edit to an existing chat. Returns whether anything changed.
/// Conservative: updates the title, and updates message text in place only when
/// the file's visible blocks line up one-to-one (same count + roles) with the
/// chat's visible turns — so typo fixes flow back without disturbing tool or
/// perspective turns that markdown can't represent.
async fn sync_chat_from_parsed(
    db: &SqlitePool,
    chat_id: &str,
    parsed: &ParsedChat,
) -> AppResult<bool> {
    let Some(current_title): Option<String> =
        sqlx::query_scalar("SELECT title FROM chats WHERE id = ?1")
            .bind(chat_id)
            .fetch_optional(db)
            .await?
    else {
        return Ok(false); // chat no longer exists
    };

    let mut changed = false;
    let now = now_ts();

    if !parsed.title.is_empty() && parsed.title != current_title {
        sqlx::query("UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(&parsed.title)
            .bind(now)
            .bind(chat_id)
            .execute(db)
            .await?;
        changed = true;
    }

    // The chat's visible primary turns, in order — the same set the mirror
    // renders to markdown blocks.
    let primary = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE chat_id = ?1 AND zone_id IS NULL ORDER BY created_at ASC"
    ))
    .bind(chat_id)
    .fetch_all(db)
    .await?;
    let visible: Vec<&Message> = primary
        .iter()
        .filter(|m| {
            (m.role == "user" || m.role == "assistant")
                && (!visible_text(&m.content).is_empty() || image_count(&m.content) > 0)
        })
        .collect();

    // Only sync message text when the shapes match exactly; otherwise the edit
    // is structural and the DB keeps ownership.
    if visible.len() == parsed.messages.len()
        && visible
            .iter()
            .zip(&parsed.messages)
            .all(|(m, (role, _))| &m.role == role)
    {
        for (m, (_, text)) in visible.iter().zip(&parsed.messages) {
            if visible_text(&m.content).trim() != text.trim() {
                let content = serde_json::to_string(&vec![ContentPart::Text { text: text.clone() }])?;
                sqlx::query("UPDATE messages SET content = ?1, edited = 1 WHERE id = ?2")
                    .bind(&content)
                    .bind(&m.id)
                    .execute(db)
                    .await?;
                changed = true;
            }
        }
    }

    if changed {
        sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
            .bind(now)
            .bind(chat_id)
            .execute(db)
            .await?;
    }
    Ok(changed)
}
