#!/usr/bin/env node
// Bump the version in every file that carries it.
//
//   node scripts/bump-version.mjs           # patch bump from package.json
//   node scripts/bump-version.mjs 0.16.0    # an explicit version
//   node scripts/bump-version.mjs --check   # verify the four files agree
//
// Prints the files it wrote, so the release workflow can `git add` exactly
// those rather than a hand-maintained list that drifts from this one.

import { readFileSync, writeFileSync } from "node:fs";
import { nextVersion, VERSIONED_FILES } from "./bump-version-core.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const explicit = args.find((a) => !a.startsWith("--"));

function currentVersion() {
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

/** What each file currently claims, for --check and for the summary line. */
function readVersions() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
  const toml = /^\s*version\s*=\s*"([^"]+)"/m.exec(
    readFileSync("src-tauri/Cargo.toml", "utf8").split("[package]")[1] ?? "",
  )?.[1];
  const lockSrc = readFileSync("src-tauri/Cargo.lock", "utf8").split("\n");
  let lock;
  for (let i = 0; i < lockSrc.length - 1; i++) {
    if (lockSrc[i].trim() === 'name = "multizone"') {
      lock = /"([^"]+)"/.exec(lockSrc[i + 1])?.[1];
      break;
    }
  }
  return { "package.json": pkg, "tauri.conf.json": conf, "Cargo.toml": toml, "Cargo.lock": lock };
}

if (check) {
  const versions = readVersions();
  const distinct = [...new Set(Object.values(versions))];
  for (const [file, v] of Object.entries(versions)) console.log(`  ${file.padEnd(18)} ${v}`);
  if (distinct.length !== 1) {
    console.error(`\nVersions disagree: ${distinct.join(", ")}`);
    console.error("Run: node scripts/bump-version.mjs " + versions["package.json"]);
    process.exit(1);
  }
  console.log(`\nAll four agree on ${distinct[0]}`);
  process.exit(0);
}

const version = explicit ?? nextVersion(currentVersion());

const written = [];
for (const { path, apply } of VERSIONED_FILES) {
  const before = readFileSync(path, "utf8");
  const after = apply(before, version);
  if (after !== before) {
    writeFileSync(path, after);
    written.push(path);
  }
}

console.log(version);
for (const p of written) console.error(`  wrote ${p}`);
