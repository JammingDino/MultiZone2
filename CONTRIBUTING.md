# Contributing to MultiZone

Everything you need to build, run, and change MultiZone. If you just want to *use* the app, see the [README](README.md).

## Requirements

| Tool | Version |
|------|---------|
| [Node.js](https://nodejs.org/) | 18+ |
| [Rust](https://rustup.rs/) | 1.85+ |
| [CMake](https://cmake.org/download/) | 3.x |
| [NASM](https://www.nasm.us/) | 2.15+ |
| [Tauri CLI prerequisites](https://tauri.app/start/prerequisites/) | — |

On Windows, Tauri also requires the [WebView2 runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10/11) and the MSVC build tools (via Visual Studio Build Tools or Visual Studio).

### Native build dependencies (0.9.7+)

**CMake and NASM must be installed and on `PATH`.** The smart web tools use [`wreq`](https://crates.io/crates/wreq), a browser-impersonating HTTP client that links BoringSSL, which is compiled from C and assembly at build time. Without NASM the build fails in `boring-sys2` with:

```
CMake Error at CMakeLists.txt:50 (enable_language):
  No CMAKE_ASM_NASM_COMPILER could be found.
```

On Windows: `choco install nasm` (in an **elevated** shell) or [download it](https://www.nasm.us/) and add the install directory to `PATH`. A C/C++ compiler is also required — on Windows the MSVC build tools above cover it. Upstream additionally lists Perl and pkg-config as prerequisites on some platforms (not needed for a Windows/MSVC build).

This is the one place the project accepts a native toolchain dependency, and it is a deliberate trade: keyless search engines fingerprint an ordinary Rust HTTP client's TLS as "not a browser" and answer it with an anti-bot challenge, so without a real browser fingerprint the web tools return nothing. It buys search that actually works, without shipping a headless browser. `wreq` also raised the minimum Rust version to 1.85.

Voice dictation (0.8.0+) adds **no** build dependencies of its own: microphone capture (`cpal`) and WAV encoding (`hound`) are pure Rust, and transcription is done by a user-configured provider's OpenAI-compatible `/audio/transcriptions` endpoint at runtime. On-device transcription is available by pointing that provider at a local server (e.g. LM Studio serving a whisper model), so there is no embedded speech engine.

## Dev

```bash
npm install
npm run tauri dev
```

This starts the Vite dev server on `http://localhost:1420` and launches the Tauri window. Hot-reload is active for the frontend; the Rust backend recompiles and relaunches automatically on file changes.

First run compiles all Rust dependencies, including BoringSSL from source — expect 3–8 minutes. Subsequent runs are much faster (BoringSSL is cached and only rebuilds if you clean the target directory).

## Build

```bash
npm install
npm run build          # type-check + bundle frontend only
npm run tauri build    # full release build (frontend + Rust + installer)
```

The release installer is written to `src-tauri/target/release/bundle/`.

## Releasing via GitHub Actions

Builds are not triggered on every push. To publish a release:

1. Set `"releaseBuild": true` in `package.json`
2. Commit and push to `main`

GitHub Actions will build the MSI and NSIS installers, publish a GitHub Release tagged with the current version, then automatically reset `releaseBuild` back to `false` and bump the patch version in the same commit.

## Project structure

```
src/                    React + TypeScript frontend
  components/           UI components (Chat, Sidebar, Settings, Zones, ...)
  lib/                  Tauri IPC bindings, types, utilities
  store/                Zustand app state
src-tauri/
  src/
    api/                Local HTTP API (axum) -- REST + SSE
    commands/           Tauri IPC command handlers
    db/                 SQLite models and migrations
    llm/                LLM client, streaming, thinking blocks
    tools/              Tool implementations (smart_search/fetch/crawl, code_exec, ...)
docs/
  ROADMAP.md            Vision, principles, and release themes
  RELEASE_PLAN.md       Detailed per-release work items
  COMPETITORS.md        Competitive analysis
```

## Tech stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS
- **Desktop**: Tauri 2 (Rust)
- **State**: Zustand
- **Database**: SQLite via sqlx
- **HTTP**: reqwest (rustls) app-wide; [wreq](https://crates.io/crates/wreq) (BoringSSL, browser TLS/HTTP-2 fingerprint) for the smart web tools
- **Rendering**: react-markdown, KaTeX, Mermaid, PDF.js

## Background effects

Background effects live in a single file, [`src/components/BackgroundEffect.tsx`](src/components/BackgroundEffect.tsx). Adding one is three edits:

1. Add the id to the `BackgroundEffect` union in [`src/store/app.ts`](src/store/app.ts).
2. Add `[id, "Label"]` to `BACKGROUND_EFFECTS` in [`src/components/Settings/SettingsModal.tsx`](src/components/Settings/SettingsModal.tsx), and to the density-slider list if it has a meaningful density.
3. In `BackgroundEffect.tsx`, add the id to `CANVAS_EFFECTS` (canvas-drawn) or branch on it at the bottom (CSS-driven), then write a `draw*` function and wire it into the `frame()` switch.

Conventions the existing effects follow, and new ones should too:

- Every effect reads `speed`, `density`, `opacity` and the resolved effect colour, so the shared sliders all mean something.
- Colour comes from `tint(i, n)` rather than a hardcoded rgb string. That helper spreads hues around the base colour by the user's **Hue variation** slider — pass a stable per-object index so an object keeps its hue frame to frame.
- The cursor should do something. Repel, attract, highlight, part the flock — an effect that ignores the mouse reads as a static wallpaper.
- Motion must not depend on the cursor. Everything keeps moving when the mouse is still.
- State lives in `dataRef.current`, allocated once in `init()` and re-allocated on resize. Never allocate per frame in a draw loop.
- The canvas is `pointer-events-none` and sits at `z-0`; it must never intercept clicks.

## API and tools

The local HTTP API is documented for users in the [README](README.md#http-api). Its handlers are in `src-tauri/src/api/`, and it drives the same agentic loop as the GUI — a change to tool dispatch affects both.

## Pull requests

- Keep the existing code's style: comments explain *why*, not *what*.
- Run `npm run build` before opening a PR — it type-checks the whole frontend.
- Contributions are accepted under the [Apache License 2.0](LICENSE).
