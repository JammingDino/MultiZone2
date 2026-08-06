# Updater manifest

`latest.json` in this directory is what shipped copies of MultiZone poll to
discover updates. It is **generated** — the release workflow writes it via
`scripts/rewrite-updater-manifest.mjs` and commits it alongside the version
bump. Do not edit it by hand; the next release will overwrite it.

It lives in the repository rather than staying a release asset because the
repository is private. The `releases/latest/download/...` URL is a browser
redirect that a token cannot authenticate, whereas `raw.githubusercontent.com`
honours a bearer token — but only for a committed file at a fixed path. That
path is baked into `tauri.conf.json` as the updater endpoint, so it must stay
stable across releases.

The file is absent until the first release is published under this scheme. Until
then the in-app check reports that no manifest was found, which is expected.
