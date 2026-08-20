// Tests for the version bump.
//
// The bug these exist to prevent already shipped once: the workflow updated
// three of the four files that carry the version, and main sat with
// Cargo.toml 0.15.6 against Cargo.lock 0.15.5 for two releases. So the tests
// that matter are the ones asserting *every* file moves, and that the narrow
// matches stay narrow.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bumpCargoLock,
  bumpCargoToml,
  bumpPackageJson,
  bumpTauriConf,
  nextVersion,
  VERSIONED_FILES,
} from "./bump-version-core.mjs";

test("the patch number goes up, and only the patch number", () => {
  assert.equal(nextVersion("0.15.6"), "0.15.7");
  assert.equal(nextVersion("1.0.0"), "1.0.1");
  assert.equal(nextVersion("0.9.99"), "0.9.100");
});

test("a version that isn't semver fails loudly rather than producing NaN", () => {
  assert.throws(() => nextVersion("0.15"), /not a semver/);
  assert.throws(() => nextVersion("v0.15.6"), /not a semver/);
  assert.throws(() => nextVersion(""), /not a semver/);
});

test("package.json takes the version and always disarms the release flag", () => {
  const src = JSON.stringify({ name: "multizone", version: "0.15.6", releaseBuild: true }, null, 2);
  const out = JSON.parse(bumpPackageJson(src, "0.15.7"));
  assert.equal(out.version, "0.15.7");
  assert.equal(out.releaseBuild, false);
});

test("package.json keeps its other fields and stays newline-terminated", () => {
  const src = JSON.stringify({ name: "multizone", version: "0.1.0", scripts: { dev: "vite" } }, null, 2);
  const text = bumpPackageJson(src, "0.1.1");
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text).scripts, { dev: "vite" });
});

test("tauri.conf.json takes the version", () => {
  const src = JSON.stringify({ productName: "MultiZone", version: "0.15.6" }, null, 2);
  assert.equal(JSON.parse(bumpTauriConf(src, "0.15.7")).version, "0.15.7");
});

test("Cargo.toml bumps the [package] version", () => {
  const src = '[package]\nname = "multizone"\nversion = "0.15.6"\nedition = "2021"\n';
  assert.match(bumpCargoToml(src, "0.15.7"), /^version = "0\.15\.7"$/m);
});

test("Cargo.toml does not touch a dependency that has its own version key", () => {
  const src =
    '[package]\nname = "multizone"\nversion = "0.15.6"\n\n[dependencies]\nserde = { version = "1.0" }\nversion = "not-a-package"\n';
  const out = bumpCargoToml(src, "0.15.7");
  assert.match(out, /\[package\][\s\S]*version = "0\.15\.7"/);
  assert.match(out, /version = "not-a-package"/, "the dependencies section must be left alone");
  assert.match(out, /serde = \{ version = "1\.0" \}/);
});

test("Cargo.lock bumps the workspace package — the file the workflow forgot", () => {
  const src = '[[package]]\nname = "multizone"\nversion = "0.15.5"\ndependencies = [\n "axum",\n]\n';
  assert.match(bumpCargoLock(src, "0.15.7"), /name = "multizone"\nversion = "0\.15\.7"/);
});

test("Cargo.lock leaves every dependency's pinned version alone", () => {
  const src =
    '[[package]]\nname = "axum"\nversion = "0.7.9"\n\n[[package]]\nname = "multizone"\nversion = "0.15.5"\n\n[[package]]\nname = "serde"\nversion = "1.0.219"\n';
  const out = bumpCargoLock(src, "0.15.7");
  assert.match(out, /name = "axum"\nversion = "0\.7\.9"/);
  assert.match(out, /name = "serde"\nversion = "1\.0\.219"/);
  assert.match(out, /name = "multizone"\nversion = "0\.15\.7"/);
});

test("a missing entry throws rather than silently writing nothing", () => {
  assert.throws(() => bumpCargoLock('[[package]]\nname = "axum"\nversion = "0.7.9"\n', "1.0.0"), /no \[\[package\]\] entry/);
  assert.throws(() => bumpCargoToml('[dependencies]\nserde = "1"\n', "1.0.0"), /no \[package\] version/);
});

test("all four versioned files are covered, so none can be forgotten again", () => {
  assert.deepEqual(
    VERSIONED_FILES.map((f) => f.path),
    ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"],
  );
});

test("the real repo files all agree on one version", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
  const toml = /^\s*version\s*=\s*"([^"]+)"/m.exec(
    readFileSync("src-tauri/Cargo.toml", "utf8").split("[package]")[1],
  )[1];
  const lockLines = readFileSync("src-tauri/Cargo.lock", "utf8").split("\n");
  const i = lockLines.findIndex((l) => l.trim() === 'name = "multizone"');
  const lock = /"([^"]+)"/.exec(lockLines[i + 1])[1];

  assert.equal(conf, pkg, "tauri.conf.json disagrees with package.json");
  assert.equal(toml, pkg, "Cargo.toml disagrees with package.json");
  assert.equal(lock, pkg, "Cargo.lock disagrees with package.json — the bump missed it again");
});
