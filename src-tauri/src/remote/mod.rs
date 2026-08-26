//! Remote access: paired devices, pairing, and LAN discovery (0.17.0).
//!
//! The API has been the whole app since 0.11.0 — 105 routes, a generated route
//! index, and a drift test that fails the build when a command gains neither a
//! route nor a stated reason to be GUI-only. What it has never been is
//! *reachable*: the socket binds `127.0.0.1`, and its one credential is a
//! bearer token generated in Settings and copy-pasted into a shell.
//!
//! Both are deliberate, and both are what stands between the desktop and a
//! phone acting as a second window onto it. This module is the other half:
//!
//! - [`devices`] — the registry. One row per device, holding a *hash* of the
//!   token rather than the token, revocable on its own.
//! - [`pairing`] — a short code, shown on the desktop, redeemed once, in
//!   exchange for a per-device token. It replaces typing a UUID into a phone.
//! - [`discovery`] — mDNS advertisement, so nobody types an IP either.
//!
//! The design line, from [CONNECTIVITY.md](../../../docs/CONNECTIVITY.md): a
//! LAN bind is a genuinely different security posture from a loopback socket,
//! so it is its own switch rather than a side effect of switching the API on,
//! and the UI says plainly that the app is now on the network.

pub mod devices;
pub mod discovery;
pub mod pairing;

pub use devices::DeviceAuth;
