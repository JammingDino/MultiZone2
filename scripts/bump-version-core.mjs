// The version bump, as a set of pure string transforms.
//
// It used to be four inlined `node -e` blocks in release.yml, which is why it
// was wrong: the version lives in *four* files and the workflow updated three.
// `src-tauri/Cargo.lock` carries the workspace package's own version and was
// never touched, so every release since has left `Cargo.toml` and `Cargo.lock`
// disagreeing — invisible in an ordinary build, because cargo silently rewrites
// the lockfile, and fatal under `--locked`, which is the flag a reproducible or
// offline build wants.
//
// Same treatment as rewrite-manifest-core.mjs, for the same reason: a pure
// function with tests beats YAML nobody can run.

/** The next patch version. Bumps only the patch — minor/major are deliberate acts. */
export function nextVersion(current) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current).trim());
  if (!m) throw new Error(`not a semver version: ${current}`);
  const [, maj, min, pat] = m;
  return `${maj}.${min}.${Number(pat) + 1}`;
}

/** package.json: set the version and disarm the release flag. */
export function bumpPackageJson(src, version) {
  const pkg = JSON.parse(src);
  pkg.version = version;
  // Reset every time. A flag left armed turns the *next* merge to main into an
  // unintended publish, which is the failure this whole file exists near.
  pkg.releaseBuild = false;
  return JSON.stringify(pkg, null, 2) + "\n";
}

/** tauri.conf.json: the version the built binary reports. */
export function bumpTauriConf(src, version) {
  const cfg = JSON.parse(src);
  cfg.version = version;
  return JSON.stringify(cfg, null, 2) + "\n";
}

/**
 * Cargo.toml: the `version` in `[package]`, and only that one.
 *
 * A blanket sed on every line starting `version =` would also rewrite the first dependency's
 * version if the file ever grew a `[dependencies]` entry with a bare `version`
 * key at the start of a line — so the match is anchored to the `[package]`
 * section rather than to the whole file.
 */
export function bumpCargoToml(src, version) {
  const lines = src.split("\n");
  let inPackage = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("[")) inPackage = line === "[package]";
    if (inPackage && /^version\s*=/.test(lines[i])) {
      lines[i] = `version = "${version}"`;
      return lines.join("\n");
    }
  }
  throw new Error("no [package] version found in Cargo.toml");
}

/**
 * Cargo.lock: the workspace package's own entry — the file the old workflow
 * forgot.
 *
 * Matched by the `name = "<pkg>"` line and the `version` immediately after it,
 * so no dependency's pinned version is touched. Getting this wrong by being
 * greedy would be far worse than leaving it stale, hence the narrow match and
 * the loud failure.
 */
export function bumpCargoLock(src, version, pkgName = "multizone") {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === `name = "${pkgName}"` && /^version\s*=/.test(lines[i + 1])) {
      lines[i + 1] = `version = "${version}"`;
      return lines.join("\n");
    }
  }
  throw new Error(`no [[package]] entry for "${pkgName}" in Cargo.lock`);
}

/** Every file the version lives in, so a caller cannot forget one. */
export const VERSIONED_FILES = [
  { path: "package.json", apply: bumpPackageJson },
  { path: "src-tauri/tauri.conf.json", apply: bumpTauriConf },
  { path: "src-tauri/Cargo.toml", apply: bumpCargoToml },
  { path: "src-tauri/Cargo.lock", apply: bumpCargoLock },
];
