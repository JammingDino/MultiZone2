//! Chat locks (0.20.0): a chat that needs a password before it is shown.
//!
//! This is a lock, not encryption. The database on disk holds the transcript in
//! the clear, as it always has; what a lock changes is what the app will hand
//! out. The window shows an unlock screen instead of the transcript, and every
//! path that would read the chat back out — the API, search, export, the
//! markdown mirror, another chat's tools, a scheduled run — refuses or leaves
//! it out while it is locked.
//!
//! A lock covers the chat's branches and sub-agent chats too, by walking
//! `parent_chat_id`: a branch holds a copy of the parent's history and a
//! sub-agent's brief is often the parent's words, so locking only the one row
//! would leave the same text a click away.
//!
//! Two kinds:
//! - `chat` — its own password, hashed into `chats.lock_hash`.
//! - `app` — the one app password (`app_lock`), shared by every such chat.
//!
//! The app password also opens a `chat`-kind lock, which is the whole recovery
//! story for a forgotten per-chat password. With no app password set, a
//! forgotten one cannot be recovered from the app; the chat can still be
//! deleted.
//!
//! Agents may *lock* (`POST /api/chats/:id/lock`, app password only) and
//! nothing else: unlocking, removing a lock, and setting or changing a password
//! are Tauri commands with no route, and `app_control` refuses those paths by
//! name besides.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

/// PBKDF2-HMAC-SHA256 rounds — OWASP's 2023 figure. Stored in the hash, so
/// raising it later only affects new passwords.
const ITERATIONS: u32 = 600_000;
const SCHEME: &str = "pbkdf2-sha256";

pub const KIND_CHAT: &str = "chat";
pub const KIND_APP: &str = "app";

pub const LOCKED_MESSAGE: &str =
    "this chat is locked; it can only be opened in the MultiZone window, with its password";

// ─── Hashing ──────────────────────────────────────────────────────────────────

/// PBKDF2 with a single 32-byte block (RFC 8018 §5.2), which is all a
/// SHA-256-sized key needs. Written out rather than pulling in the `pbkdf2`
/// crate: it is the loop below, over the `hmac` and `sha2` already in the tree.
fn derive(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let keyed = Hmac::<Sha256>::new_from_slice(password).expect("HMAC takes a key of any length");
    let mut mac = keyed.clone();
    mac.update(salt);
    mac.update(&1u32.to_be_bytes());
    let mut u: [u8; 32] = mac.finalize().into_bytes().into();
    let mut out = u;
    for _ in 1..iterations {
        let mut mac = keyed.clone();
        mac.update(&u);
        u = mac.finalize().into_bytes().into();
        for (o, x) in out.iter_mut().zip(u.iter()) {
            *o ^= x;
        }
    }
    out
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD_NO_PAD
}

fn hash_with(password: &str, iterations: u32) -> String {
    let salt: [u8; 16] = rand::random();
    let key = derive(password.as_bytes(), &salt, iterations);
    format!("{SCHEME}${iterations}${}${}", b64().encode(salt), b64().encode(key))
}

/// A salted, slow hash of `password`, self-describing:
/// `pbkdf2-sha256$<iterations>$<salt>$<key>`.
pub fn hash_password(password: &str) -> String {
    hash_with(password, ITERATIONS)
}

/// Whether `password` matches `stored`. Anything malformed is a mismatch.
pub fn verify_password(password: &str, stored: &str) -> bool {
    let mut parts = stored.split('$');
    let (Some(SCHEME), Some(iters), Some(salt), Some(key), None) =
        (parts.next(), parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let (Ok(iters), Ok(salt), Ok(key)) =
        (iters.parse::<u32>(), b64().decode(salt), b64().decode(key))
    else {
        return false;
    };
    if iters == 0 || key.len() != 32 {
        return false;
    }
    let got = derive(password.as_bytes(), &salt, iters);
    // Constant time: every byte is compared whatever the first difference.
    got.iter().zip(key.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

// ─── Session unlocks ──────────────────────────────────────────────────────────

/// Lock roots the user has unlocked since the app started. In memory only, so
/// a restart locks everything again; "Lock now" takes one out early.
fn unlocked() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

pub fn is_unlocked(root: &str) -> bool {
    unlocked().lock().map(|s| s.contains(root)).unwrap_or(false)
}

fn set_unlocked(root: &str, open: bool) {
    if let Ok(mut s) = unlocked().lock() {
        if open {
            s.insert(root.to_string());
        } else {
            s.remove(root);
        }
    }
}

// ─── Which chats are locked ───────────────────────────────────────────────────

/// Every chat under a lock, paired with the chat whose lock covers it (itself,
/// or the nearest locked ancestor). A CTE so search can use it inside its own
/// query rather than filtering after its LIMIT.
pub const LOCKED_CTE: &str = "WITH RECURSIVE locked(id, root) AS (
       SELECT id, id FROM chats WHERE lock_kind IS NOT NULL
       UNION
       SELECT c.id, l.root FROM chats c JOIN locked l ON c.parent_chat_id = l.id
        WHERE c.lock_kind IS NULL
     )";

/// chat id → the lock root covering it, for every locked chat.
pub async fn locked_chats(db: &SqlitePool) -> Result<HashMap<String, String>, sqlx::Error> {
    let rows: Vec<(String, String)> =
        sqlx::query_as(&format!("{LOCKED_CTE} SELECT id, root FROM locked"))
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

/// The chat whose lock covers `chat_id` — itself or its nearest locked
/// ancestor — or `None` when nothing does.
pub async fn lock_root(db: &SqlitePool, chat_id: &str) -> Result<Option<String>, sqlx::Error> {
    // Bounded depth, so a parent cycle (which nothing should create) cannot spin.
    sqlx::query_scalar(
        "WITH RECURSIVE up(id, parent, kind, depth) AS (
           SELECT id, parent_chat_id, lock_kind, 0 FROM chats WHERE id = ?1
           UNION ALL
           SELECT c.id, c.parent_chat_id, c.lock_kind, up.depth + 1
             FROM chats c JOIN up ON c.id = up.parent
            WHERE up.kind IS NULL AND up.depth < 64
         )
         SELECT id FROM up WHERE kind IS NOT NULL LIMIT 1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await
}

/// For the window's own reads and for turns: refuse unless the chat is unlocked
/// for this session (or not locked at all).
pub async fn ensure_open(db: &SqlitePool, chat_id: &str) -> AppResult<()> {
    match lock_root(db, chat_id).await? {
        Some(root) if !is_unlocked(&root) => Err(AppError::Invalid(LOCKED_MESSAGE.into())),
        _ => Ok(()),
    }
}

/// For a tool or job reaching into `target` from `from` (a chat's turn, or
/// `None` for something unattended): a locked target is reachable only from
/// inside the same unlocked lock — the chat's own turn reading its own
/// sub-agents — never from another chat, even while the user has it open.
pub async fn ensure_reachable(db: &SqlitePool, from: Option<&str>, target: &str) -> AppResult<()> {
    let Some(root) = lock_root(db, target).await? else { return Ok(()) };
    let from_root = match from {
        Some(f) => lock_root(db, f).await?,
        None => None,
    };
    if from_root.as_deref() == Some(root.as_str()) && is_unlocked(&root) {
        Ok(())
    } else {
        Err(AppError::Invalid(LOCKED_MESSAGE.into()))
    }
}

/// Blank what a chat row says about its contents (the compaction summary) for
/// every chat under a lock — unless `session` and the user has it open.
pub async fn redact(db: &SqlitePool, chats: &mut [crate::db::models::Chat], session: bool) -> AppResult<()> {
    let locked = locked_chats(db).await?;
    for c in chats.iter_mut() {
        if let Some(root) = locked.get(&c.id) {
            if !(session && is_unlocked(root)) {
                c.context_summary = None;
            }
        }
    }
    Ok(())
}

// ─── Changing locks ───────────────────────────────────────────────────────────

async fn app_hash(db: &SqlitePool) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT hash FROM app_lock WHERE id = 1").fetch_optional(db).await
}

async fn chat_lock(db: &SqlitePool, chat_id: &str) -> AppResult<(Option<String>, Option<String>)> {
    sqlx::query_as("SELECT lock_kind, lock_hash FROM chats WHERE id = ?1")
        .bind(chat_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("chat {chat_id}")))
}

/// Whether `password` opens this chat's own lock. The app password opens a
/// per-chat lock too — that is how a forgotten one is recovered.
async fn password_opens(db: &SqlitePool, chat_id: &str, password: &str) -> AppResult<bool> {
    let (kind, hash) = chat_lock(db, chat_id).await?;
    if kind.is_none() {
        return Ok(true);
    }
    if kind.as_deref() == Some(KIND_CHAT) && hash.as_deref().is_some_and(|h| verify_password(password, h)) {
        return Ok(true);
    }
    Ok(app_hash(db).await?.is_some_and(|h| verify_password(password, &h)))
}

fn notify(app: &AppHandle) {
    let _ = app.emit("chats-changed", serde_json::json!({}));
}

/// Lock with the app password, or re-lock now if already locked. The only lock
/// operation the API has, so it takes no password: it cannot set one.
pub async fn lock_with_app_password(db: &SqlitePool, chat_id: &str) -> AppResult<()> {
    let (kind, _) = chat_lock(db, chat_id).await?;
    if kind.is_none() {
        if app_hash(db).await?.is_none() {
            return Err(AppError::Invalid(
                "no app password is set; the user sets one in Settings → Data → Chat locks".into(),
            ));
        }
        sqlx::query("UPDATE chats SET lock_kind = ?1, lock_hash = NULL WHERE id = ?2")
            .bind(KIND_APP)
            .bind(chat_id)
            .execute(db)
            .await?;
    }
    after_lock(db, chat_id).await;
    Ok(())
}

/// Close the session and take the chat (and its branches) off the mirror's
/// disk, which is plain text in a folder the user may sync somewhere.
async fn after_lock(db: &SqlitePool, chat_id: &str) {
    set_unlocked(chat_id, false);
    if let Ok(locked) = locked_chats(db).await {
        for (id, root) in locked {
            if root == chat_id {
                crate::commands::mirror::unmirror_chat_best_effort(db, &id).await;
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    pub app_password_set: bool,
    /// Lock roots open in this session, so a reloaded window agrees with us.
    pub unlocked: Vec<String>,
}

#[tauri::command]
pub async fn chat_lock_status(state: State<'_, AppState>) -> AppResult<LockStatus> {
    let unlocked = unlocked().lock().map(|s| s.iter().cloned().collect()).unwrap_or_default();
    Ok(LockStatus { app_password_set: app_hash(&state.db).await?.is_some(), unlocked })
}

/// Lock a chat: with its own `password`, or with the app password when none is
/// given. Changing an existing lock needs the chat open first.
#[tauri::command]
pub async fn lock_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    password: Option<String>,
) -> AppResult<()> {
    let db = &state.db;
    let (kind, _) = chat_lock(db, &chat_id).await?;
    if kind.is_some() && !is_unlocked(&chat_id) {
        return Err(AppError::Invalid("unlock the chat before changing its lock".into()));
    }
    match password.filter(|p| !p.is_empty()) {
        Some(pw) => {
            sqlx::query("UPDATE chats SET lock_kind = ?1, lock_hash = ?2 WHERE id = ?3")
                .bind(KIND_CHAT)
                .bind(hash_password(&pw))
                .bind(&chat_id)
                .execute(db)
                .await?;
            after_lock(db, &chat_id).await;
        }
        None => {
            if kind.is_some() {
                // Switching a per-chat lock over to the app password.
                sqlx::query("UPDATE chats SET lock_kind = NULL, lock_hash = NULL WHERE id = ?1")
                    .bind(&chat_id)
                    .execute(db)
                    .await?;
            }
            lock_with_app_password(db, &chat_id).await?;
        }
    }
    notify(&app);
    Ok(())
}

/// Open a locked chat for this session. `false` for a wrong password.
#[tauri::command]
pub async fn unlock_chat(state: State<'_, AppState>, chat_id: String, password: String) -> AppResult<bool> {
    let ok = password_opens(&state.db, &chat_id, &password).await?;
    if ok {
        set_unlocked(&chat_id, true);
    }
    Ok(ok)
}

/// "Lock now": close the session early. Changes nothing stored.
#[tauri::command]
pub async fn relock_chat(chat_id: String) -> AppResult<()> {
    set_unlocked(&chat_id, false);
    Ok(())
}

/// Remove a chat's lock for good. Needs the password again, not just an open
/// session, so a window left unlocked cannot be stripped of its lock.
#[tauri::command]
pub async fn remove_chat_lock(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    password: String,
) -> AppResult<bool> {
    if !password_opens(&state.db, &chat_id, &password).await? {
        return Ok(false);
    }
    sqlx::query("UPDATE chats SET lock_kind = NULL, lock_hash = NULL WHERE id = ?1")
        .bind(&chat_id)
        .execute(&state.db)
        .await?;
    set_unlocked(&chat_id, false);
    crate::commands::mirror::mirror_chat_best_effort(&state.db, &chat_id).await;
    notify(&app);
    Ok(true)
}

/// Set, change (`current` + `new`) or remove (`new` = None) the app password.
/// Removing it is refused while chats still use it — they would be unopenable.
#[tauri::command]
pub async fn set_app_lock_password(
    state: State<'_, AppState>,
    current: Option<String>,
    new: Option<String>,
) -> AppResult<()> {
    let db = &state.db;
    if let Some(h) = app_hash(db).await? {
        if !current.as_deref().is_some_and(|c| verify_password(c, &h)) {
            return Err(AppError::Invalid("the current app password is wrong".into()));
        }
    }
    match new.filter(|p| !p.is_empty()) {
        Some(pw) => {
            sqlx::query("INSERT INTO app_lock (id, hash) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash")
                .bind(hash_password(&pw))
                .execute(db)
                .await?;
        }
        None => {
            let using: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chats WHERE lock_kind = ?1")
                .bind(KIND_APP)
                .fetch_one(db)
                .await?;
            if using > 0 {
                let (s, verb) = if using == 1 { ("", "uses") } else { ("s", "use") };
                return Err(AppError::Invalid(format!(
                    "{using} locked chat{s} {verb} the app password; remove their locks first"
                )));
            }
            sqlx::query("DELETE FROM app_lock").execute(db).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub mod tests_support {
    /// Stand in for a successful `unlock_chat` without a password round.
    pub fn open_session(root: &str) {
        super::set_unlocked(root, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::MIGRATOR.run(&pool).await.unwrap();
        for (id, parent) in [("a", None), ("a-branch", Some("a")), ("a-sub", Some("a-branch")), ("b", None)] {
            sqlx::query("INSERT INTO chats (id, title, parent_chat_id, created_at, updated_at) VALUES (?1, ?1, ?2, 0, 0)")
                .bind(id)
                .bind(parent)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    #[test]
    fn a_password_verifies_and_a_wrong_one_does_not() {
        let h = hash_with("correct horse", 1_000);
        assert!(h.starts_with("pbkdf2-sha256$1000$"));
        assert!(verify_password("correct horse", &h));
        assert!(!verify_password("correct hors", &h));
        assert!(!verify_password("", &h));
        // Salted: the same password never hashes the same way twice.
        assert_ne!(h, hash_with("correct horse", 1_000));
        // Malformed or foreign hashes are a mismatch, never a panic.
        for bad in ["", "plain", "pbkdf2-sha256$0$AAAA$AAAA", "md5$1$a$b", &format!("{h}$extra")] {
            assert!(!verify_password("correct horse", bad), "{bad}");
        }
        assert!(hash_password("x").starts_with(&format!("{SCHEME}${ITERATIONS}$")));
    }

    /// RFC 7914 §11's PBKDF2-HMAC-SHA256 vector (P="passwd", S="salt", c=1),
    /// so `derive` is PBKDF2 and not merely self-consistent.
    #[test]
    fn derive_matches_the_published_vector() {
        let got = derive(b"passwd", b"salt", 1);
        let want = [
            0x55, 0xac, 0x04, 0x6e, 0x56, 0xe3, 0x08, 0x9f, 0xec, 0x16, 0x91, 0xc2, 0x25, 0x44, 0xb6, 0x05,
            0xf9, 0x41, 0x85, 0x21, 0x6d, 0xde, 0x04, 0x65, 0xe6, 0x8b, 0x9d, 0x57, 0xc2, 0x0d, 0xac, 0xbc,
        ];
        assert_eq!(got, want);
    }

    #[tokio::test]
    async fn a_lock_covers_branches_and_sub_agents_and_nothing_else() {
        let db = pool().await;
        sqlx::query("UPDATE chats SET lock_kind = 'app' WHERE id = 'a'").execute(&db).await.unwrap();
        assert_eq!(lock_root(&db, "a-sub").await.unwrap().as_deref(), Some("a"));
        assert_eq!(lock_root(&db, "b").await.unwrap(), None);
        let all = locked_chats(&db).await.unwrap();
        assert_eq!(all.len(), 3);
        assert!(!all.contains_key("b"));

        // Locked → closed to the window, to the chat's own tools, and to others.
        assert!(ensure_open(&db, "a-sub").await.is_err());
        assert!(ensure_reachable(&db, Some("a"), "a-sub").await.is_err());
        set_unlocked("a", true);
        assert!(ensure_open(&db, "a-branch").await.is_ok());
        // Open: the chat's own turn reaches its sub-agents; another chat and an
        // unattended job still do not.
        assert!(ensure_reachable(&db, Some("a"), "a-sub").await.is_ok());
        assert!(ensure_reachable(&db, Some("b"), "a-sub").await.is_err());
        assert!(ensure_reachable(&db, None, "a").await.is_err());
        assert!(ensure_reachable(&db, None, "b").await.is_ok());
        set_unlocked("a", false);
        assert!(ensure_open(&db, "a").await.is_err());
    }

    #[tokio::test]
    async fn agents_lock_only_with_an_app_password_and_the_app_password_recovers() {
        let db = pool().await;
        // No app password yet: the agent-facing lock refuses rather than
        // leaving a chat nobody can open.
        assert!(lock_with_app_password(&db, "b").await.is_err());
        sqlx::query("INSERT INTO app_lock (id, hash) VALUES (1, ?1)")
            .bind(hash_with("app-pw", 1_000))
            .execute(&db)
            .await
            .unwrap();
        lock_with_app_password(&db, "b").await.unwrap();
        assert_eq!(chat_lock(&db, "b").await.unwrap().0.as_deref(), Some(KIND_APP));

        // A per-chat lock opens with its own password or with the app password.
        sqlx::query("UPDATE chats SET lock_kind = 'chat', lock_hash = ?1 WHERE id = 'a'")
            .bind(hash_with("chat-pw", 1_000))
            .execute(&db)
            .await
            .unwrap();
        assert!(password_opens(&db, "a", "chat-pw").await.unwrap());
        assert!(password_opens(&db, "a", "app-pw").await.unwrap());
        assert!(!password_opens(&db, "a", "guess").await.unwrap());
        assert!(!password_opens(&db, "b", "chat-pw").await.unwrap());
    }

    /// Search leaves locked chats out inside the query, before its LIMIT.
    #[tokio::test]
    async fn search_leaves_locked_chats_out() {
        let db = pool().await;
        for (id, chat) in [("m1", "a-sub"), ("m2", "b")] {
            sqlx::query("INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?1, ?2, 'user', ?3, 0)")
                .bind(id)
                .bind(chat)
                .bind(serde_json::json!([{ "type": "text", "text": "colorsteel roof" }]).to_string())
                .execute(&db)
                .await
                .unwrap();
        }
        assert_eq!(crate::search::search_messages(&db, "colorsteel").await.unwrap().len(), 2);
        sqlx::query("UPDATE chats SET lock_kind = 'app' WHERE id = 'a'").execute(&db).await.unwrap();
        let hits = crate::search::search_messages(&db, "colorsteel").await.unwrap();
        assert_eq!(hits.iter().map(|h| h.chat_id.as_str()).collect::<Vec<_>>(), ["b"]);
    }
}
