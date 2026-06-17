# MultiZone

A local-first desktop app for interacting with LLMs. All data stays on your machine. Built with Tauri + React.

## Development

```bash
npm install
npm run tauri dev
```

Requires Rust (stable) and Node 20+.

## Releasing a build

Builds are not triggered on every push. To release:

1. Set `"releaseBuild": true` in `package.json`
2. Commit and push to `main`

GitHub Actions will build the MSI and NSIS installers, publish a GitHub Release tagged with the current version, then automatically reset `releaseBuild` back to `false` and bump the patch version in the same commit.

## Docs

- [docs/ROADMAP.md](docs/ROADMAP.md) — vision, principles, release themes
- [docs/RELEASE_PLAN.md](docs/RELEASE_PLAN.md) — detailed work items per release
- [docs/COMPETITORS.md](docs/COMPETITORS.md) — competitive analysis
