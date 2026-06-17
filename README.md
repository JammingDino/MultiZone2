# MultiZone

A desktop LLM chat application built with Tauri + React + Rust. Supports multiple named "zones" (LLM configurations), perspective mode (send the same message to several zones simultaneously), projects, tags, file attachments, and an extensible tool system including web search.

## Requirements

| Tool | Version |
|------|---------|
| [Node.js](https://nodejs.org/) | 18+ |
| [Rust](https://rustup.rs/) | 1.77+ |
| [Tauri CLI prerequisites](https://tauri.app/start/prerequisites/) | — |

On Windows, Tauri also requires the [WebView2 runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10/11) and the MSVC build tools (via Visual Studio Build Tools or Visual Studio).

## Dev

```bash
npm install
npm run tauri dev
```

This starts the Vite dev server on `http://localhost:1420` and launches the Tauri window. Hot-reload is active for the frontend; the Rust backend recompiles and relaunches automatically on file changes.

First run compiles all Rust dependencies — expect 2–5 minutes. Subsequent runs are faster.

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

## Configuration

On first launch, go to **Settings** to add a provider (any OpenAI-compatible API endpoint + key), then create a **Zone** pointing at that provider and choosing a model.

### Web search tool

The `web_search` tool is available per-zone and works out of the box with no API key. In the zone editor, enable the tool and optionally configure the provider via `tool_config`:

```json
{
  "web_search": {
    "provider": "multi"
  }
}
```

| Provider | Requires | Notes |
|----------|----------|-------|
| `multi` | nothing | **Default.** DDG Lite + Marginalia in parallel, deduped by domain. |
| `duckduckgo` | nothing | DDG Lite HTML scraping (Bing-derived index). |
| `marginalia` | nothing | [Marginalia](https://search.marginalia.nu/) JSON API — independent crawler, great for technical content. |
| `searxng` | `endpoint` | Self-hosted SearXNG instance URL. |
| `brave` | `api_key` | [Brave Search API](https://api.search.brave.com/). |
| `tavily` | `api_key` | [Tavily](https://tavily.com/). |
| `serper` | `api_key` | [Serper](https://serper.dev/) (Google via API). |

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
    tools/              Tool implementations (web_search, code_exec, ...)
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
- **Rendering**: react-markdown, KaTeX, Mermaid, PDF.js
