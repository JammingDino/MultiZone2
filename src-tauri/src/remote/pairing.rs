//! Pairing: a short code on the desktop, a per-device token on the phone.
//!
//! The thing being replaced is a 32-character token, generated in Settings and
//! copy-pasted. That is a fine credential and a terrible enrolment ceremony —
//! it cannot be typed on a phone, it is the same secret everywhere it is
//! pasted, and rotating it signs out everything.
//!
//! What makes a six-digit code safe here is not its length. It is that the
//! window is small in every direction at once, and each of these is load-
//! bearing:
//!
//! - **It only exists while the user is looking at it.** There is no pairing
//!   window unless somebody opened the dialog on the desktop, so the attack
//!   surface is not "always" but "the two minutes you chose".
//! - **It expires**, on its own, without anyone remembering to close it.
//! - **It is single-use.** A redeemed code is gone, not merely unlikely.
//! - **It has a failure budget.** Five wrong guesses burn the window and the
//!   user is shown a new code. Guessing six digits inside five attempts is one
//!   in two hundred thousand *per window*, and the wrong guesses are written
//!   down where the user will see them.
//!
//! The last one is the part that is easy to leave out and is doing most of the
//! work: without it, a code that expires in two minutes is still a few thousand
//! guesses over a LAN.

use crate::commands::{new_id, now_ts};
use crate::error::{AppError, AppResult};
use rand::Rng;
use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::Mutex;

use super::devices;

/// How long a code stays valid. Long enough to walk to the phone, short enough
/// that leaving the dialog open by accident is not a standing invitation.
///
/// Milliseconds, because `now_ts()` is — every timestamp in this app is epoch
/// millis and a lone seconds-based one here would expire codes 1000× early.
const CODE_TTL_MS: i64 = 180_000;

/// Wrong guesses before the window is burned and the user is shown a new code.
const MAX_FAILURES: u32 = 5;

struct Window {
    code: String,
    expires_at: i64,
    failures: u32,
}

/// The one open pairing window, if any.
///
/// Process-global rather than hung off `AppState` because the API's router and
/// the Tauri command layer both reach it and neither owns it — and because
/// there is exactly one desktop showing exactly one code. A `std::sync::Mutex`
/// is enough: every critical section here is a few comparisons and holds no
/// await point.
static WINDOW: Mutex<Option<Window>> = Mutex::new(None);

/// What the desktop shows, and what a QR encodes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    pub code: String,
    pub expires_at: i64,
    /// Attempts left before this code is burned.
    pub attempts_remaining: u32,
}

/// Open a pairing window, replacing any code already on screen.
///
/// Re-opening rather than refusing is deliberate: the user pressing the button
/// again means "give me a code I can actually see", and answering that with an
/// error because a forgotten one is still live would be the app arguing with
/// them about a decision they have already made.
pub fn open() -> PairingOffer {
    let now = now_ts();
    let code = generate_code();
    let expires_at = now + CODE_TTL_MS;
    *WINDOW.lock().unwrap() = Some(Window { code: code.clone(), expires_at, failures: 0 });
    tracing::info!("pairing window opened, expires in {}s", CODE_TTL_MS / 1000);
    PairingOffer { code, expires_at, attempts_remaining: MAX_FAILURES }
}

/// Close the pairing window. Idempotent — closing the dialog and the code
/// expiring are the same outcome and should not be two code paths.
pub fn close() {
    *WINDOW.lock().unwrap() = None;
}

/// The live offer, or `None` if no code is on screen. Expiry is evaluated here
/// rather than by a timer, so a window nobody asked about simply is not open.
pub fn status() -> Option<PairingOffer> {
    let mut guard = WINDOW.lock().unwrap();
    let expired = guard.as_ref().is_some_and(|w| now_ts() >= w.expires_at);
    if expired {
        *guard = None;
    }
    guard.as_ref().map(|w| PairingOffer {
        code: w.code.clone(),
        expires_at: w.expires_at,
        attempts_remaining: MAX_FAILURES.saturating_sub(w.failures),
    })
}

/// Six digits, uniform, leading zeros kept.
///
/// `random_range` over the whole space rather than six independent digits: the
/// two are equivalent here, and one call is one place to be wrong.
fn generate_code() -> String {
    let n: u32 = rand::rng().random_range(0..1_000_000);
    format!("{n:06}")
}

/// Why a redemption was refused, in the words the attempt log stores and the
/// phone is shown. Every one of these is a thing the person holding the phone
/// can act on, which is the test for whether an error message is worth writing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    NoWindow,
    Expired,
    WrongCode,
    Burned,
}

impl Refusal {
    fn reason(self) -> &'static str {
        match self {
            Refusal::NoWindow => "no pairing window is open on the desktop",
            Refusal::Expired => "the pairing code has expired",
            Refusal::WrongCode => "wrong pairing code",
            Refusal::Burned => "too many wrong codes — the desktop must show a new one",
        }
    }
}

/// Check a presented code against the open window and consume it on success.
///
/// Split out from [`redeem`] so the whole decision happens under one lock with
/// no await inside it: two phones racing the same code must not both win, and
/// the way that goes wrong is a check and a consume with a suspension point
/// between them.
fn take_window(code: &str) -> Result<(), Refusal> {
    let mut guard = WINDOW.lock().unwrap();
    let Some(window) = guard.as_mut() else {
        return Err(Refusal::NoWindow);
    };
    if now_ts() >= window.expires_at {
        *guard = None;
        return Err(Refusal::Expired);
    }
    if !constant_time_eq(window.code.as_bytes(), code.trim().as_bytes()) {
        window.failures += 1;
        if window.failures >= MAX_FAILURES {
            *guard = None;
            return Err(Refusal::Burned);
        }
        return Err(Refusal::WrongCode);
    }
    // Single use: the code is spent by being right, not by the device that used
    // it finishing whatever it does next.
    *guard = None;
    Ok(())
}

/// Compare without an early return on the first differing byte.
///
/// Almost certainly unnecessary against a six-digit code over a LAN, where the
/// noise floor is milliseconds and the whole space is a million. Written this
/// way anyway because the alternative is a reader having to reconstruct that
/// argument, and because the failure budget above is the protection that is
/// actually load-bearing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// A device redeeming a code. Everything but the code is display text.
pub struct PairingRequest<'a> {
    pub code: &'a str,
    pub device_name: &'a str,
    pub platform: &'a str,
    pub address: Option<&'a str>,
}

/// What a successful pairing hands back. The token appears here once and is
/// never readable again — the registry keeps only its hash.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingGrant {
    pub token: String,
    pub device_id: String,
    pub device_name: String,
}

/// Redeem a code for a per-device token.
///
/// Every outcome, accepted or refused, lands in `pairing_attempts`: pairing is
/// the only unauthenticated write on the surface, and a user who opens the
/// dialog and finds three failures from an address they do not recognise has
/// learned something a bare counter would not have told them.
pub async fn redeem(db: &SqlitePool, req: PairingRequest<'_>) -> AppResult<PairingGrant> {
    let address = req.address.unwrap_or("unknown");

    if let Err(refusal) = take_window(req.code) {
        record_attempt(db, address, Some(req.device_name), false, Some(refusal.reason())).await;
        tracing::warn!("pairing refused from {address}: {}", refusal.reason());
        return Err(AppError::Invalid(refusal.reason().to_string()));
    }

    let minted = devices::register(db, req.device_name, req.platform, req.address).await?;
    record_attempt(db, address, Some(&minted.device.name), true, None).await;
    tracing::info!("paired device {} ({})", minted.device.name, minted.device.id);

    Ok(PairingGrant {
        token: minted.token,
        device_id: minted.device.id,
        device_name: minted.device.name,
    })
}

/// One attempt at pairing, as the log records it.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PairingAttempt {
    pub id: String,
    pub address: String,
    pub device_name: Option<String>,
    pub ok: bool,
    pub reason: Option<String>,
    pub created_at: i64,
}

async fn record_attempt(
    db: &SqlitePool,
    address: &str,
    device_name: Option<&str>,
    ok: bool,
    reason: Option<&str>,
) {
    // Best-effort, like the session event log: a record that can fail the thing
    // it observes is worse than no record.
    let _ = sqlx::query(
        "INSERT INTO pairing_attempts (id, address, device_name, ok, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(new_id())
    .bind(address)
    .bind(device_name)
    .bind(ok)
    .bind(reason)
    .bind(now_ts())
    .execute(db)
    .await;
}

/// The recent attempt log, newest first — what the pairing dialog shows.
pub async fn recent_attempts(db: &SqlitePool, limit: i64) -> AppResult<Vec<PairingAttempt>> {
    Ok(sqlx::query_as::<_, PairingAttempt>(
        "SELECT id, address, device_name, ok, reason, created_at
         FROM pairing_attempts ORDER BY created_at DESC LIMIT ?1",
    )
    .bind(limit.clamp(1, 200))
    .fetch_all(db)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The static holds one window for the whole test binary, so these run
    /// under a lock rather than in parallel against each other.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn guard() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn a_code_is_six_digits_including_leading_zeros() {
        for _ in 0..200 {
            let c = generate_code();
            assert_eq!(c.len(), 6, "{c}");
            assert!(c.chars().all(|ch| ch.is_ascii_digit()), "{c}");
        }
    }

    #[test]
    fn there_is_no_window_until_the_desktop_opens_one() {
        let _g = guard();
        close();
        assert!(status().is_none());
        assert_eq!(take_window("000000"), Err(Refusal::NoWindow));
    }

    #[test]
    fn a_correct_code_works_exactly_once() {
        let _g = guard();
        let offer = open();
        assert!(take_window(&offer.code).is_ok());
        // The second device to present the same code finds nothing to present
        // it to — which is the difference between single-use and unlikely.
        assert_eq!(take_window(&offer.code), Err(Refusal::NoWindow));
    }

    /// The protection that is actually doing the work. Without it a code that
    /// lives for three minutes is still a few thousand guesses over a LAN.
    #[test]
    fn five_wrong_guesses_burn_the_window() {
        let _g = guard();
        let offer = open();
        for _ in 0..(MAX_FAILURES - 1) {
            assert_eq!(take_window("999999"), Err(Refusal::WrongCode));
        }
        assert_eq!(take_window("999999"), Err(Refusal::Burned));
        // And the real code no longer works either — burned means burned, not
        // "the attacker is locked out and the owner is not".
        assert_eq!(take_window(&offer.code), Err(Refusal::NoWindow));
    }

    #[test]
    fn remaining_attempts_are_visible_while_the_dialog_is_open() {
        let _g = guard();
        open();
        assert_eq!(status().unwrap().attempts_remaining, MAX_FAILURES);
        let _ = take_window("000000-not-a-code");
        assert_eq!(status().unwrap().attempts_remaining, MAX_FAILURES - 1);
        close();
    }

    #[test]
    fn an_expired_window_is_not_open() {
        let _g = guard();
        open();
        WINDOW.lock().unwrap().as_mut().unwrap().expires_at = now_ts() - 1;
        assert!(status().is_none(), "an expired code must not still be on offer");
    }

    #[test]
    fn reopening_replaces_the_code_rather_than_refusing() {
        let _g = guard();
        let first = open();
        let second = open();
        assert_eq!(take_window(&first.code), Err(Refusal::WrongCode));
        assert!(take_window(&second.code).is_ok());
    }

    #[test]
    fn comparison_handles_lengths_and_content() {
        assert!(constant_time_eq(b"123456", b"123456"));
        assert!(!constant_time_eq(b"123456", b"12345"));
        assert!(!constant_time_eq(b"123456", b"123457"));
    }
}
