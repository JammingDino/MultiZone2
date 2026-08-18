#!/usr/bin/env node
/**
 * Make sure `dist/` exists, without rebuilding it if it already does.
 *
 * `src-tauri` will not compile at all without `../dist`: `generate_context!()`
 * resolves `frontendDist` at compile time. That is why the old push tier ran
 * `vite build` before `cargo test`.
 *
 * The trouble is that it also *embeds* dist, so a fresh `vite build` invalidates
 * the `multizone` crate on every single run. Measured on this machine: with a
 * rebuilt dist, `cargo test --lib` takes 422 seconds; with dist untouched, 3.
 * Seven minutes per push, every push, bought nothing — the Rust tests do not
 * test the frontend bundle, they just need a file to embed.
 *
 * So: build it if it is missing, leave it alone if it is not. The release tier
 * (`npm run check:all`) still does a real build, which is where a stale bundle
 * would actually matter.
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.html");

if (existsSync(entry)) {
  process.exit(0);
}

console.log("dist/ is missing — building it once so src-tauri can compile.");
execSync("npm run build", { cwd: root, stdio: "inherit" });
