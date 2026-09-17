//! The mobile binary (0.17.2): a window, and almost nothing behind it.
//!
//! This is the shortest file in the app and the one that carries the most
//! design. Everything the desktop crate does — SQLite, the agentic loop, MCP,
//! the knowledge index, the file tools, the API server — is compiled *out* of
//! the mobile build, and the reason is the premise of the product rather than
//! a build-time convenience.
//!
//! - A phone cannot run a 30B local model, so whatever ran here would be a
//!   different, worse app wearing the same icon.
//! - Every tool that matters needs the desktop's filesystem. `read`, the
//!   shell, an `npx` MCP server: none of them mean anything against a phone's
//!   sandbox.
//! - Two stores would have to sync, and cloud sync is a stated non-goal. A
//!   remote client has no second copy, so the hard problem is deleted rather
//!   than solved — but only if there is genuinely no second store, which means
//!   not shipping the code that would create one.
//!
//! The last point is why this is `#[cfg]` and not a runtime flag. A mobile
//! build that *contained* the database layer and merely chose not to open it
//! would be one bug away from a second copy of the user's chats living on a
//! phone. It cannot be, because it is not there.
//!
//! **The one exception is [`discover_desktops`]** (0.17.4), and it is worth
//! being precise about why it does not breach the rule. It holds no state,
//! reads nothing, and stores nothing; it answers "which machines on this
//! network are running MultiZone" — a question about the *phone's* network
//! position, which the WebView cannot ask and the desktop cannot answer on its
//! behalf. Everything it finds is then reached over the ordinary transport.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::mpsc;
use std::time::Duration;

/// A desktop found on the network.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundDesktop {
    /// `http://192.168.1.5:8765` — what the transport is handed verbatim.
    pub base_url: String,
    pub address: String,
    pub port: u16,
    /// The app's version, from its own health check, so a phone can say "that
    /// one is older than this app" instead of failing obscurely later.
    pub version: Option<String>,
    /// True when the desktop is armed and waiting for a device right now. The
    /// wizard puts that one first: it is almost certainly the machine the
    /// person is standing in front of.
    pub waiting: bool,
}

/// How long each probe waits. A machine on the same Wi-Fi answers in single
/// -digit milliseconds; anything slower than this is not the LAN.
const PROBE_TIMEOUT: Duration = Duration::from_millis(700);

/// How many probes run at once. A /24 is 254 addresses and a phone will not
/// thank us for 254 simultaneous sockets, so they go in a fixed-size wave.
const CONCURRENCY: usize = 48;

/// Find MultiZone desktops on this phone's network.
///
/// A sweep of the phone's own /24, not mDNS. That deserves a defence, because
/// the desktop *does* advertise over mDNS and this ignores it:
///
/// - **Receiving multicast on Android requires a `MulticastLock`**, and without
///   one the OS filters the packets before any Rust sees them. That is fixable,
///   but it is Kotlin, and it only fixes the case below.
/// - **Consumer and guest Wi-Fi routinely block multicast between clients.**
///   mDNS is the mechanism most likely to be unavailable on exactly the network
///   somebody is trying to use — a hotel, an office guest VLAN, a mesh router
///   with client isolation half-enabled.
/// - A /24 sweep of an unauthenticated health check is *deterministic*. It
///   works wherever plain TCP works, which is the same condition the app itself
///   needs to run at all. If the sweep cannot find the desktop, the app could
///   not have talked to it either.
///
/// The desktop's advertisement is still worth having — a laptop, a script, or
/// any Bonjour browser can use it — this is simply not the client for it.
#[tauri::command]
pub async fn discover_desktops(port: Option<u16>) -> Result<Vec<FoundDesktop>, String> {
    let port = port.unwrap_or(8765);
    let Some(local) = local_ipv4() else {
        return Err("this device is not on a network".into());
    };
    let octets = local.octets();

    let (tx, rx) = mpsc::channel::<FoundDesktop>();
    // Blocking sockets on a thread pool rather than an async runtime: the mobile
    // build has no tokio, and adding one to make 254 short-lived requests would
    // be a large dependency for a small job.
    tauri::async_runtime::spawn_blocking(move || {
        for chunk in (1u8..=254).collect::<Vec<_>>().chunks(CONCURRENCY) {
            let mut handles = Vec::with_capacity(chunk.len());
            for &last in chunk {
                if last == octets[3] {
                    continue; // the phone itself
                }
                let ip = Ipv4Addr::new(octets[0], octets[1], octets[2], last);
                let tx = tx.clone();
                handles.push(std::thread::spawn(move || {
                    if let Some(found) = probe(ip, port) {
                        let _ = tx.send(found);
                    }
                }));
            }
            for h in handles {
                let _ = h.join();
            }
        }
    })
    .await
    .map_err(|e| format!("discovery failed: {e}"))?;

    // Every sender went into the closure, and the closure has finished — so the
    // channel is closed and this drains rather than blocking.
    let mut found: Vec<FoundDesktop> = rx.into_iter().collect();
    // A desktop that is waiting for a device is almost certainly the one the
    // user is standing in front of, so it goes first.
    found.sort_by(|a, b| b.waiting.cmp(&a.waiting).then(a.address.cmp(&b.address)));
    Ok(found)
}

/// Ask one address whether it is a MultiZone desktop.
///
/// `/api/health` is unauthenticated by design — a caller working out why nothing
/// answers must not have to authenticate to find out — which is exactly what
/// makes it usable as a discovery probe by a device that has never paired.
fn probe(ip: Ipv4Addr, port: u16) -> Option<FoundDesktop> {
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    let mut stream = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(PROBE_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(PROBE_TIMEOUT)).ok()?;

    write!(
        stream,
        "GET /api/health HTTP/1.1\r\nHost: {ip}:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    )
    .ok()?;

    // Bounded: this is an unknown host on the network, and a health check that
    // answers with a megabyte is not one of ours.
    let mut body = Vec::new();
    stream.take(16 * 1024).read_to_end(&mut body).ok()?;
    let text = String::from_utf8_lossy(&body);
    let json = text.split("\r\n\r\n").nth(1)?;
    let value: serde_json::Value = serde_json::from_str(json.trim()).ok()?;

    // The name check is what stops every other web server on the network being
    // offered as a computer to pair with.
    if value.get("name").and_then(|v| v.as_str()) != Some("MultiZone") {
        return None;
    }

    Some(FoundDesktop {
        base_url: format!("http://{ip}:{port}"),
        address: ip.to_string(),
        port,
        version: value.get("version").and_then(|v| v.as_str()).map(str::to_string),
        waiting: value.get("pairingOpen").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

/// This phone's own LAN address, which is what says which /24 to sweep.
fn local_ipv4() -> Option<Ipv4Addr> {
    if_addrs::get_if_addrs()
        .ok()?
        .into_iter()
        .filter_map(|iface| match iface.addr.ip() {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(v4),
            _ => None,
        })
        .next()
}

/// The plugins a shell needs.
///
/// `notification` earns its place: the moment a run stops and waits for an
/// approval is exactly the moment the phone is in a pocket, and 0.14.3 added
/// notifications on the desktop for the same reason. `dialog` and `fs` are
/// here because the frontend can reach for them and a missing plugin is a
/// runtime error rather than a graceful absence.
///
/// Deliberately absent: the updater (a phone updates through its store or a
/// sideloaded APK, not through GitHub Releases) and `process` (nothing here
/// relaunches itself).
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("multizone=debug".parse().unwrap()),
        )
        .init();

    tracing::info!("MultiZone mobile {} starting", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        // One command, and it is a question about this device's network rather
        // than about the app's state — see the module docs. Everything else the
        // frontend calls is sent to the paired desktop by the transport.
        .invoke_handler(tauri::generate_handler![discover_desktops])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
