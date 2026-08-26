//! Tauri commands controlling the embedded HTTP API server lifecycle, plus a
//! startup helper that launches it if enabled in the persisted settings.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::net::Ipv4Addr;
use tauri::{AppHandle, Manager, State};

/// The address the server binds when remote access is off. Also the fallback
/// for every way choosing a LAN address can go wrong, because loopback is the
/// posture that cannot surprise anyone.
pub const LOOPBACK: &str = "127.0.0.1";

/// Persisted API config, read from the `app_settings` JSON blob.
struct ApiConfig {
    enabled: bool,
    port: u16,
    token: String,
    /// Remote access: bind to a network interface rather than loopback
    /// (0.17.0). Its own flag, not a consequence of `enabled` — switching the
    /// API on for a local script and putting the app on the network are
    /// different decisions and the second one is the dangerous half.
    lan: bool,
    /// Which interface, by address. Empty means "pick the obvious one", which
    /// is what somebody with a single Wi-Fi adapter should never have to think
    /// about.
    bind_address: String,
    /// Advertise over mDNS so a phone need not be told the address at all.
    discovery: bool,
}

fn read_api_config(app_settings_json: Option<&str>) -> ApiConfig {
    let v: serde_json::Value = app_settings_json
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Null);
    ApiConfig {
        enabled: v.get("apiEnabled").and_then(|b| b.as_bool()).unwrap_or(false),
        port: v
            .get("apiPort")
            .and_then(|p| p.as_u64())
            .filter(|p| *p > 0 && *p <= 65535)
            .map(|p| p as u16)
            .unwrap_or(8765),
        token: v
            .get("apiToken")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        lan: v.get("apiLan").and_then(|b| b.as_bool()).unwrap_or(false),
        bind_address: v
            .get("apiBindAddress")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        // Defaults on *with* the LAN bind: someone who has already decided to
        // put the app on their network is not helped by then having to find a
        // second switch to make it findable. It is separately switchable
        // because a network can block multicast, not because it is a second
        // security decision.
        discovery: v.get("apiDiscovery").and_then(|b| b.as_bool()).unwrap_or(true),
    }
}

/// Which address to bind, given the user's choice and the machine's reality.
///
/// The three refusals matter more than the happy path. Falling back to loopback
/// when a chosen interface has gone would leave the toggle reading "on the
/// network" with a server nothing can reach; silently binding a *different*
/// network would put the app on a network the user never picked; and `0.0.0.0`
/// would do both at once. So the failures are named, and the caller reports
/// them the same way it reports a port already in use.
fn resolve_bind_address(lan: bool, requested: &str) -> Result<Ipv4Addr, String> {
    if !lan {
        return Ok(Ipv4Addr::LOCALHOST);
    }
    let available = crate::remote::discovery::interfaces();
    let requested = requested.trim();

    if !requested.is_empty() {
        let known = available.iter().any(|i| i.address == requested);
        if !known {
            return Err(format!(
                "{requested} is not an address on this machine any more — pick the interface again in Settings"
            ));
        }
        return requested
            .parse::<Ipv4Addr>()
            .map_err(|_| format!("'{requested}' is not an IPv4 address"));
    }

    match crate::remote::discovery::best_lan_address() {
        Some(addr) => addr
            .parse::<Ipv4Addr>()
            .map_err(|_| format!("'{addr}' is not an IPv4 address")),
        None => Err(
            "this machine has no network address — it is not on a network, so nothing can reach it"
                .into(),
        ),
    }
}

/// What happened the last time the app tried to bind the API socket (0.11.0).
///
/// Previously the bind result was reported once, synchronously, to whoever
/// called `apply_api_settings` — and then forgotten. A port already in use left
/// the Settings toggle reading "on" with nothing behind it, and neither a
/// script nor a model could find out. It is a settings row now, so `/api/health`
/// and the Settings panel read the same answer.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindState {
    pub ok: bool,
    pub port: u16,
    /// Which address it bound, or tried to (0.17.0). "Enabled" and "on the
    /// network" became different facts when the LAN bind landed, and a row that
    /// only recorded the port could not tell them apart. Defaulted for rows
    /// written by an older build, which were all loopback by construction.
    #[serde(default = "loopback_address")]
    pub address: String,
    /// Why the bind failed, in the OS's own words.
    pub error: Option<String>,
    pub at: i64,
}

fn loopback_address() -> String {
    LOOPBACK.to_string()
}

impl BindState {
    fn failed(port: u16, address: &str, why: impl Into<String>) -> Self {
        BindState {
            ok: false,
            port,
            address: address.to_string(),
            error: Some(why.into()),
            at: crate::commands::now_ts(),
        }
    }

    fn bound(port: u16, address: &str) -> Self {
        BindState {
            ok: true,
            port,
            address: address.to_string(),
            error: None,
            at: crate::commands::now_ts(),
        }
    }
}

const BIND_STATE_KEY: &str = "api_bind_state";

pub async fn read_bind_state(db: &sqlx::SqlitePool) -> Option<BindState> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(BIND_STATE_KEY)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    raw.and_then(|s| serde_json::from_str(&s).ok())
}

async fn write_bind_state(db: &sqlx::SqlitePool, state: &BindState) {
    let Ok(json) = serde_json::to_string(state) else { return };
    let _ = sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(BIND_STATE_KEY)
    .bind(json)
    .execute(db)
    .await;
}

/// The bind outcome, for the Settings panel — the same row `/api/health`
/// reports, so the two can't tell different stories.
#[tauri::command]
pub async fn api_bind_state(state: State<'_, AppState>) -> AppResult<Option<BindState>> {
    Ok(read_bind_state(&state.db).await)
}

/// Stop the running server (if any), and withdraw the mDNS record with it.
///
/// The two are one action: an advertisement that outlives its socket points
/// phones at a closed port, which is a worse failure than not being findable.
async fn stop_running(app: &AppHandle, state: &AppState) {
    if let Some(handle) = state.api_server.lock().await.take() {
        handle.stop();
    }
    super::remote::stop_advertising(app).await;
}

/// Bring the server up on `address:port`, record the outcome, and advertise it.
///
/// Shared by `apply_api_settings` and the startup path, which had drifted into
/// two copies of the same sequence with slightly different error text — and
/// which now have three more things to keep in step (the address, the pairing
/// window, the advertisement).
async fn start_and_record(
    app: &AppHandle,
    state: &AppState,
    cfg: &ApiConfig,
) -> Result<(), String> {
    let address = match resolve_bind_address(cfg.lan, &cfg.bind_address) {
        Ok(addr) => addr,
        Err(why) => {
            write_bind_state(&state.db, &BindState::failed(cfg.port, LOOPBACK, why.clone())).await;
            return Err(why);
        }
    };
    let address_str = address.to_string();

    match crate::api::start(
        app.clone(),
        state.db.clone(),
        state.http.clone(),
        state.active_streams.clone(),
        state.tool_approvals.clone(),
        address,
        cfg.port,
        cfg.token.clone(),
    )
    .await
    {
        Ok(handle) => {
            write_bind_state(&state.db, &BindState::bound(cfg.port, &address_str)).await;
            *state.api_server.lock().await = Some(handle);
            if cfg.discovery {
                super::remote::advertise(app, &address_str, cfg.port).await;
            }
            Ok(())
        }
        Err(e) => {
            let message = e.to_string();
            write_bind_state(
                &state.db,
                &BindState::failed(cfg.port, &address_str, message.clone()),
            )
            .await;
            Err(message)
        }
    }
}

/// (Re)start or stop the server to match the requested settings. Called by the
/// Settings UI whenever the API config changes.
///
/// `lan`, `bind_address` and `discovery` arrived in 0.17.0. They are arguments
/// rather than a second command because every one of them changes which socket
/// is open, and a settings panel that could change the bind without restarting
/// the server would be describing a server that does not exist.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn apply_api_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    port: u16,
    token: String,
    lan: Option<bool>,
    bind_address: Option<String>,
    discovery: Option<bool>,
) -> AppResult<()> {
    stop_running(&app, &state).await;
    // A code on screen belongs to the server that was listening when it was
    // shown. Restarting on a different address or port makes it point at
    // nothing, so it goes with the socket rather than sitting there looking
    // valid.
    crate::remote::pairing::close();

    if !enabled {
        // Off is not a failed bind — record it as such rather than leaving the
        // last run's outcome sitting there looking current.
        write_bind_state(&state.db, &BindState::failed(port, LOOPBACK, "disabled in settings"))
            .await;
        return Ok(());
    }
    if token.trim().is_empty() {
        return Err(AppError::Invalid("API token must not be empty".into()));
    }

    let cfg = ApiConfig {
        enabled,
        port,
        token,
        lan: lan.unwrap_or(false),
        bind_address: bind_address.unwrap_or_default(),
        discovery: discovery.unwrap_or(true),
    };

    start_and_record(&app, &state, &cfg)
        .await
        .map_err(|e| AppError::Other(format!("failed to start API server: {e}")))
}

/// Generate a fresh random bearer token for the API.
#[tauri::command]
pub fn generate_api_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Launch the server on app startup if it is enabled in persisted settings.
pub async fn start_if_enabled(app: &AppHandle) {
    let state = app.state::<AppState>();

    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let cfg = read_api_config(raw.as_deref());
    if !cfg.enabled || cfg.token.trim().is_empty() {
        let why = if cfg.enabled { "no API token is set" } else { "disabled in settings" };
        write_bind_state(&state.db, &BindState::failed(cfg.port, LOOPBACK, why)).await;
        return;
    }

    // The failure a user actually hits: the port is taken, or the laptop is on
    // a different network than the one whose address they picked. Until 0.11.0
    // the only trace was a log line nobody reads while the toggle still said
    // "on"; the bind row is what the Settings panel and `/api/health` both show.
    if let Err(e) = start_and_record(app, &state, &cfg).await {
        tracing::error!("API server failed to start on launch: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_access_off_always_means_loopback() {
        // Even with an address left over from when it was on: the flag is the
        // decision, and the address is only how that decision is carried out.
        assert_eq!(resolve_bind_address(false, "192.168.1.5").unwrap(), Ipv4Addr::LOCALHOST);
    }

    /// The case that would otherwise be a silent downgrade: the laptop moved
    /// networks, the chosen address is gone, and binding loopback instead would
    /// leave the panel claiming the app is reachable.
    #[test]
    fn a_vanished_interface_is_an_error_rather_than_a_quiet_fallback() {
        let err = resolve_bind_address(true, "203.0.113.99").unwrap_err();
        assert!(err.contains("203.0.113.99"), "the message must name the address: {err}");
    }

    #[test]
    fn an_empty_choice_picks_a_real_interface_or_says_why_not() {
        match resolve_bind_address(true, "") {
            Ok(addr) => assert!(!addr.is_loopback(), "auto-pick must not choose loopback"),
            Err(why) => assert!(why.contains("no network address")),
        }
    }

    /// A settings blob written before 0.17.0 has none of these keys. It must
    /// read as "loopback, as before" rather than as anything on the network.
    #[test]
    fn an_older_settings_blob_stays_on_loopback() {
        let cfg = read_api_config(Some(r#"{"apiEnabled":true,"apiPort":8765,"apiToken":"t"}"#));
        assert!(!cfg.lan, "remote access must not switch itself on for an existing install");
        assert_eq!(cfg.bind_address, "");
        assert_eq!(
            resolve_bind_address(cfg.lan, &cfg.bind_address).unwrap(),
            Ipv4Addr::LOCALHOST
        );
    }

    /// Bind rows written before the address column existed were loopback by
    /// construction, and must not deserialise into something that looks remote.
    #[test]
    fn an_older_bind_row_reads_as_loopback() {
        let old = r#"{"ok":true,"port":8765,"error":null,"at":1}"#;
        let state: BindState = serde_json::from_str(old).unwrap();
        assert_eq!(state.address, LOOPBACK);
    }
}
