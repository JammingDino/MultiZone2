# Connectivity — the local API and connectors

Notes behind the 0.11.x and 1.2.x entries in [RELEASE_PLAN.md](RELEASE_PLAN.md). Two questions that turned out to be the same question: *can the app set itself up, so that connecting it to things is not a job for someone who reads code?*

Written August 2026, against 0.10.1. **Part 1 was built as 0.11.0** — the route index, the honest health check, the persisted bind outcome and the drift test all landed, and the ten routes became 105.

**The API tool landed too**, as `app_read` / `app_control`. It went one step further than the design below asked for: rather than attaching the token in Rust, it serves the request through the same `axum` router in-process, so there is no socket, no port, and no token *anywhere* in the path — and the tool works whether or not the user has switched the HTTP server on, which is the common case for someone who has never wanted remote access. The write side of the API also learned to tell an open window what it changed, so a preference or a zone changed by a model or a script is visible in the app immediately instead of at the next restart. **Connectors were built as 0.11.2**, and the catalog turned out to matter more than the header
column did. Routes 1 and 2 below both landed: `headers` is a column applied in `HttpConn::send`, and
the catalog is a compiled-in JSON file plus anything in `<app_data_dir>/connectors/`, importable from
a URL. The third piece was not in the original sizing — a *diagnosis*, which runs the checks in the
order they can fail and reports the first false one. That is what makes a catalog entry survive
contact with a real machine: the entry knows what `TAVILY_API_KEY` is for, so the app can say it is
missing instead of reporting a child process that exited. What remains open is route 3, real OAuth,
which is still 1.2.x and still a verification process rather than a sprint.

---

## Part 1 — the local HTTP API

### What it actually exposes

Ten routes, in [api/mod.rs](../src-tauri/src/api/mod.rs):

| | |
| --- | --- |
| `GET /api/health` | unauthenticated; returns `{status, name, version}` |
| `GET` | `/api/zones` · `/api/projects` · `/api/tags` · `/api/chats` |
| `POST` | `/api/chats` · `/api/chats/:id/messages` (SSE) · `/api/chats/:id/zone` · `/api/chats/:id/regenerate` · `/api/chats/:id/cancel` |
| `GET`/`POST`/`DELETE` | `/api/chats/:id/perspectives` |

That is the 0.5.x app. It is not the 0.10.x app.

### What the API cannot see

Everything built since subchats. None of these have a route:

- **Skills** — list, create, enable/disable. Written by the model since 0.9.2 and invisible externally.
- **Memory** — the three scopes, read and write.
- **MCP** — servers, their tools, danger levels. Ironic given MCP is how everything else connects to us.
- **Knowledge / RAG** — indexes, status, search.
- **Providers and zones as writes** — zones are readable, not creatable. A script cannot provision the app.
- **App settings** — including the API's own configuration.
- **Subchats** — spawned, listed and read by tools; not by the API.
- **Checkpoints** (0.10.x), **terminals** (0.9.11), **usage/cost** (0.9.4), **tool usage counters** (0.9.3), **teamwork claims** (0.9.10).

The pattern is consistent: the API was written once, alongside subchats, and every release since added Tauri commands without a matching route. There is no test that notices, and no generated route index, so the drift is silent and the README's table is the only record — itself hand-maintained.

### Why using it is a struggle

Four distinct problems, worth separating because they have different fixes:

1. **Nothing tells you the port.** It lives in `app_settings.apiPort` (default 8765) inside the SQLite blob. A caller outside the app has no way to discover it, and neither does a model inside the app.
2. **Nothing tells you it is running.** `apply_api_settings` binds the socket and reports bind errors synchronously to the *Settings UI*, but nothing persists that outcome. If the port was taken, the toggle looks on and the server is not there. `/api/health` answers only if it is already working, which is the case where you didn't need to ask.
3. **The health check is content-free.** `{status: "ok"}` proves a socket. It does not say which routes exist, which app version's route set that is, whether the token is set, or whether the caller's token is the right one — the four things a caller actually needs.
4. **The token is a copy-paste ritual.** Generated in Settings, pasted into a shell. Fine for the person who built it, a wall for anyone else.

### The shape of the fix

**A tool that proxies, rather than a tool that hands over credentials.** The tempting design is a tool that returns the port and token so the model can `http_request` its way around. That puts a live bearer token into the model's context, where it is one prompt injection away from leaving the machine — and this app's whole premise is that nothing leaves the machine unless the user sends it. Instead the tool should *make the call itself*: the model names a route and a body, the tool attaches the token in Rust, and the token is never a token the model has seen.

**A self-check that distinguishes the failure modes.** "Is it on in settings", "is the socket bound", "does it answer", "does the token work", "does its route set match this build" are five different answers, and today they collapse into one unhelpful `ok`. A model asked "why can't I reach the API" needs the one that is false.

**A route index the API serves about itself.** `GET /api/routes` returning method, path and a one-line description, generated from the router rather than hand-written, so the README table and the API cannot disagree and a caller can discover the surface without reading Rust.

**A drift test.** The reason the API is out of date is that nothing failed when it fell behind. A test asserting every Tauri command has either a route or an explicit "GUI-only" exemption turns the next omission into a build failure instead of a discovery six releases later.

---

## Part 2 — connectors

> *"Are there any easy ways to have a Google connection where it can access Gmail, Google Maps, Google Calendar? Or is that another huge piece of work?"*

Both, depending on which of three routes you take.

### What MCP already gives us

MCP support ([mcp/mod.rs](../src-tauri/src/mcp/mod.rs)) speaks two transports:

- **stdio** — spawns a local command, JSON-RPC over its stdin/stdout. The `McpServer` row carries `env`, a JSON object of environment variables handed to the child.
- **sse / streamable HTTP** — POSTs JSON-RPC to a URL.

**The stdio path already works for Google today.** Community Google MCP servers (Gmail, Calendar, Drive) are overwhelmingly stdio processes launched with `npx`, taking credentials through environment variables or a credentials file path. Everything they need — the command, the args, the env — is already a field on `McpServer`, and the Windows `npx`/PATHEXT resolution problem was fixed in 0.9.5. Someone who can get through Google Cloud Console can wire Gmail into a zone right now.

**The HTTP path cannot authenticate at all.** *(Fixed in 0.11.2 — recorded as written, because it was the single highest-value thing in this document and worth remembering as a shape of bug.)* `HttpConn::send` set `Content-Type`, `Accept` and `Mcp-Session-Id` and nothing else — there was no `Authorization` header, and `McpServer` had no field to hold one. Every hosted/remote MCP connector, which is where the ecosystem has been moving, was therefore unreachable. A one-column gap with a whole-ecosystem consequence.

### The three routes to Google, honestly sized

| Route | What it takes | Size |
| --- | --- | --- |
| **1. Curated stdio catalog** | Ship known-good MCP server entries (command, args, required env, a link to where the credential comes from) as installable presets. No protocol work at all — this is the zone library pattern applied to `McpServer` rows. | **Small.** The "open-source repository of connections you can copy over" that other tools ship. Reuses machinery we already have. |
| **2. Headers + static tokens on HTTP transport** | A `headers` JSON column on `McpServer`, applied in `HttpConn::send`, and a place to keep the value that is not the tool-visible context. Unlocks every remote MCP server that takes a bearer token or API key. | **Small-to-medium.** One column, one header loop, one settings field. |
| **3. Real OAuth — "Connect Google" as a button** | An OAuth client (Google requires a Cloud project and a verified consent screen for restricted scopes like Gmail), a loopback redirect listener, token exchange, refresh-token storage in the OS keychain rather than SQLite, per-scope consent UI, and revocation. Then the same again per provider. | **Large, and mostly not MCP work.** This is the "huge piece" — and the verification review for Gmail scopes is a process, not a sprint. |

Routes 1 and 2 together get a non-technical user most of the way: a catalog entry that says "Gmail — paste the token from here" is a very different experience from "configure a stdio MCP server", and it needs no OAuth. Route 3 is what makes it one click, and should not be attempted before 1.0.

### Where the guided part comes in

The reason to build the API self-check tool and the connector catalog in the same release is that they are the same feature from the user's side. A zone that can read the connector catalog, check whether a server is reachable, and report *why* it is not — "the command `npx` ran but the server exited: `GOOGLE_CREDENTIALS_PATH` is not set" — is a setup wizard that happens to be a conversation. That is the thing non-technical users are missing, not another settings panel.

The line to hold, per the roadmap's principles: the model may *propose* configuration and *diagnose* it, and the user approves the write. Letting a model silently add an MCP server that launches a process is exactly the capability an injected prompt would want.

---

## Sources

- [api/mod.rs](../src-tauri/src/api/mod.rs) — the router, as of 0.10.1
- [mcp/mod.rs](../src-tauri/src/mcp/mod.rs) — transports and connection handling
- [commands/api.rs](../src-tauri/src/commands/api.rs) — port/token config and server lifecycle
- [README.md](../README.md#L138) — the hand-maintained route table
