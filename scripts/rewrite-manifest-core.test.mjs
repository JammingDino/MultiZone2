import test from "node:test";
import assert from "node:assert/strict";
import { rewritePlatforms, filenameFrom } from "./rewrite-manifest-core.mjs";

const REPO = "acme/multizone";

function manifest(url) {
  return {
    version: "0.13.0",
    platforms: {
      "windows-x86_64": { signature: "SIG", url },
    },
  };
}

test("a platform URL is repointed at the token-authenticated asset endpoint", () => {
  const m = manifest(
    "https://github.com/acme/multizone/releases/download/v0.13.0/MultiZone_0.13.0_x64-setup.nsis.zip",
  );
  const { mapped } = rewritePlatforms(
    m,
    [{ name: "MultiZone_0.13.0_x64-setup.nsis.zip", id: 4242 }],
    REPO,
  );

  assert.equal(
    m.platforms["windows-x86_64"].url,
    "https://api.github.com/repos/acme/multizone/releases/assets/4242",
  );
  assert.deepEqual(mapped, [
    { platform: "windows-x86_64", filename: "MultiZone_0.13.0_x64-setup.nsis.zip", id: 4242 },
  ]);
});

test("the signature is carried through untouched", () => {
  const m = manifest(
    "https://github.com/acme/multizone/releases/download/v0.13.0/app.nsis.zip",
  );
  rewritePlatforms(m, [{ name: "app.nsis.zip", id: 1 }], REPO);
  assert.equal(m.platforms["windows-x86_64"].signature, "SIG");
});

// The bundler percent-encodes spaces, so comparing the raw path segment against
// the asset name silently fails for any product name containing one — and the
// failure is a release that publishes with unrewritten URLs.
test("a percent-encoded filename still matches its asset", () => {
  const m = manifest(
    "https://github.com/acme/multizone/releases/download/v0.13.0/Multi%20Zone_0.13.0_x64-setup.nsis.zip",
  );
  rewritePlatforms(m, [{ name: "Multi Zone_0.13.0_x64-setup.nsis.zip", id: 7 }], REPO);
  assert.equal(
    m.platforms["windows-x86_64"].url,
    "https://api.github.com/repos/acme/multizone/releases/assets/7",
  );
});

test("a missing asset fails loudly rather than publishing a broken manifest", () => {
  const m = manifest(
    "https://github.com/acme/multizone/releases/download/v0.13.0/app.nsis.zip",
  );
  assert.throws(
    () => rewritePlatforms(m, [{ name: "something-else.zip", id: 9 }], REPO),
    /no asset named app\.nsis\.zip/,
  );
});

test("several platforms are each mapped to their own asset", () => {
  const m = {
    version: "0.13.0",
    platforms: {
      "windows-x86_64": { url: "https://x/y/win.nsis.zip", signature: "A" },
      "darwin-aarch64": { url: "https://x/y/mac.app.tar.gz", signature: "B" },
    },
  };
  rewritePlatforms(
    m,
    [
      { name: "win.nsis.zip", id: 1 },
      { name: "mac.app.tar.gz", id: 2 },
    ],
    REPO,
  );
  assert.match(m.platforms["windows-x86_64"].url, /assets\/1$/);
  assert.match(m.platforms["darwin-aarch64"].url, /assets\/2$/);
});

test("a manifest with no platforms is left alone rather than throwing", () => {
  const m = { version: "0.13.0" };
  const { mapped } = rewritePlatforms(m, [], REPO);
  assert.deepEqual(mapped, []);
});

test("filenameFrom takes the last segment and decodes it", () => {
  assert.equal(filenameFrom("https://h/a/b/c%20d.zip"), "c d.zip");
});
