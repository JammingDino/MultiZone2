//! Being findable on the LAN: the interface list, and the mDNS advertisement.
//!
//! Two halves of the same goal — nobody should have to type an IP address.
//!
//! The interface list is what the desktop offers when the user turns the LAN
//! bind on, because "bind to the network" is not one choice on a machine with a
//! Wi-Fi adapter, an Ethernet port, a VPN and three virtual switches. Binding
//! `0.0.0.0` would make that question go away by answering it in the widest
//! possible way, which is exactly the wrong default for a switch whose whole
//! purpose is to be an informed decision.
//!
//! The advertisement is what stops the address mattering at all. Phones move
//! between networks and DHCP moves addresses; a client that only knows an IP is
//! one router reboot from useless. Manual host entry stays as the fallback,
//! because mDNS is blocked or broken on more networks than anyone expects.

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr};

/// The mDNS service type. `_multizone._tcp` rather than piggybacking on
/// `_http._tcp`: a client browsing for this app should find this app, not every
/// web server on the network including the ones that are also this app.
pub const SERVICE_TYPE: &str = "_multizone._tcp.local.";

/// One address the API could bind to, as the Settings picker shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    /// The OS's name for it — `Wi-Fi`, `en0`, `eth0`.
    pub name: String,
    pub address: String,
    /// True for `127.0.0.1`. Kept in the list rather than filtered out, because
    /// loopback is the safe answer and should be visible as a choice rather
    /// than only reachable by turning the whole feature off.
    pub loopback: bool,
    /// True for the RFC1918 ranges and IPv4 link-local. A private address is
    /// the expected case for a home LAN; a public one on a laptop's interface
    /// means the app would be exposed to the internet, and the UI says so.
    pub private: bool,
}

/// Every IPv4 address this machine currently has.
///
/// IPv4 only, deliberately. The address is shown to a person, typed into a
/// phone as a fallback, and put in a QR — and a link-local IPv6 address with a
/// zone index is none of those things. mDNS covers the case where the address
/// is inconvenient, which is the case IPv6 would have been used to fix.
pub fn interfaces() -> Vec<NetworkInterface> {
    let mut out: Vec<NetworkInterface> = match if_addrs::get_if_addrs() {
        Ok(addrs) => addrs
            .into_iter()
            .filter_map(|iface| match iface.addr.ip() {
                IpAddr::V4(v4) => Some(NetworkInterface {
                    name: iface.name,
                    address: v4.to_string(),
                    loopback: v4.is_loopback(),
                    private: is_private(v4),
                }),
                IpAddr::V6(_) => None,
            })
            .collect(),
        Err(e) => {
            tracing::warn!("could not enumerate network interfaces: {e}");
            Vec::new()
        }
    };

    // Loopback first: it is the safe answer and the current behaviour, and a
    // list that opens on the choice that puts the app on the network is a list
    // that has made the decision for the user.
    out.sort_by_key(|i| (!i.loopback, !i.private, i.address.clone()));
    out.dedup_by(|a, b| a.address == b.address);

    if out.is_empty() {
        out.push(NetworkInterface {
            name: "loopback".into(),
            address: "127.0.0.1".into(),
            loopback: true,
            private: true,
        });
    }
    out
}

/// RFC1918 plus IPv4 link-local (169.254/16), which is what a machine gives
/// itself when DHCP has not answered.
fn is_private(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback() || ip.is_link_local()
}

/// The best guess at the address a phone on the same network should use.
///
/// Used to pre-select the picker and to fill the QR. A private, non-loopback
/// address is what a home LAN looks like; falling back to loopback is honest
/// rather than helpful, and the UI treats "the only address is loopback" as the
/// reason it cannot offer a LAN bind.
pub fn best_lan_address() -> Option<String> {
    interfaces()
        .into_iter()
        .find(|i| !i.loopback && i.private)
        .map(|i| i.address)
}

/// A running mDNS advertisement. Dropping it withdraws the record.
pub struct Advertisement {
    daemon: mdns_sd::ServiceDaemon,
    fullname: String,
}

impl Advertisement {
    /// Advertise this desktop at `address:port`.
    ///
    /// Failure is returned rather than swallowed so the Settings panel can say
    /// that discovery is not working — but the caller treats it as a
    /// degradation, not a failed bind: mDNS being blocked is common, and it
    /// must not be the reason a phone that already knows the address cannot
    /// connect.
    pub fn start(
        instance: &str,
        address: Ipv4Addr,
        port: u16,
        version: &str,
    ) -> crate::error::AppResult<Self> {
        use crate::error::AppError;

        let daemon = mdns_sd::ServiceDaemon::new()
            .map_err(|e| AppError::Other(format!("mDNS daemon: {e}")))?;

        // The instance name is what a browsing client lists, so it is the
        // machine's name and not the app's — with two of these on a network,
        // "MultiZone" twice is not a choice anyone can make.
        let instance = sanitize_instance(instance);
        let host = format!("{instance}.local.");

        let mut props = std::collections::HashMap::new();
        props.insert("version".to_string(), version.to_string());
        // So a client can tell a build that knows about pairing from one that
        // does not, without having to try pairing against it to find out.
        props.insert("pairing".to_string(), "1".to_string());

        let info = mdns_sd::ServiceInfo::new(
            SERVICE_TYPE,
            &instance,
            &host,
            IpAddr::V4(address),
            port,
            Some(props),
        )
        .map_err(|e| AppError::Other(format!("mDNS service info: {e}")))?;

        let fullname = info.get_fullname().to_string();
        daemon
            .register(info)
            .map_err(|e| AppError::Other(format!("mDNS register: {e}")))?;
        tracing::info!("advertising {fullname} at {address}:{port}");
        Ok(Advertisement { daemon, fullname })
    }
}

impl Drop for Advertisement {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

/// mDNS instance names may not contain a dot — it is the label separator, and a
/// hostname like `levi-pc.local` would otherwise produce a record nothing can
/// resolve.
fn sanitize_instance(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if c == '.' || c.is_control() { '-' } else { c })
        .take(40)
        .collect();
    if cleaned.is_empty() {
        "MultiZone".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_sorts_first_so_the_safe_choice_is_the_default() {
        let list = interfaces();
        assert!(!list.is_empty(), "there is always at least loopback");
        assert!(list[0].loopback, "the picker must not open on a network address");
    }

    #[test]
    fn every_reported_address_parses_as_ipv4() {
        for iface in interfaces() {
            assert!(
                iface.address.parse::<Ipv4Addr>().is_ok(),
                "not an IPv4 address: {}",
                iface.address
            );
        }
    }

    #[test]
    fn private_ranges_are_recognised() {
        assert!(is_private("192.168.1.5".parse().unwrap()));
        assert!(is_private("10.0.0.1".parse().unwrap()));
        assert!(is_private("172.16.4.4".parse().unwrap()));
        assert!(is_private("169.254.1.1".parse().unwrap()), "DHCP-less self-assignment");
        assert!(!is_private("8.8.8.8".parse().unwrap()));
    }

    /// A hostname with a dot in it produces an unresolvable record, and every
    /// Windows machine on a domain has one.
    #[test]
    fn an_instance_name_never_contains_a_dot() {
        assert_eq!(sanitize_instance("levi-pc.local"), "levi-pc-local");
        assert_eq!(sanitize_instance("   "), "MultiZone");
    }
}
