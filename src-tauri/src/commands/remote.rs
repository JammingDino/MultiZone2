//! Remote access, from the desktop's side: which address the API binds, which
//! devices may reach it, and how a new one gets a token (0.17.0).
//!
//! The API has been able to do everything the GUI can since 0.11.0. What it has
//! not been is *reachable* — `127.0.0.1`, one static bearer token, no way for
//! anything that is not this machine to find it or authenticate to it. These
//! commands are the other half, and they are worth having on their own: a
//! tablet, a second laptop, or a script on the network wants exactly the same
//! three things a phone does.
//!
//! The one line held throughout: **a LAN bind is its own switch.** Turning the
//! API on and putting the app on the network are different decisions with
//! different consequences, and collapsing them into one toggle would mean
//! someone who wanted a local script got a network service.

use crate::error::{AppError, AppResult};
use crate::remote::{devices, discovery, pairing};
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// Where remote access stands right now — the answer the Settings panel draws
/// and the one a confused user needs.
///
/// Assembled from four separate facts that were previously only checkable by
/// reading four different places: the settings blob, the persisted bind
/// outcome, the machine's interfaces, and whether mDNS actually started.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    /// The API server itself is switched on.
    pub api_enabled: bool,
    /// It is bound to something other than loopback.
    pub lan: bool,
    /// The address it is actually bound to, from the last bind attempt.
    pub address: String,
    pub port: u16,
    /// Whether the socket bound at all, and why not.
    pub bound: bool,
    pub bind_error: Option<String>,
    /// mDNS is advertising this desktop. False when discovery is switched off
    /// *or* when it failed — [`Self::discovery_error`] tells them apart, since
    /// a blocked mDNS is common and is not a reason the phone cannot connect.
    pub discovering: bool,
    pub discovery_error: Option<String>,
    /// What a phone on the same network should point at. `None` when the bind
    /// is loopback, because there is no honest answer in that case.
    pub base_url: Option<String>,
    /// The interfaces the user can choose between.
    pub interfaces: Vec<discovery::NetworkInterface>,
    /// True when the only address this machine has is loopback — an offline
    /// laptop. The UI says that rather than offering a LAN bind that cannot
    /// work.
    pub lan_available: bool,
}

/// The bindable addresses on this machine.
#[tauri::command]
pub fn list_network_interfaces() -> Vec<discovery::NetworkInterface> {
    discovery::interfaces()
}

#[tauri::command]
pub async fn remote_status(state: State<'_, AppState>) -> AppResult<RemoteStatus> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let settings: serde_json::Value =
        raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::Value::Null);
    let api_enabled = settings.get("apiEnabled").and_then(|b| b.as_bool()).unwrap_or(false);

    let bind = super::api::read_bind_state(&state.db).await;
    let address = bind
        .as_ref()
        .map(|b| b.address.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = bind.as_ref().map(|b| b.port).unwrap_or(8765);
    let lan = address != "127.0.0.1" && !address.is_empty();

    let advert = state.mdns.lock().await;
    let interfaces = discovery::interfaces();

    Ok(RemoteStatus {
        api_enabled,
        lan,
        base_url: lan.then(|| format!("http://{address}:{port}")),
        address,
        port,
        bound: bind.as_ref().map(|b| b.ok).unwrap_or(false),
        bind_error: bind.as_ref().and_then(|b| b.error.clone()),
        discovering: advert.handle.is_some(),
        discovery_error: advert.error.clone(),
        lan_available: interfaces.iter().any(|i| !i.loopback),
        interfaces,
    })
}

// ─── Pairing ────────────────────────────────────────────────────────────────

/// The pairing dialog's whole state: the code on screen, what a QR should
/// encode, and who has tried recently.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    /// `None` when no code is on screen — which is most of the time, and is the
    /// state in which pairing is simply not possible.
    pub offer: Option<pairing::PairingOffer>,
    /// The deep link a QR encodes, carrying everything the phone needs: host,
    /// port and code. `None` without an open offer, or without a LAN address to
    /// name — a QR pointing at `127.0.0.1` would scan perfectly and connect to
    /// the phone itself.
    pub link: Option<String>,
    pub attempts: Vec<pairing::PairingAttempt>,
}

/// The `multizone://pair` deep link, which is also the QR's payload.
///
/// A URL rather than a JSON blob because a QR scanner that is not this app
/// still does something sensible with it — and because the mobile shell can
/// register the scheme and be handed the whole pairing in one tap.
fn pairing_link(address: &str, port: u16, code: &str) -> String {
    format!("multizone://pair?host={address}&port={port}&code={code}")
}

#[tauri::command]
pub async fn pairing_status(state: State<'_, AppState>) -> AppResult<PairingView> {
    let offer = pairing::status();
    let bind = super::api::read_bind_state(&state.db).await;
    let address = bind.as_ref().map(|b| b.address.clone()).unwrap_or_default();
    let port = bind.as_ref().map(|b| b.port).unwrap_or(8765);
    let link = match (&offer, address.as_str()) {
        (Some(o), addr) if !addr.is_empty() && addr != "127.0.0.1" => {
            Some(pairing_link(addr, port, &o.code))
        }
        _ => None,
    };
    Ok(PairingView { offer, link, attempts: pairing::recent_attempts(&state.db, 10).await? })
}

/// Show a pairing code.
///
/// Refuses unless the API is actually bound to a LAN address, because a code
/// that no phone can reach is a dead end the user would spend a minute typing
/// into one. The error names the switch they need rather than the state they
/// are in.
#[tauri::command]
pub async fn open_pairing(state: State<'_, AppState>) -> AppResult<PairingView> {
    let bind = super::api::read_bind_state(&state.db).await;
    match bind.as_ref() {
        Some(b) if b.ok && b.address != "127.0.0.1" => {}
        Some(b) if b.ok => {
            return Err(AppError::Invalid(
                "the API is only listening on 127.0.0.1 — switch on LAN access before pairing a device".into(),
            ))
        }
        _ => {
            return Err(AppError::Invalid(
                "the API server is not listening — switch it on before pairing a device".into(),
            ))
        }
    }
    pairing::open();
    pairing_status(state).await
}

#[tauri::command]
pub async fn close_pairing(state: State<'_, AppState>) -> AppResult<PairingView> {
    pairing::close();
    pairing_status(state).await
}

// ─── The device registry ────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_paired_devices(
    state: State<'_, AppState>,
) -> AppResult<Vec<devices::PairedDevice>> {
    devices::list(&state.db).await
}

/// Revoke one device. Its token stops working on its next request; nothing else
/// notices. This is the whole point of per-device tokens.
#[tauri::command]
pub async fn revoke_paired_device(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<devices::PairedDevice> {
    devices::revoke(&state.db, &id).await
}

/// Drop a revoked device from the list. Refuses one that is still live — see
/// [`devices::forget`] for why that is not merely cautious.
#[tauri::command]
pub async fn forget_paired_device(state: State<'_, AppState>, id: String) -> AppResult<()> {
    devices::forget(&state.db, &id).await
}

#[tauri::command]
pub async fn rename_paired_device(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<devices::PairedDevice> {
    devices::rename(&state.db, &id, &name).await
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/// Whether mDNS is currently advertising, and why not if it is not.
///
/// Held in `AppState` rather than as another global: the advertisement's
/// lifetime is the server's, and the two are started and stopped together.
#[derive(Default)]
pub struct Discovery {
    pub handle: Option<discovery::Advertisement>,
    pub error: Option<String>,
}

/// Start (or replace) the mDNS advertisement for a bound server.
///
/// Never fatal. A network that blocks multicast is common, and a phone that
/// already knows the address must not be locked out because the desktop could
/// not shout about itself.
pub async fn advertise(app: &AppHandle, address: &str, port: u16) {
    let state = app.state::<AppState>();
    let mut slot = state.mdns.lock().await;
    *slot = Discovery::default();

    let Ok(ip) = address.parse::<std::net::Ipv4Addr>() else {
        slot.error = Some(format!("'{address}' is not an IPv4 address"));
        return;
    };
    if ip.is_loopback() {
        // Nothing to advertise: mDNS is how something *else* finds this
        // machine, and nothing else can reach loopback.
        return;
    }

    let instance = hostname();
    match discovery::Advertisement::start(&instance, ip, port, env!("CARGO_PKG_VERSION")) {
        Ok(handle) => slot.handle = Some(handle),
        Err(e) => {
            tracing::warn!("mDNS advertisement failed (the app is still reachable): {e}");
            slot.error = Some(e.to_string());
        }
    }
}

/// Withdraw the advertisement. Called when the server stops or the bind changes.
pub async fn stop_advertising(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.mdns.lock().await = Discovery::default();
}

/// This machine's name, for the mDNS instance label. Falls back rather than
/// failing: an unnamed machine should still be discoverable.
fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "MultiZone".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pairing_link_carries_everything_the_phone_needs() {
        let link = pairing_link("192.168.1.5", 8765, "042317");
        assert_eq!(link, "multizone://pair?host=192.168.1.5&port=8765&code=042317");
        // Parseable by the mobile shell without a JSON decoder in the scanner.
        assert!(link.starts_with("multizone://pair?"));
    }
}
