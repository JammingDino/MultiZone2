// Shared keystream for the compiled-in updater token.
//
// `include!`d by BOTH `build.rs` (which obfuscates the token at compile time)
// and `src/updater_token.rs` (which reverses it at runtime), so the two halves
// can never drift apart. It is not a module in its own right — including it
// twice in one crate would collide.
//
// Read this honestly: XOR against a keystream derived from a constant salt is
// *obfuscation*, not encryption. Both the ciphertext and the means to reverse
// it ship in the same binary, so anyone willing to open a disassembler gets the
// token back. What it does buy is that the token is no longer a plain string:
// `strings multizone.exe`, a grep of the install directory, or an antivirus
// vendor slurping up binaries will not surface a live GitHub credential. That
// is the honest ceiling for any secret embedded in a client, which is why the
// token backing it should be a read-only, short-lived, easily-revoked one.

/// Salt mixed into the keystream. Changing it invalidates already-built
/// binaries' tokens, which is fine — the token is re-injected on every build.
const TOKEN_OBFUSCATION_SALT: &str = "multizone-updater-token-v1";

/// FNV-1a-derived keystream. Deliberately dependency-free: `build.rs` runs
/// before the dependency graph is available to it in any convenient form, and
/// pulling a cipher crate in would imply a security property this does not have.
fn token_keystream(len: usize) -> Vec<u8> {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = FNV_OFFSET;
    for byte in TOKEN_OBFUSCATION_SALT.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }

    let mut stream = Vec::with_capacity(len);
    for i in 0..len {
        // Fold the index in so the stream never repeats within a token, and
        // take a middle byte so consecutive outputs aren't trivially related.
        hash ^= i as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
        stream.push((hash >> 24) as u8);
    }
    stream
}
