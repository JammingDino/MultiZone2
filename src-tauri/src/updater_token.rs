//! The GitHub token the updater authenticates with, recovered at runtime.
//!
//! See `build.rs` for how it gets here and `keystream.rs` for the (deliberately
//! modest) protection applied to it.

include!("../keystream.rs");
include!(concat!(env!("OUT_DIR"), "/updater_token.rs"));

/// The compiled-in token, or `None` for builds made without one.
///
/// Recomputed on each call rather than cached in a `static`: this is read once
/// at startup, and keeping the plaintext token resident for the life of the
/// process — where any later memory dump would catch it — buys nothing.
pub fn updater_token() -> Option<String> {
    if OBFUSCATED_UPDATER_TOKEN.is_empty() {
        return None;
    }

    let plain: Vec<u8> = OBFUSCATED_UPDATER_TOKEN
        .iter()
        .zip(token_keystream(OBFUSCATED_UPDATER_TOKEN.len()))
        .map(|(byte, key)| byte ^ key)
        .collect();

    // A token that does not round-trip means the salt changed without a rebuild.
    // Treat that as "no token" rather than sending a corrupt Authorization
    // header, which GitHub would answer with a 401 the user cannot act on.
    String::from_utf8(plain).ok().filter(|t| !t.is_empty())
}
