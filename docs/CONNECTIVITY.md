# Connectivity — the local API and connectors

Notes behind the 0.11.x and 1.2.x entries in [RELEASE_PLAN.md](RELEASE_PLAN.md). Two questions that turned out to be the same question: *can the app set itself up, so that connecting it to things is not a job for someone who reads code?*

**Part 3 was added in 0.14.0** and asks the question from the other side: what does it take for something that is *not* on this machine — a phone, a tablet, a second laptop — to reach the app? It turns out to be mostly the same answer, because Part 1 already made the API the whole app. **Part 3 was built as 0.17.x**, in the three stages it was sized as, and the notes at the end of it record what the design got right and the four things it did not anticipate.

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

## Part 3 — the phone as a second window

*Added August 2026, against 0.14.0, when the backlog's one-line "Mobile: Tauri mobile target" was re-scoped. **Built as 0.17.0 (the desktop half), 0.17.1 (the transport) and 0.17.2 (the shell)** — the design below is left as written, with a build note at the end, because the interesting part is which of its predictions survived contact.*

### The premise

The mobile app is **a remote for the desktop, not a second app**. Same chats, same zones, same projects — but you send from the phone and the machine at home runs it, with its providers, its models, its files, its MCP servers. Nothing infers on the phone; nothing is stored there the desktop does not already hold.

Three reasons, since "port the app to a phone" is the obvious alternative:

1. **A phone cannot run a 30B local model**, which is the premise of the product. Whatever ran on the phone would be a different, worse app wearing the same icon.
2. **Every tool that matters needs the desktop.** `read_file`, shell, the knowledge index, an `npx` MCP server — none of them mean anything against a phone's sandbox.
3. **Two stores would have to sync**, and cloud sync is a stated non-goal. A remote client has no second copy, so there is nothing to reconcile — the hard problem is deleted rather than solved.

### What Part 1 already bought

This design is cheap now and would not have been before 0.11.0:

- **The API is the whole app.** 105 routes, a generated `/api/routes` index, and a drift test that fails the build when a Tauri command gains no route and no stated GUI-only reason. A remote client is not limited to the ten routes of the 0.5.x API.
- **Streaming already works over HTTP.** `POST /api/chats/:id/messages` runs the same agentic loop as the GUI and streams it as SSE. That is the hard half of a chat client.
- **The frontend has one seam.** Every backend call goes through [src/lib/tauri.ts](../src/lib/tauri.ts) — `invoke` for commands, `listen` for events — with a short list of window-chrome exceptions (`getVersion`, window controls, `downloadDir`, `saveFile`). Implement that module's surface against HTTP + SSE and the existing React app *is* the mobile client. The port is a transport, not a rewrite.

### The four things that do not exist

**1. A LAN bind, opt-in and honest.** The server binds `127.0.0.1` today, which is why nothing on the network can reach it. A remote client needs the app reachable from the LAN, and that is a genuinely different security posture from "a socket only this machine can open" — so it is its own switch, not a side effect of turning the API on. Bind to the selected interface rather than `0.0.0.0`, show the address the phone should use, and say plainly in the UI that the app is now on the network.

**2. Pairing, replacing the pasted token.** Today's auth is one static bearer token, generated in Settings and copy-pasted. That does not survive contact with a phone: it is long, it is typed by hand, it is the same secret for every device, and revoking it logs out everything at once.

Instead:

- The desktop shows a **short code** — six digits, single-use, expiring in a few minutes — and the same payload as a QR (host, port, code) so nothing is typed at all.
- The phone posts the code once and gets back a **per-device token** it stores in the platform keystore.
- The desktop keeps a **device registry**: name, platform, first seen, last seen, and a *hash* of the token, never the token.
- Each device can be revoked on its own. A lost phone is one tap, and no other device notices.

Per-device tokens are what make "it works again next time" and "revoke just that one" the same feature. Pairing endpoints are the only unauthenticated writes on the surface, so they need the treatment that implies: rate-limited, code valid once, attempts logged to the registry, and pairing only possible while the user has the dialog open on the desktop.

**3. Approvals that can be answered from the phone.** A tool approval currently blocks on a desktop dialog. Sending from a phone means a run can stall at a prompt nobody is standing in front of — the same failure the README's "select Everything before a long run" advice is really about. The pending queue needs to be readable and answerable over the API, with the phone able to approve, deny, or leave it. **0.14.2's per-category auto-approval is the prerequisite**: it is what makes an unattended run reasonable rather than a choice between babysitting and *Everything*.

**4. Discovery, so nobody types an IP.** mDNS/Bonjour advertisement on the LAN, with manual host entry as the fallback that always works. Phones move between networks and DHCP moves addresses; a client that only knows an IP is one router reboot from useless.

### Deliberately out of scope

- **Anything from outside the LAN.** No relay, no tunnel, no account. That is cloud sync with a different name, and it is refused for the same reasons.
- **Offline mode on the phone.** If the desktop cannot be reached, the phone says so. A local cache that answers when the desktop is asleep is a second store, which is the thing this design exists to avoid.
- **A different feature set.** If it is worth doing on the phone it is a route, and the drift test already insists routes exist.

The honest failure mode is **the desktop being asleep**, and it belongs in the UI as a stated reason rather than a spinner. A wake-on-LAN affordance is the obvious follow-on and should not be in the first version.

### Sizing

The desktop half is worth building first and stands on its own — a LAN bind, pairing, and a device registry are equally what a tablet, a second laptop, or a script on the network needs, and none of it requires a mobile toolchain. Then the transport shim behind `src/lib/tauri.ts`, which is testable in a desktop browser against a real desktop instance. Then the Tauri mobile shell, which by that point is layout, touch targets, and a pairing screen.

---

## Sources

- [api/mod.rs](../src-tauri/src/api/mod.rs) — the router, as of 0.10.1
- [mcp/mod.rs](../src-tauri/src/mcp/mod.rs) — transports and connection handling
- [commands/api.rs](../src-tauri/src/commands/api.rs) — port/token config and server lifecycle
- [README.md](../README.md#L138) — the hand-maintained route table

---

## Part 3, as built (0.17.x)

The sizing was right and the sequencing was right: the desktop half landed first and was useful before any mobile toolchain existed, the transport was developed in a desktop browser against a real instance, and the shell turned out to be a pairing screen and some CSS.

**The four missing things, and what each actually cost.**

- **The LAN bind** was the smallest and had the sharpest edge. "Bind the selected interface rather than `0.0.0.0`" was the whole design, and the case it does not mention is the one that matters: the laptop moves networks and the chosen address is gone. Falling back to loopback would leave the panel reading "on the network" with a server nothing can reach, and falling back to a *different* network would put the app somewhere the user never picked. So a vanished interface is a named bind error, reported through the same persisted `BindState` row that 0.11.0 added for a port already in use — a piece of machinery built for one failure absorbing a second one it was not designed for.
- **Pairing** came out as designed. Worth recording that the six digits are not what makes it safe: the window only exists while the user is looking at it, the code is single-use, it expires, and **five wrong guesses burn it**. That last one is the load-bearing part and is the one easiest to leave out — without it, a code that lives three minutes is still a few thousand guesses over a LAN.
- **Approvals on the phone** were half-built already and the half that was missing was the interesting one. `POST /api/chats/:id/approval` existed; there was no way to *find out* something was waiting. The pending map held bare `oneshot::Sender`s, which is all the desktop needs because the window that asks is the window that answers. It now carries the call, its arguments, its diff and a countdown.
- **Discovery** worked as sized and is the one piece that is allowed to fail. mDNS is blocked on more networks than anyone expects, and a phone that already knows the address must not be locked out because the desktop could not shout about itself.

**What the design did not anticipate, all four found by building rather than by reading.**

1. **`listen` had no remote half.** The document says "implement that module's surface against HTTP + SSE" and treats it as one job. It is two: `invoke` had a route for everything since 0.11.0, and `listen` had *nothing* — the only SSE on the surface was the one a send opens for its own turn. A window that never hears `chats-changed` shows a stale sidebar after a sub-agent spawns. `GET /api/events` bridges the same `app.listen` the window uses, with an explicit forwarded list, because `pdf-read-request` asks the *window* to do work and a phone cannot serve it.
2. **`POST /api/chats/:id/messages` silently discarded per-turn overrides.** It accepted `overrideZoneId` and ran the chat's own zone. A remote zone picker would have appeared to work and done nothing. Found by writing a client against the route.
3. **The drift test had a blind spot.** It parsed only lines beginning `commands::`, so `pdf_bridge::resolve_pdf_read` had been exempt from the coverage requirement since the test was written in 0.11.0. A drift test with a blind spot is worse than none, because it is trusted. It reads every `module::command` now.
4. **The mobile build had to be a different crate shape, not a different configuration.** The document's "nothing is stored there that the desktop does not already hold" is a promise about behaviour, and a Tauri mobile build compiles the whole lib — SQLite, the agentic loop, MCP, the file tools — into the APK by default. A build that *contained* the database layer and merely chose not to open it is one bug away from breaking the promise. Every module is `#[cfg(desktop)]`; the mobile binary is a WebView with no `invoke_handler` at all. The dependency list is split the same way, in cargo's target terms, so an Android build does not compile BoringSSL and an OCR engine to host a web view.

**One thing the design named that is worth repeating, because building it made it concrete.** Android has forbidden cleartext HTTP by default since API 28 and is right to. This app is the case the rule does not fit — one server, on the user's own LAN, at an IP literal no CA will issue for. The alternative is teaching people to install a self-signed root on their phone, which is materially worse. What makes it acceptable is the out-of-scope list above: nothing here leaves the LAN, so the traffic crosses the user's own router and nothing else.

**Still not built, and still deliberately:** wake-on-LAN, any access from outside the LAN, and any offline mode. The token also lives in the WebView's `localStorage` rather than the platform keystore, which is the one place the implementation is weaker than the design — noted in `transport.ts` rather than quietly.

