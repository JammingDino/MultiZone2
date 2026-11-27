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
//! nothing else: removing a lock and setting or changing a password are Tauri
//! commands with no route, and `app_control` refuses those paths by name
//! besides.
//!
//! An unlock belongs to whoever typed the password (0.21): the window, one
//! paired device, or one browser tab on this machine — see [`Holder`]. The
//! phone unlocking a chat opens it on the phone and nowhere else. The static
//! API token (scripts, and `app_control` in-process) holds none and cannot get
//! one: it is shared by everything on this machine that can read the setting,
//! so it is not anybody in particular. Every unlock closes again after the idle
//! time (`chatLockIdleMinutes`), when the window is hidden to the tray, and
//! when the app restarts.

use crate::error::{AppError, AppResult};
use crate::remote::DeviceAuth;
use crate::state::AppState;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// PBKDF2-HMAC-SHA256 rounds — OWASP's 2023 figure. Stored in the hash, so
/// raising it later only affects new passwords.
const ITERATIONS: u32 = 600_000;
const SCHEME: &str = "pbkdf2-sha256";

pub const KIND_CHAT: &str = "chat";
pub const KIND_APP: &str = "app";

pub const LOCKED_MESSAGE: &str =
    "this chat is locked; it opens only where its password is typed — the MultiZone window, or a paired device or browser tab for itself";

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

// ─── Who holds an unlock ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Holder {
    /// The desktop window, over IPC.
    Window,
    /// A paired phone or tablet, by device id.
    Device(String),
    /// A browser tab on this machine (`remote::local`), by session.
    Browser(String),
    /// The static API token — scripts, and `app_control` from inside a turn.
    /// Never holds an unlock.
    Nobody,
}

impl Holder {
    /// Who an API request is, from what the auth layer recorded.
    pub fn of(auth: Option<&DeviceAuth>) -> Holder {
        match auth {
            Some(DeviceAuth::Device(d)) => Holder::Device(d.id.clone()),
            Some(DeviceAuth::LocalBrowser(session)) => Holder::Browser(session.clone()),
            _ => Holder::Nobody,
        }
    }

    fn remote(&self) -> bool {
        matches!(self, Holder::Device(_) | Holder::Browser(_))
    }
}

tokio::task_local! {
    static HOLDER: Holder;
}

/// Whose unlocks apply to the code running now. The API's lock layer sets it
/// for every request; anything outside a request is the window's own IPC or
/// work the window started. A task that loses the scope falls back to the
/// window, which only ever grants what the window already has, and only to
/// code that already passed a check inside the same lock (see
/// [`ensure_reachable`]).
pub fn current_holder() -> Holder {
    HOLDER.try_with(Clone::clone).unwrap_or(Holder::Window)
}

pub fn as_holder<F: Future>(holder: Holder, fut: F) -> impl Future<Output = F::Output> {
    HOLDER.scope(holder, fut)
}

/// `fut`, run as whoever is running now — for a `tokio::spawn` inside a turn
/// or a request, which would otherwise start a task without the scope.
pub fn carry<F: Future>(fut: F) -> impl Future<Output = F::Output> {
    as_holder(current_holder(), fut)
}

// ─── Session unlocks ──────────────────────────────────────────────────────────

struct Session {
    roots: HashSet<String>,
    active: Instant,
}

/// Lock roots each holder has unlocked since the app started. In memory only,
/// so a restart locks everything again. `now` and the idle limit are passed in
/// so expiry is testable without sleeping.
#[derive(Default)]
struct Sessions {
    by: HashMap<Holder, Session>,
}

impl Sessions {
    fn expire(&mut self, h: &Holder, now: Instant, idle: Option<Duration>) {
        if let (Some(limit), Some(s)) = (idle, self.by.get(h)) {
            if now.duration_since(s.active) >= limit {
                self.by.remove(h);
            }
        }
    }

    fn open(&mut self, h: &Holder, root: &str, now: Instant) {
        if *h == Holder::Nobody {
            return;
        }
        let s = self.by.entry(h.clone()).or_insert_with(|| Session { roots: HashSet::new(), active: now });
        s.roots.insert(root.to_string());
        s.active = now;
    }

    fn is_open(&mut self, h: &Holder, root: &str, now: Instant, idle: Option<Duration>) -> bool {
        self.expire(h, now, idle);
        *h != Holder::Nobody && self.by.get(h).is_some_and(|s| s.roots.contains(root))
    }

    fn roots(&mut self, h: &Holder, now: Instant, idle: Option<Duration>) -> Vec<String> {
        self.expire(h, now, idle);
        self.by.get(h).map(|s| s.roots.iter().cloned().collect()).unwrap_or_default()
    }

    /// Activity keeps a holder's unlocks open — unless they have already gone.
    fn touch(&mut self, h: &Holder, now: Instant, idle: Option<Duration>) {
        self.expire(h, now, idle);
        if let Some(s) = self.by.get_mut(h) {
            s.active = now;
        }
    }

    /// Close one lock for every holder.
    fn close_root(&mut self, root: &str) {
        for s in self.by.values_mut() {
            s.roots.remove(root);
        }
    }

    /// Close everything one holder has open. Whether it had anything.
    fn close_holder(&mut self, h: &Holder) -> bool {
        self.by.remove(h).is_some_and(|s| !s.roots.is_empty())
    }
}

fn sessions<T>(f: impl FnOnce(&mut Sessions) -> T) -> T {
    static S: OnceLock<Mutex<Sessions>> = OnceLock::new();
    let mut guard = S.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
    f(&mut guard)
}

pub fn is_unlocked_for(h: &Holder, root: &str) -> bool {
    sessions(|s| s.is_open(h, root, Instant::now(), backstop()))
}

/// Unlocked for whoever is running now — see [`current_holder`].
pub fn is_unlocked(root: &str) -> bool {
    is_unlocked_for(&current_holder(), root)
}

/// Close `root` everywhere: locking, "Lock now" and removing a lock are about
/// the chat, not one screen.
fn close_everywhere(root: &str) {
    sessions(|s| s.close_root(root));
    LOCK_GEN.fetch_add(1, Ordering::Relaxed);
}

/// Bumped whenever which chats are locked changes, so a cache of lock roots
/// (the event stream's, [`StreamGate`]) knows to start again.
static LOCK_GEN: AtomicU64 = AtomicU64::new(0);

// ─── Idle relock ──────────────────────────────────────────────────────────────

/// `app_settings` key: minutes without the holder's own activity before its
/// unlocks close again; 0 is never. 15 by default: the 0.20 unlock lasted until
/// restart, which on a machine left on for weeks is the same as no lock, and
/// fifteen minutes is the order of an OS screen lock or a password manager's.
pub const IDLE_KEY: &str = "chatLockIdleMinutes";
pub const DEFAULT_IDLE_MINUTES: u32 = 15;
const MAX_IDLE_MINUTES: u64 = 24 * 60;

/// The window and the phone close their own unlocks on time (they see the
/// keyboard); this is the backstop for one that cannot — a page frozen in a
/// pocket, or one that stopped reporting — so it is a minute later than theirs,
/// and their throttled activity reports always land inside it.
const BACKSTOP_GRACE: Duration = Duration::from_secs(60);

static IDLE_MINUTES: AtomicU32 = AtomicU32::new(DEFAULT_IDLE_MINUTES);

/// The setting as stored. Anything other than a whole number of minutes in
/// range reads as the default — the same reading as the window's `idleMinutes`.
pub fn idle_minutes(app_settings: &Value) -> u32 {
    match app_settings.get(IDLE_KEY) {
        None => DEFAULT_IDLE_MINUTES,
        Some(v) => v.as_u64().filter(|m| *m <= MAX_IDLE_MINUTES).map(|m| m as u32).unwrap_or(DEFAULT_IDLE_MINUTES),
    }
}

fn backstop() -> Option<Duration> {
    match IDLE_MINUTES.load(Ordering::Relaxed) {
        0 => None,
        m => Some(Duration::from_secs(u64::from(m) * 60) + BACKSTOP_GRACE),
    }
}

/// Re-read the idle time from `app_settings` (at launch, and on every write).
pub async fn sync_idle(db: &SqlitePool) {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    let v = raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    IDLE_MINUTES.store(idle_minutes(&v), Ordering::Relaxed);
}

/// What `app_control` may do to the idle time: shorten it or switch it on,
/// never lengthen it or switch it off. A model told to "stop the chats locking
/// on me" is the one caller that must not be able to, by the same rule that
/// lets it lock a chat and never open one. `requested` is the value the write
/// would leave (None: the field is gone, which reads as the default).
pub fn agent_may_set_idle(requested: Option<&Value>) -> Result<(), String> {
    let current = IDLE_MINUTES.load(Ordering::Relaxed);
    let new = match requested {
        None => DEFAULT_IDLE_MINUTES,
        Some(v) => v.as_u64().filter(|m| *m <= MAX_IDLE_MINUTES).map(|m| m as u32).ok_or_else(|| {
            format!("{IDLE_KEY} is a whole number of minutes, 1 to {MAX_IDLE_MINUTES}, or 0 for never")
        })?,
    };
    agent_idle_change(current, new)
}

fn agent_idle_change(current: u32, new: u32) -> Result<(), String> {
    let strictness = |m: u32| if m == 0 { u32::MAX } else { m };
    if strictness(new) > strictness(current) {
        let say = |m: u32| if m == 0 { "never".to_string() } else { format!("{m} min") };
        return Err(format!(
            "an agent may make chat locks close sooner, never later: {IDLE_KEY} is {} and this would make it {}. \
             Only the user lengthens it or turns it off, in Settings → Data → Chat locks",
            say(current),
            say(new),
        ));
    }
    Ok(())
}

/// The window went to the tray: whoever walks up to the machine next should
/// meet the lock. Not when the user switched relocking off.
pub fn window_hidden(app: &AppHandle) {
    if IDLE_MINUTES.load(Ordering::Relaxed) != 0 && sessions(|s| s.close_holder(&Holder::Window)) {
        let _ = app.emit("chats-changed", serde_json::json!({}));
    }
}

// ─── Wrong passwords ──────────────────────────────────────────────────────────

/// Tries before the waits start, per device and across all of them. A paired
/// device can pair another (and so get a fresh count), which is what the
/// shared count is for.
const FREE_TRIES: u32 = 5;
const FREE_TRIES_ALL: u32 = 20;
/// A count with no new failure for this long starts again.
const FORGET_AFTER: Duration = Duration::from_secs(60 * 60);

#[derive(Default)]
struct Tries {
    failures: u32,
    last: Option<Instant>,
    until: Option<Instant>,
}

impl Tries {
    fn wait(&self, now: Instant) -> Option<Duration> {
        self.until.map(|u| u.saturating_duration_since(now)).filter(|d| !d.is_zero())
    }

    fn fail(&mut self, now: Instant, free: u32) {
        if self.last.is_some_and(|l| now.duration_since(l) > FORGET_AFTER) {
            *self = Tries::default();
        }
        self.failures += 1;
        self.last = Some(now);
        if self.failures > free {
            // 30 s, doubling, up to 16 min.
            let n = (self.failures - free - 1).min(5);
            self.until = Some(now + Duration::from_secs(30 << n));
        }
    }
}

/// Remote unlock attempts. The window is not counted: the person at it is the
/// one the lock is for, and nothing else can reach its IPC.
#[derive(Default)]
struct Guesses {
    by: HashMap<Holder, Tries>,
    all: Tries,
}

impl Guesses {
    /// Count a try before the slow hash runs, so twenty requests sent at once
    /// are twenty tries, not twenty free ones that all finish before the first
    /// failure is written down.
    fn claim(&mut self, h: &Holder, now: Instant) -> Result<(), Duration> {
        let mine = self.by.entry(h.clone()).or_default();
        if let Some(wait) = mine.wait(now).max(self.all.wait(now)) {
            return Err(wait);
        }
        mine.fail(now, FREE_TRIES);
        self.all.fail(now, FREE_TRIES_ALL);
        Ok(())
    }

    /// The claimed try was right: forgive the device, and take this try back
    /// out of the shared count.
    fn succeeded(&mut self, h: &Holder) {
        self.by.remove(h);
        self.all.failures = self.all.failures.saturating_sub(1);
        if self.all.failures <= FREE_TRIES_ALL {
            self.all.until = None;
        }
    }
}

fn guesses<T>(f: impl FnOnce(&mut Guesses) -> T) -> T {
    static G: OnceLock<Mutex<Guesses>> = OnceLock::new();
    let mut guard = G.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
    f(&mut guard)
}

// ─── The event stream ─────────────────────────────────────────────────────────

/// Which chats' turns one `/api/events` subscriber may watch. Without it every
/// paired device saw the tokens of a locked chat stream past whenever the
/// window had it open — the transcript, a word at a time.
#[derive(Default)]
pub struct StreamGate {
    generation: u64,
    roots: HashMap<String, Option<String>>,
}

impl StreamGate {
    /// Whether a `stream` event's payload may go to `holder`. A database error
    /// keeps it back.
    pub async fn allows(&mut self, db: &SqlitePool, holder: &Holder, payload: &str) -> bool {
        let Some(chat_id) = serde_json::from_str::<Value>(payload)
            .ok()
            .and_then(|v| v.get("chatId").and_then(Value::as_str).map(str::to_string))
        else {
            return true;
        };
        let generation = LOCK_GEN.load(Ordering::Relaxed);
        if generation != self.generation {
            self.roots.clear();
            self.generation = generation;
        }
        let root = match self.roots.get(&chat_id) {
            Some(r) => r.clone(),
            None => match lock_root(db, &chat_id).await {
                Ok(r) => {
                    self.roots.insert(chat_id, r.clone());
                    r
                }
                Err(_) => return false,
            },
        };
        root.map_or(true, |r| is_unlocked_for(holder, &r))
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
    close_everywhere(chat_id);
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
    /// Lock roots the caller has open — the window's, or this device's — so a
    /// reloaded page agrees with us.
    pub unlocked: Vec<String>,
}

#[tauri::command]
pub async fn chat_lock_status(state: State<'_, AppState>) -> AppResult<LockStatus> {
    let h = current_holder();
    let unlocked = sessions(|s| s.roots(&h, Instant::now(), backstop()));
    Ok(LockStatus { app_password_set: app_hash(&state.db).await?.is_some(), unlocked })
}

/// The caller's user did something (`idle` false), keeping its unlocks open;
/// or its idle time ran out (`idle` true), closing them all. Only ever the
/// caller's own: the static token's are always none, so a model calling this
/// keeps nothing open.
#[tauri::command]
pub async fn chat_lock_activity(idle: Option<bool>) -> AppResult<()> {
    let h = current_holder();
    sessions(|s| {
        if idle == Some(true) {
            s.close_holder(&h);
        } else {
            s.touch(&h, Instant::now(), backstop());
        }
    });
    Ok(())
}

const NOT_FOR_THE_TOKEN: &str = "a chat is unlocked by the person who will read it — in the window, or on a \
     paired device or browser tab with its own sign-in; the API token is not one person, so it cannot unlock";

/// Open the lock covering `chat_id` for `holder`, if `password` opens it.
/// `false` for a wrong password; an error when the caller may not try, or
/// has tried too often.
pub async fn unlock_as(db: &SqlitePool, holder: &Holder, chat_id: &str, password: &str) -> AppResult<bool> {
    if *holder == Holder::Nobody {
        return Err(AppError::Invalid(NOT_FOR_THE_TOKEN.into()));
    }
    let Some(root) = lock_root(db, chat_id).await? else { return Ok(true) };
    if holder.remote() {
        if let Err(wait) = guesses(|g| g.claim(holder, Instant::now())) {
            return Err(AppError::Invalid(format!(
                "too many wrong passwords from here; try again in {} s",
                wait.as_secs().max(1)
            )));
        }
    }
    let ok = password_opens(db, &root, password).await?;
    if ok {
        if holder.remote() {
            guesses(|g| g.succeeded(holder));
        }
        sessions(|s| s.open(holder, &root, Instant::now()));
    }
    Ok(ok)
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

/// Open a locked chat for the caller — the window over IPC, or the device or
/// tab whose request this is. `false` for a wrong password.
#[tauri::command]
pub async fn unlock_chat(state: State<'_, AppState>, chat_id: String, password: String) -> AppResult<bool> {
    unlock_as(&state.db, &current_holder(), &chat_id, &password).await
}

/// "Lock now": close the chat early, everywhere it is open. Changes nothing
/// stored.
#[tauri::command]
pub async fn relock_chat(app: AppHandle, chat_id: String) -> AppResult<()> {
    close_everywhere(&chat_id);
    // So a phone that had it open drops what it is showing.
    notify(&app);
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
    close_everywhere(&chat_id);
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
        open_for(&super::Holder::Window, root);
    }

    pub fn open_for(h: &super::Holder, root: &str) {
        super::sessions(|s| s.open(h, root, std::time::Instant::now()));
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
        tests_support::open_session("a");
        assert!(ensure_open(&db, "a-branch").await.is_ok());
        // Open: the chat's own turn reaches its sub-agents; another chat and an
        // unattended job still do not.
        assert!(ensure_reachable(&db, Some("a"), "a-sub").await.is_ok());
        assert!(ensure_reachable(&db, Some("b"), "a-sub").await.is_err());
        assert!(ensure_reachable(&db, None, "a").await.is_err());
        assert!(ensure_reachable(&db, None, "b").await.is_ok());
        // The window's unlock is the window's: a device's turn, or an API
        // request, does not see it.
        let phone = Holder::Device("phone".into());
        assert!(as_holder(phone.clone(), ensure_open(&db, "a")).await.is_err());
        assert!(as_holder(Holder::Nobody, ensure_open(&db, "a")).await.is_err());
        close_everywhere("a");
        assert!(ensure_open(&db, "a").await.is_err());
    }

    /// An unlock is the holder's own, closes after its idle time, and is kept
    /// open only by its own activity.
    #[test]
    fn unlocks_are_per_holder_and_close_when_idle() {
        let mut s = Sessions::default();
        let t0 = Instant::now();
        let idle = Some(Duration::from_secs(300));
        let phone = Holder::Device("phone".into());
        let tablet = Holder::Device("tablet".into());
        s.open(&phone, "x", t0);
        assert!(s.is_open(&phone, "x", t0, idle));
        assert!(!s.is_open(&tablet, "x", t0, idle), "another device");
        assert!(!s.is_open(&Holder::Window, "x", t0, idle), "the window");
        assert!(!s.is_open(&phone, "y", t0, idle), "another lock");

        // Activity keeps it open; another holder's does not.
        s.touch(&phone, t0 + Duration::from_secs(200), idle);
        s.touch(&tablet, t0 + Duration::from_secs(400), idle);
        assert!(s.is_open(&phone, "x", t0 + Duration::from_secs(450), idle));
        assert!(!s.is_open(&phone, "x", t0 + Duration::from_secs(500), idle), "idle");
        // Gone is gone: activity after the idle time does not bring it back.
        s.touch(&phone, t0 + Duration::from_secs(501), idle);
        assert!(!s.is_open(&phone, "x", t0 + Duration::from_secs(502), idle));

        // Off: open until closed.
        s.open(&phone, "x", t0);
        assert!(s.is_open(&phone, "x", t0 + Duration::from_secs(86_400), None));
        s.open(&Holder::Window, "x", t0);
        s.close_root("x");
        assert!(!s.is_open(&phone, "x", t0, None) && !s.is_open(&Holder::Window, "x", t0, None));

        // The static token can never hold one.
        s.open(&Holder::Nobody, "x", t0);
        assert!(!s.is_open(&Holder::Nobody, "x", t0, None));
    }

    #[tokio::test]
    async fn only_a_person_can_unlock_and_only_for_themselves() {
        let db = pool().await;
        // Their own ids: sessions are process-wide and other tests open "a".
        for (id, parent) in [("u", None), ("u-sub", Some("u"))] {
            sqlx::query("INSERT INTO chats (id, title, parent_chat_id, created_at, updated_at) VALUES (?1, ?1, ?2, 0, 0)")
                .bind(id)
                .bind(parent)
                .execute(&db)
                .await
                .unwrap();
        }
        sqlx::query("UPDATE chats SET lock_kind = 'chat', lock_hash = ?1 WHERE id = 'u'")
            .bind(hash_with("pw", 1_000))
            .execute(&db)
            .await
            .unwrap();
        // The API token — scripts and app_control — is refused outright, even
        // with the right password.
        assert!(unlock_as(&db, &Holder::Nobody, "u", "pw").await.is_err());

        let phone = Holder::Device("unlock-test-phone".into());
        assert!(!unlock_as(&db, &phone, "u", "nope").await.unwrap());
        assert!(!is_unlocked_for(&phone, "u"));
        // Through a sub-agent's id: the lock covering it is what opens.
        assert!(unlock_as(&db, &phone, "u-sub", "pw").await.unwrap());
        assert!(is_unlocked_for(&phone, "u"));
        assert!(!is_unlocked_for(&Holder::Window, "u"));
        assert!(!is_unlocked_for(&Holder::Device("other".into()), "u"));
        // An unlocked chat needs no password and opens nothing.
        assert!(unlock_as(&db, &phone, "b", "").await.unwrap());
        assert!(!is_unlocked_for(&phone, "b"));
        close_everywhere("u");
        assert!(!is_unlocked_for(&phone, "u"));
    }

    #[test]
    fn wrong_passwords_back_off_per_device_and_overall() {
        let mut g = Guesses::default();
        let t0 = Instant::now();
        let phone = Holder::Device("phone".into());
        for _ in 0..=FREE_TRIES {
            assert!(g.claim(&phone, t0).is_ok());
        }
        // Counted at the claim, so a burst is refused before any hash runs.
        let wait = g.claim(&phone, t0).unwrap_err();
        assert_eq!(wait, Duration::from_secs(30));
        assert!(g.claim(&phone, t0 + Duration::from_secs(29)).is_err());
        assert!(g.claim(&phone, t0 + Duration::from_secs(30)).is_ok());
        assert_eq!(g.claim(&phone, t0 + Duration::from_secs(31)).unwrap_err(), Duration::from_secs(59), "doubles");
        // Another device has its own count...
        let tablet = Holder::Device("tablet".into());
        assert!(g.claim(&tablet, t0).is_ok());
        // ...and a right password forgives the device that typed it.
        g.succeeded(&phone);
        assert!(g.claim(&phone, t0 + Duration::from_secs(31)).is_ok());

        // Across devices — a device can pair another — the shared count stops
        // them all.
        let mut g = Guesses::default();
        for i in 0..=FREE_TRIES_ALL {
            assert!(g.claim(&Holder::Device(format!("d{}", i / 2)), t0).is_ok());
        }
        assert!(g.claim(&Holder::Device("fresh".into()), t0).is_err());

        // An hour without a failure starts the count again.
        let mut g = Guesses::default();
        for _ in 0..=FREE_TRIES {
            let _ = g.claim(&phone, t0);
        }
        assert!(g.claim(&phone, t0 + FORGET_AFTER + Duration::from_secs(1)).is_ok());
        assert!(g.claim(&phone, t0 + FORGET_AFTER + Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn an_agent_may_shorten_the_idle_time_never_lengthen_it() {
        assert!(agent_idle_change(15, 5).is_ok());
        assert!(agent_idle_change(15, 15).is_ok());
        assert!(agent_idle_change(0, 60).is_ok(), "switching it on is stricter");
        assert!(agent_idle_change(15, 30).is_err());
        assert!(agent_idle_change(15, 0).is_err(), "off is the loosest of all");
        assert!(agent_idle_change(5, 0).unwrap_err().contains("Settings"));
        assert_eq!(idle_minutes(&serde_json::json!({})), DEFAULT_IDLE_MINUTES);
        assert_eq!(idle_minutes(&serde_json::json!({ IDLE_KEY: 0 })), 0);
        assert_eq!(idle_minutes(&serde_json::json!({ IDLE_KEY: 30 })), 30);
        for bad in [serde_json::json!("never"), serde_json::json!(-1), serde_json::json!(99_999), serde_json::json!(2.5)] {
            assert_eq!(idle_minutes(&serde_json::json!({ IDLE_KEY: bad })), DEFAULT_IDLE_MINUTES, "{bad}");
        }
    }

    #[tokio::test]
    async fn the_event_stream_hides_a_locked_chats_turn_unless_this_holder_opened_it() {
        let db = pool().await;
        sqlx::query("INSERT INTO chats (id, title, lock_kind, created_at, updated_at) VALUES ('s', 's', 'app', 0, 0)")
            .execute(&db)
            .await
            .unwrap();
        let phone = Holder::Device("stream-test-phone".into());
        let ev = |id: &str| serde_json::json!({ "chatId": id, "event": { "type": "delta" } }).to_string();
        let mut gate = StreamGate::default();
        assert!(gate.allows(&db, &phone, &ev("b")).await);
        assert!(!gate.allows(&db, &phone, &ev("s")).await);
        tests_support::open_session("s");
        assert!(!gate.allows(&db, &phone, &ev("s")).await, "open in the window is not open on the phone");
        tests_support::open_for(&phone, "s");
        assert!(gate.allows(&db, &phone, &ev("s")).await);
        close_everywhere("s");
        assert!(!gate.allows(&db, &phone, &ev("s")).await);
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
