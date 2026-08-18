// Rewrite a release's `latest.json` so a private repository can still serve
// updates, and commit it to a stable path in the repo.
//
// Two things break the stock setup once the repository goes private:
//
//   1. The manifest URL. `github.com/<owner>/<repo>/releases/latest/download/...`
//      is a browser redirect that a PAT cannot authenticate, so the updater just
//      gets a 404. `raw.githubusercontent.com` *does* honour a bearer token, but
//      only for a committed file — hence writing the manifest into the repo at a
//      fixed path (`updater/latest.json`) rather than leaving it as a release
//      asset. That path never changes, which is what the endpoint needs.
//
//   2. The bundle URLs *inside* the manifest. `browser_download_url` has the
//      same problem. The API's asset endpoint
//      (`/repos/<owner>/<repo>/releases/assets/<id>`) does accept a token, but
//      it is keyed by an asset id that only exists once the release is
//      published — which is why this rewrite happens after the build rather than
//      being something the bundler could emit itself.
//
// The updater plugin sends `Accept: application/octet-stream` on the download,
// which is exactly what makes that endpoint return bytes instead of JSON
// metadata, and it identifies the installer by sniffing the content, so the
// filename disappearing from the URL costs nothing.
//
// Signatures are copied through untouched: they are over the bundle bytes, and
// where those bytes were fetched from is not part of what was signed.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { rewritePlatforms } from "./rewrite-manifest-core.mjs";

const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.RELEASE_TAG;
const token = process.env.GITHUB_TOKEN;
const outPath = process.env.MANIFEST_PATH ?? "updater/latest.json";

if (!repo || !tag || !token) {
  throw new Error("GITHUB_REPOSITORY, RELEASE_TAG and GITHUB_TOKEN are all required");
}

const api = (path) =>
  `https://api.github.com/repos/${repo}${path}`;

const gh = async (url, accept = "application/vnd.github+json") => {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "multizone-release",
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res;
};

const release = await (await gh(api(`/releases/tags/${tag}`))).json();

const manifestAsset = release.assets.find((a) => a.name === "latest.json");
if (!manifestAsset) {
  throw new Error(
    `release ${tag} has no latest.json — the build ran without the signing key, ` +
      `so there is nothing for the updater to read`,
  );
}

const manifest = await (
  await gh(manifestAsset.url, "application/octet-stream")
).json();

// Match each platform back to its asset by the filename the bundler put in the
// URL. Going through the name (rather than assuming one asset per platform)
// keeps this correct if more targets are added later. The mapping itself lives
// in `rewrite-manifest-core.mjs` so it can be tested without a release.
const { mapped } = rewritePlatforms(manifest, release.assets, repo);
for (const { platform, filename, id } of mapped) {
  console.log(`${platform}: ${filename} -> asset ${id}`);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath} for ${manifest.version}`);
