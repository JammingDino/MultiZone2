# MultiZone

A desktop LLM chat application built with Tauri + React + Rust. Supports multiple named "zones" (LLM configurations), perspective mode (send the same message to several zones simultaneously), projects, tags, file attachments, and an extensible tool system including web search.

![MultiZone — one prompt, every model, side by side](promo/01-hero.png)

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

Voice dictation (0.8.0+) adds **no** build dependencies of its own: microphone capture (`cpal`) and WAV encoding (`hound`) are pure Rust, and transcription is done by a user-configured provider's OpenAI-compatible `/audio/transcriptions` endpoint at runtime (Settings → Voice). On-device transcription is available by pointing that provider at a local server (e.g. LM Studio serving a whisper model), so there is no embedded speech engine.

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

## Perspective mode

Each zone is its own provider, model, system prompt and toolset — a frontier API, a self-hosted endpoint, or a model on your own GPU. Add a zone as a *perspective* and every message you send fans out to all of them in parallel: one shared thread, independent replies you can read side by side. There is no fixed number — one zone or twenty, whatever you configure.

![How perspective mode works](promo/02-perspectives.png)

## Configuration

On first launch, go to **Settings** to add a provider (any OpenAI-compatible API endpoint + key), then create a **Zone** pointing at that provider and choosing a model.

### Web tools

Web research works out of the box with **no API key and no third-party search service**. Three tools (0.9.7+), based on [Hound](https://github.com/dondai1234/master-fetch):

| Tool | What it does |
|------|--------------|
| `smart_search` | Searches **seven keyless engines in parallel** — DuckDuckGo, Bing, Brave, Yandex, Ecosia, Yahoo, Wikipedia — and merges them with Reciprocal Rank Fusion, so a page several engines agree on ranks highest. If one engine is blocked or rate-limited the others still answer, and the result reports which engines contributed and which failed. |
| `smart_fetch` | Reads one or more pages **or PDFs** in full as clean markdown, boilerplate stripped, with an optional relevance query to trim a long page to what matters. |
| `smart_crawl` | Follows links within one site and reads several pages in a single call, visiting the most relevant first. |

All three run entirely from your machine, through a browser-emulating HTTP client that carries a real Chrome TLS/HTTP-2 fingerprint (see [native build dependencies](#native-build-dependencies-097) above). There is **no headless browser**, so pages that render entirely via JavaScript — or that sit behind an interactive bot challenge — are reported as such rather than returned blank.

Enable them per-zone in the zone editor; they are on by default in the curated research zones.

#### Legacy `web_search` / `extract_url`

The original single-engine tools are still available, mainly for the key-based providers. Configure under **Settings → Web search provider** (applies to every zone with the tool enabled):

| Provider | Requires | Notes |
|----------|----------|-------|
| `duckduckgo` | nothing | **Default.** Single-engine HTML scraping — prone to anti-bot challenges; prefer `smart_search`. |
| `searxng` | `endpoint` | Self-hosted SearXNG instance URL. |
| `brave` | `api_key` | [Brave Search API](https://api.search.brave.com/). |
| `tavily` | `api_key` | [Tavily](https://tavily.com/). |
| `serper` | `api_key` | [Serper](https://serper.dev/) (Google via API). |

## Multizone mode — the Response Leader

Where perspective mode shows you every model's answer, Multizone mode resolves them into one. A zone flagged as a **Response Leader** doesn't answer from its own knowledge: it spawns a panel of sub-agent zones via `spawn_subagent`, briefs each one on a deliberately *opposing* angle rather than forwarding your message, cross-examines them against each other with `send_subchat_message`, and only then writes a single synthesized answer.

The leader is the only agent that can talk to you — sub-agent `ask_user` calls are suppressed — and the whole leader → sub-agent call tree is inspectable inline in the stack tracer, with every subchat transcript openable.

![How the Response Leader works](promo/05-response-leader.png)

Sub-agents don't have to run one at a time. `spawn_subagent`/`send_subchat_message` take `background: true`, which returns the subchat id immediately and runs that sub-agent on its own task — so a leader can put five specialists to work in a single message, keep reading code while they think, and pick every reply up with `collect_subagents`. `list_subchats` shows the sub-agents a conversation already has, and the leader is told to continue one rather than re-brief a fresh copy. Stopping the chat stops its background sub-agents with it.

Turn any zone into one with the **Response Leader** toggle in the zone editor (it auto-enables the subchat tools), or start from the curated "Response Leader" zone in the library.

### Working one codebase together

Sub-agents have always had the real tools — read, write, search, shell — and they inherit the parent chat's project directory. What they lacked was any way to know the others existed, which left only two safe patterns: run them one at a time, or have them hand patches back for someone else to apply. Agents working *against* each other, carefully sequenced.

The **teamwork** tool is the coordination layer that makes them work *alongside* each other instead:

- `claim_files` takes an advisory lock on the files an agent is about to edit, with a stated intent. A write to a file another agent holds is **refused by the tools**, so a claim isn't a convention someone can forget. An unclaimed write auto-claims, so the protection holds even for a zone that never calls the tool; claims expire, and release when the agent's turn ends, so a crashed agent can't own a file forever.
- `post_note` / `team_status` are the session's shared board. Parallel edits only compose if the decisions travel with them — "`parse()` returns None now instead of raising" has to reach whoever is editing the caller, and one sub-agent can't read another's transcript.

Reads are never blocked, and an ordinary single-zone chat never touches any of it.

### Zone teams

Some presets only work as a set. The library's **Teams** section installs one in a single action — a leader plus the specialists it delegates to, all bound to your default model.

The shipped **Code Team** is a general codebase collaboration: talk to **Code Team Lead** like a colleague about a symptom, a feature or a piece of code that annoys you, and it runs the team over your project. It clarifies the ask, has **Code Scout** map the ground, writes the contract the others must honour, then splits the work into file-disjoint slices that **Code Implementer (Careful)** (0.15) and **Code Implementer (Inventive)** (0.85) edit *at the same time* while **Code Test Author** writes the tests against the same contract — with **Code Reviewer** attacking the result and **Code Verifier** running the builds and suites on the combined tree. For a hard bug it switches to compete mode instead: both implementers attack the same problem independently, hand back diffs, and the leader picks on test evidence.

Seven zones on one model at seven temperatures: the value comes from independent attempts and adversarial review, not from a bigger model.

Every member is equipped like an agent you'd actually want on the job — web search and full page reads (an unfamiliar library's real API beats a half-remembered one), skills, the code runner, and shared memory at project scope, which is the durable counterpart to the board: how this repo's tests are run, or a trap someone hit, is injected into every agent on the project, including the ones spawned next week. Before a long run, set **Settings → Chat → Tool auto-approval** to *Everything* (a sub-agent cannot show you an approval prompt) and raise **Task length** to 60 or more.

## HTTP API

MultiZone can expose a local HTTP API so external tools or scripts can drive it like a CLI — listing and creating chats, picking zones/projects, and sending messages with the same agentic loop the GUI uses.

Enable it under **Settings → API**: toggle it on, optionally change the port, and copy the auto-generated bearer token. The server binds to `127.0.0.1` only and every request must include `Authorization: Bearer <token>`.

Base URL: `http://127.0.0.1:8765` (default port).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Liveness check (no auth required). |
| `GET` | `/api/zones` | List zones. |
| `GET` | `/api/projects` | List projects. |
| `GET` | `/api/tags` | List tags. |
| `GET` | `/api/chats` | List chats. |
| `POST` | `/api/chats` | Create a chat. Body: `{ "zoneId"?, "projectId"? }`. |
| `GET` | `/api/chats/:id/messages` | List a chat's messages. |
| `POST` | `/api/chats/:id/messages` | Send a message (see below). |
| `POST` | `/api/chats/:id/regenerate` | Re-run the last turn. |
| `POST` | `/api/chats/:id/cancel` | Cancel the in-flight stream. |
| `POST` | `/api/chats/:id/zone` | Set the primary zone. Body: `{ "zoneId" }`. |
| `GET`/`POST`/`DELETE` | `/api/chats/:id/perspectives` | List/add/remove perspective zones. Body for add/remove: `{ "zoneId" }`. |

Sending a message accepts either `{ "text": "..." }` or `{ "parts": [...] }` (the same content parts the GUI uses). By default the response is a [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream of the same events the GUI receives (tokens, tool calls, etc.). Append `?wait=true` to instead block until the turn finishes and return the final messages as JSON.

```bash
# Create a chat with a specific zone
curl -X POST http://127.0.0.1:8765/api/chats \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"zoneId":"<zone-id>"}'

# Send a message and stream the response (SSE)
curl -N -X POST http://127.0.0.1:8765/api/chats/<chat-id>/messages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello"}'

# Send a message and wait for the final result as JSON
curl -X POST "http://127.0.0.1:8765/api/chats/<chat-id>/messages?wait=true" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello"}'
```

API-driven activity also updates any matching chat open in the app live.

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
