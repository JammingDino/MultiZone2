// The pure half of the updater manifest rewrite, so it can be tested.
//
// The rewrite is the piece of the update path that a local end-to-end test
// cannot exercise — it only runs against a real published release, where a
// mistake means every existing install stops updating and nobody finds out
// until someone checks. Separating it from the fetching makes it a function
// with fixtures instead of something only production can prove.

/**
 * Point every platform's download URL at the API asset endpoint, which accepts
 * a bearer token — `browser_download_url` does not, and on a private repository
 * that is a 404 for every updating install.
 *
 * Mutates and returns `manifest`. Signatures are left alone: they are over the
 * bundle bytes, and where those bytes were fetched from was never part of what
 * was signed.
 *
 * @param manifest  the `latest.json` as published by the bundler
 * @param assets    the release's assets, each `{ name, id }`
 * @param repo      "owner/name"
 * @returns {{ manifest: object, mapped: Array<{platform: string, filename: string, id: number}> }}
 */
export function rewritePlatforms(manifest, assets, repo) {
  if (!repo) throw new Error("repo is required");
  const byName = new Map(assets.map((a) => [a.name, a]));
  const mapped = [];

  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    const filename = filenameFrom(entry.url);
    const asset = byName.get(filename);
    if (!asset) {
      throw new Error(`no asset named ${filename} in the release (platform ${platform})`);
    }
    entry.url = `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`;
    mapped.push({ platform, filename, id: asset.id });
  }
  return { manifest, mapped };
}

/**
 * The bundler percent-encodes spaces in installer names, so the asset lookup
 * has to decode before comparing or a product name with a space never matches.
 */
export function filenameFrom(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").pop());
}
