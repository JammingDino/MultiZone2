#!/usr/bin/env node
// Put the app's icons into the generated Android project.
//
//   node scripts/sync-android-icons.mjs
//   node scripts/sync-android-icons.mjs --check
//
// `tauri icon` writes a full Android icon set into `src-tauri/icons/android/`,
// and `tauri android init` does *not* copy it over the Android Studio template
// — so a freshly generated project ships the template's own launcher icon and
// the app appears in the drawer as a stock green robot. It did.
//
// Three pieces, and the third is the one that is easy to miss:
//
//   1. `mipmap-*/ic_launcher*.png` — the legacy icons, used below API 26.
//   2. `mipmap-anydpi-v26/ic_launcher.xml` — the adaptive icon. Without it,
//      modern Android falls back to the legacy PNG and never applies the
//      launcher's mask, so the icon is the wrong shape on every device that
//      rounds them.
//   3. `values/ic_launcher_background.xml` — the colour that adaptive icon
//      names. The template ships a *drawable* by the same name; the adaptive
//      icon asks for `@color/`, so the two coexist and only the colour is read.
//
// `--check` runs in the test suite: the generated project is committed, so a
// re-init that quietly restored the template icons would otherwise ship.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export const SOURCE = "src-tauri/icons/android";
export const TARGET = "src-tauri/gen/android/app/src/main/res";

/** Every file under `dir`, as paths relative to it. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(full.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

/** The files this script owns, and what each should contain. */
export function plan() {
  return walk(SOURCE).map((rel) => ({
    rel,
    source: join(SOURCE, rel),
    target: join(TARGET, rel),
  }));
}

/** Files whose target differs from the source, or is missing entirely. */
export function stale() {
  return plan().filter(({ source, target }) => {
    let current;
    try {
      current = readFileSync(target);
    } catch {
      return true;
    }
    return !current.equals(readFileSync(source));
  });
}

const invokedDirectly = process.argv[1]?.endsWith("sync-android-icons.mjs");
if (invokedDirectly) {
  const outstanding = stale();
  if (process.argv.includes("--check")) {
    if (outstanding.length > 0) {
      console.error(
        `The Android project is not using the app's icons. Run: node scripts/sync-android-icons.mjs\n` +
          outstanding.map((f) => `  ${f.rel}`).join("\n"),
      );
      process.exit(1);
    }
    console.log("Android icons are in step with src-tauri/icons/android");
  } else {
    for (const { source, target, rel } of outstanding) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(source));
      console.log(`wrote ${rel}`);
    }
    if (outstanding.length === 0) console.log("already in step");
  }
}
