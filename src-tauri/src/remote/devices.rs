//! The paired-device registry.
//!
//! One row per device that has been through pairing, holding a SHA-256 of the
//! token it was given and never the token itself. Two consequences worth
//! stating, because they are the reason this is a table rather than a longer
//! list of accepted secrets:
//!
//! - **A copy of the database is not a set of working credentials.** The
//!   desktop never needs to reproduce a token it has already handed out, so it
//!   does not keep one.
//! - **Revoking is per device.** A lost phone is a timestamp on one row; the
//!   tablet and the second laptop do not notice. Rotating the single static
//!   token, which is what the app could do before this, signed out everything.

use crate::commands::{new_id, now_ts};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    pub last_seen_ip: Option<String>,
    pub revoked_at: Option<i64>,
}

/// Note what is missing: `token_hash`. Authentication matches on it in a
/// `WHERE` clause and nothing ever needs to read it back, so the type that
/// crosses into the API and the frontend has no field to leak.
pub const DEVICE_COLS: &str =
    "id, name, platform, created_at, last_seen_at, last_seen_ip, revoked_at";

/// How the caller of a request proved it was allowed to make it.
///
/// The API used to have one answer to this and therefore did not need to ask.
/// It matters now because a route can reasonably behave differently for a
/// device than for the machine's own static token — the static token is what a
/// local script and the in-process `app_control` tool use, and a device holding
/// a token minted over the network is not the same claim.
#[derive(Debug, Clone)]
pub enum DeviceAuth {
    /// The static bearer token from Settings.
    Static,
    /// A paired device, identified.
    Device(Box<PairedDevice>),
}

impl DeviceAuth {
    pub fn device_id(&self) -> Option<&str> {
        match self {
            DeviceAuth::Static => None,
            DeviceAuth::Device(d) => Some(&d.id),
        }
    }
}

/// SHA-256, hex. The token is high-entropy and machine-generated, so this is
/// not a password hash and does not want to be a slow one: there is no
/// dictionary to run against a 256-bit random value, and a per-request KDF on
/// the auth path would be a cost paid on every call to buy nothing.
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// A freshly minted device token. Returned exactly once, at pairing.
pub struct MintedDevice {
    pub device: PairedDevice,
    pub token: String,
}

/// Register a device and mint its token.
pub async fn register(
    db: &SqlitePool,
    name: &str,
    platform: &str,
    address: Option<&str>,
) -> AppResult<MintedDevice> {
    // Two v4 UUIDs: 256 bits, which is what makes the fast hash above the right
    // call. `simple` so the token survives being handed around as a header
    // value without anyone having to think about it.
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let id = new_id();
    let now = now_ts();
    let name = clean_name(name);
    let platform = clean_platform(platform);

    sqlx::query(
        "INSERT INTO paired_devices (id, name, platform, token_hash, created_at, last_seen_at, last_seen_ip, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, NULL)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&platform)
    .bind(hash_token(&token))
    .bind(now)
    .bind(address)
    .execute(db)
    .await?;

    let device = sqlx::query_as::<_, PairedDevice>(&format!(
        "SELECT {DEVICE_COLS} FROM paired_devices WHERE id = ?1"
    ))
    .bind(&id)
    .fetch_one(db)
    .await?;

    Ok(MintedDevice { device, token })
}

/// Resolve a presented bearer token to a live device, or `None`.
///
/// The lookup is by hash of what the caller sent, so the query's timing depends
/// on a value the caller already knows and leaks nothing about the stored one.
pub async fn authenticate(db: &SqlitePool, token: &str) -> Option<PairedDevice> {
    if token.trim().is_empty() {
        return None;
    }
    sqlx::query_as::<_, PairedDevice>(&format!(
        "SELECT {DEVICE_COLS} FROM paired_devices
         WHERE token_hash = ?1 AND revoked_at IS NULL"
    ))
    .bind(hash_token(token))
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

/// How stale `last_seen_at` is allowed to get before the auth path writes.
///
/// The question the column answers is "was this device around today", and a
/// write on every request would be a database write per request of a streaming
/// chat to answer it more precisely than anyone asked.
const LAST_SEEN_INTERVAL_MS: i64 = 60_000;

pub async fn touch(db: &SqlitePool, device: &PairedDevice, address: Option<&str>) {
    let now = now_ts();
    if device.last_seen_at.is_some_and(|t| now - t < LAST_SEEN_INTERVAL_MS) {
        return;
    }
    let _ = sqlx::query(
        "UPDATE paired_devices SET last_seen_at = ?2, last_seen_ip = COALESCE(?3, last_seen_ip)
         WHERE id = ?1",
    )
    .bind(&device.id)
    .bind(now)
    .bind(address)
    .execute(db)
    .await;
}

pub async fn list(db: &SqlitePool) -> AppResult<Vec<PairedDevice>> {
    Ok(sqlx::query_as::<_, PairedDevice>(&format!(
        "SELECT {DEVICE_COLS} FROM paired_devices ORDER BY revoked_at IS NOT NULL, created_at DESC"
    ))
    .fetch_all(db)
    .await?)
}

/// Revoke a device. Its token stops working on the next request it makes.
///
/// Idempotent, and deliberately not a delete: a user who taps revoke wants to
/// see that it happened, and a row that vanishes looks the same as a tap that
/// missed.
pub async fn revoke(db: &SqlitePool, id: &str) -> AppResult<PairedDevice> {
    sqlx::query(
        "UPDATE paired_devices SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
    )
    .bind(id)
    .bind(now_ts())
    .execute(db)
    .await?;

    sqlx::query_as::<_, PairedDevice>(&format!(
        "SELECT {DEVICE_COLS} FROM paired_devices WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("no paired device {id}")))
}

/// Remove a revoked device from the list entirely. Refuses a live one, because
/// "forget" reads like "revoke" and must not quietly be a weaker version of it:
/// deleting the row of a device that still holds a working token would leave
/// the token working with nothing on screen to revoke.
pub async fn forget(db: &SqlitePool, id: &str) -> AppResult<()> {
    let revoked: Option<Option<i64>> =
        sqlx::query_scalar("SELECT revoked_at FROM paired_devices WHERE id = ?1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    match revoked {
        None => return Err(AppError::NotFound(format!("no paired device {id}"))),
        Some(None) => {
            return Err(AppError::Invalid(
                "revoke the device before forgetting it — otherwise its token keeps working with nothing left to revoke".into(),
            ))
        }
        Some(Some(_)) => {}
    }
    sqlx::query("DELETE FROM paired_devices WHERE id = ?1").bind(id).execute(db).await?;
    Ok(())
}

pub async fn rename(db: &SqlitePool, id: &str, name: &str) -> AppResult<PairedDevice> {
    sqlx::query("UPDATE paired_devices SET name = ?2 WHERE id = ?1")
        .bind(id)
        .bind(clean_name(name))
        .execute(db)
        .await?;
    sqlx::query_as::<_, PairedDevice>(&format!(
        "SELECT {DEVICE_COLS} FROM paired_devices WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("no paired device {id}")))
}

/// A device names itself at pairing time, and the name is drawn in the device
/// list — so it is untrusted display text. Trimmed, bounded, and stripped of
/// control characters, which is the whole of the threat here.
fn clean_name(name: &str) -> String {
    let cleaned: String = name.trim().chars().filter(|c| !c.is_control()).take(60).collect();
    if cleaned.is_empty() {
        "Unnamed device".to_string()
    } else {
        cleaned
    }
}

fn clean_platform(platform: &str) -> String {
    let p = platform.trim().to_lowercase();
    match p.as_str() {
        "android" | "ios" | "web" | "desktop" | "linux" | "macos" | "windows" => p,
        _ => "other".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashing_is_stable_and_not_the_token() {
        let h = hash_token("abc");
        assert_eq!(h, hash_token("abc"));
        assert_ne!(h, hash_token("abd"));
        assert!(!h.contains("abc"));
        assert_eq!(h.len(), 64);
    }

    #[test]
    fn an_empty_name_still_shows_up_in_the_list() {
        assert_eq!(clean_name("   "), "Unnamed device");
        assert_eq!(clean_name(" Pixel 8 "), "Pixel 8");
    }

    /// A device chooses its own name, so the device list renders text that came
    /// off the network. Control characters are the part of that which is this
    /// layer's problem, and they are cheaper to drop once here than to remember
    /// to escape at every place the name is drawn.
    #[test]
    fn a_hostile_name_is_defanged_rather_than_rejected() {
        assert_eq!(clean_name("Pix\u{7}el\n8"), "Pixel8");
        assert_eq!(clean_name(&"x".repeat(200)).chars().count(), 60);
    }

    #[test]
    fn an_unknown_platform_is_kept_as_other_rather_than_refused() {
        assert_eq!(clean_platform("Android"), "android");
        assert_eq!(clean_platform("SailfishOS"), "other");
    }
}
