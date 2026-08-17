# Requirements — MultiZone

The durable *what* and *why*. Direction lives in [ROADMAP.md](ROADMAP.md); scheduled work in [RELEASE_PLAN.md](RELEASE_PLAN.md); competitive context in [COMPETITORS.md](COMPETITORS.md).

This document states requirements, not implementation. Where it says "the app must," read it as a constraint any contribution has to respect — not a description of one particular code path. When a requirement and the code disagree, that is a bug in one of them; surface it rather than quietly following the code.

---

## Purpose

MultiZone is a **local-first desktop app for interacting with LLMs**, where the user owns all their data and nothing leaves the machine unless they choose. It spans a spectrum from **fast** (Quick Chat against a base zone) to **thorough** (Multizone mode, where a Response Leader orchestrates sub-agents that challenge each other toward one high-quality answer). It is built to be approachable out of the box while exposing full control to power users.

Everything below serves that purpose. When a proposed change is approachable *or* powerful but breaks local-first or user-ownership, local-first wins.

---

## Personas

The app is designed for four overlapping people. A single user often moves between them.

1. **The solo researcher** — runs cited research sessions across web search and their own documents; cares about traceability (every claim linked to a source), keeping notes organized (projects, tags), and not leaking their reading list to a vendor.
2. **The developer / power user** — points zones at local models (Ollama, LM Studio, llama.cpp) and cloud APIs interchangeably; wants raw tool config, MCP servers, the local HTTP API, file tools scoped to a project directory, and fine control over context.
3. **The local-model operator** — runs everything on-device for privacy or cost, often on small (7B-class) models; needs tools and prompts that a small model can actually use, graceful degradation (OCR for non-vision models, context compaction for small windows), and no forced cloud calls.
4. **The non-technical user** — brings a cloud API key, wants a chat app that works immediately, and should never be *required* to touch tool config, MCP, or memory scopes to get value.

A feature that only serves persona 2 at the expense of persona 4's out-of-the-box experience (or vice versa) is a design smell — see the "approachable surface, power-user depth" principle.

---

## User stories

Concrete scenarios that drive feature decisions. Grouped by persona; each is something a user must be able to accomplish end to end.

**Solo researcher**
- Ask a question, have the model search the web, and get an answer where every factual claim carries an inline citation linked to its source, with a Sources list at the foot of the message.
- Attach PDFs to a chat and have their content grounded into the answer and cited by filename/page.
- Point a project at a folder of documents and ask questions answered from those files (RAG), with retrieved passages shown as citations.
- Organize chats into project folders and tag them, and later find them by project or tag.
- Export a finished research chat as Markdown or a themed PDF to share outside the app.

**Developer / power user**
- Configure several zones (different provider/model/tool/prompt combinations) and switch a chat between them.
- Give a zone file tools scoped to a project directory and have it read, search, create, move, and (with approval) delete files there — without being able to escape that root.
- Connect an MCP server, set a danger level per tool, and enable specific MCP tools per zone alongside built-in tools.
- Drive the app from a script via the local HTTP API — create a chat, pick a zone, stream a response — using the same agentic loop the GUI uses.
- Send one message to several zones at once (perspective mode) and compare their answers side by side.

**Local-model operator**
- Run a full session — chat, tools, voice — entirely on-device by pointing every provider at a local server, with anything that would leave the machine clearly marked.
- Attach an image to a chat using a text-only model and have it OCR'd rather than dropped.
- Have a long conversation stay coherent past the model's context window via model-driven context compaction.
- Read a small model's tool list in plain English and understand each tool without knowing its machine name.

**Non-technical user**
- Install, launch, add one provider + key, and start chatting — without opening a terminal or editing JSON.
- Use Quick Chat without ever having to understand what a "zone" is.
- Dictate a message and have a response read back aloud, hands-free.

**Multizone (flagship)**
- Start a session with a Response Leader and a roster of sub-agents, watch the orchestration unfold in an inline stack tracer, and receive one synthesized answer — with every sub-agent transcript inspectable.

---

## Functional requirements

What the app must do. Stated as requirements; the release plan tracks which are built.

### Zones & chat
- Every chat must be grounded in a **zone** (a named provider + model + system prompt + tool set + appearance). There is **no zone-less state** — Quick Chat inherits a configurable base zone, never a bare provider/model pair.
- The app must support any **OpenAI-compatible** provider (cloud or local server) via user-configured provider rows; there is no fixed vendor list.
- A user must be able to create, edit, duplicate, export, and delete zones, and browse/install curated and user-saved zones from a **zone library**.
- **Perspective mode**: one message may be sent to several zones at once (sequential or parallel); each response renders identically, distinguished only by zone avatar/accent. Perspective zones are equal participants and may use tools.
- **Smart routing**: a chat may let a router pick the best zone per turn.
- A user must be able to branch a chat from any message, and edit any assistant response in place.

### Organization & context
- Chats may be grouped into **projects** (with a default zone, context snippet, and scoped directory) and labelled with **tags** (with their own context snippets). Project and tag context injection is per-chat toggleable and transparent (the user can see exactly what is prepended).
- **Skills**: on-demand instruction sets the model discovers and loads itself (progressive disclosure), managed globally, enable/disable per skill. A zone may author skills, which are created disabled pending user review.
- **Memory**: model-managed facts at three scopes — global, project, chat — always visible and editable by the user.

### Tools
- Tools are selectable per zone, grouped by category, with plain-English names/descriptions distinct from the machine names the model sees; descriptions are editable per zone.
- The built-in set must cover: web search, read-a-page (URL extract), file read/write/search/manage, local-file (RAG) search, chart/diagram rendering, HTTP request, plan, context compaction, sub-agent spawn/send/read, memory, skills, and `ask_user`.
- Every tool carries a **safety level** (safe / moderate / dangerous). Moderate and dangerous calls require explicit user approval before executing; approvals are visible and stoppable, and cancelling a turn denies all pending approvals.
- File tools must be **scope-checked** to the chat's allowed roots (project directory or app default) — no tool may read or write outside them.
- **MCP** servers are first-class: added in settings, tools discovered and shown with schema, danger level set per tool, enabled per zone, and routed through the same approval/execution pipeline as built-in tools.

### Orchestration
- A zone may spawn and drive **subchats** (sent by a zone, not the user), visible read-only in the sidebar under the parent, with a configurable depth limit.
- A **Response Leader** zone orchestrates sub-agents, is the only agent that talks to the user, and presents opposing views to stress-test ideas. The leader→sub-agent call tree is visible in an inline **stack tracer**.

### Research & sources
- Web search must work out of the box with no API key (with optional configured providers).
- Non-vision models must degrade gracefully: images/PDFs are OCR'd or text-extracted rather than dropped, with a visible indicator.
- Claims grounded in a source (web, file, or local-file search) must be traceable via inline `[n]` citations + a Sources list.

### Voice
- Dictation (STT) and spoken responses (TTS) must be available via any OpenAI-compatible provider endpoint, combinable into a hands-free conversation mode with barge-in. On-device voice is available by pointing the provider at a local server.

### Interoperability & data
- A **local HTTP API** (bound to `127.0.0.1`, bearer-token auth) must expose the same agentic loop as the GUI for external scripts.
- Chats may be exported as Markdown or themed PDF, and optionally mirrored to `.md` files on disk with two-way sync.
- All persistent state lives in local SQLite; user-facing preferences must survive app updates.

---

## Non-functional requirements

- **Local-first / privacy.** Nothing leaves the machine unless the user explicitly sends it. No telemetry, no analytics, no cloud sync. Any network egress (a cloud provider, an API-based search/voice endpoint) must be user-initiated and clearly marked as leaving the machine.
- **User ownership & control.** The user's data is local, inspectable, and portable (SQLite + optional markdown mirror + export). The user can always see and stop what an agent is doing; dangerous operations are gated behind approval; the model never silently rewrites its own instructions or acts outside its allowed roots.
- **Portability.** Windows, macOS, and Linux, from one codebase. The build avoids native C/C++ toolchain dependencies (no bundled Tesseract, no whisper.cpp/`libclang`/CMake requirement) — pure-Rust equivalents or provider endpoints are preferred so the cross-platform build stays clean.
- **Approachability.** The app must be usable end to end without opening a terminal or editing JSON: install, add a provider, chat. Power-user surfaces (raw tool config, MCP, memory scopes) are available but never required.
- **Performance.** Startup, first-message render, streaming, and large-chat (500+ messages) scroll must stay responsive. Streaming must not drop tokens or stall the UI under sustained use.
- **Robustness.** A failing tool call, provider error, or malformed model output must degrade gracefully — surfaced to the user, never a silent hang or a crash. Best-effort side channels (usage stats, markdown mirror, memory trimming) must never fail or block a turn.
- **Small-model friendliness.** Tool names, descriptions, and prompts must work for small local models, not only frontier ones — this is a first-class constraint, not a nicety.
- **Security.** The local HTTP API binds to loopback only and requires a bearer token. Tool safety levels and scope checks are the security boundary for model-initiated actions; they must not be bypassable via aliases, path traversal, or MCP.

---

## Out of scope

Stated explicitly so the app can say no clearly. These are deliberate non-goals for the 1.0 line (some are tracked as post-1.0 backlog, not commitments).

- **Cloud sync, accounts, and multi-user/team features.** MultiZone is single-user and local. Shared zones/projects and access control are post-1.0 at most.
- **Telemetry / usage analytics.** Not collected, not optional-opt-in — simply absent.
- **A hosted or bundled model runtime.** MultiZone does not embed an inference engine, a speech engine, or an embedding-model host. "Local" means the user points a provider row at a local server (Ollama, LM Studio, llama.cpp, a local whisper/TTS shim). This keeps the build native-dependency-free and the architecture uniform.
- **A fixed vendor integration list.** No first-party "OpenAI plugin" / "Anthropic plugin" special-casing; everything is an OpenAI-compatible provider row.
- **A general web browser / JS-rendering scraper.** URL extract reads static HTML; JS-only pages return what they ship. A headless-browser depth mode is out of scope for the pure-Rust line.
- **A code interface / IDE.** A Claude-Code-style coding surface over local models is a post-1.0 backlog item, gated on the RAG foundation — not a 1.0 feature.
- **Mobile as a standalone app.** Desktop first. The backlog item is a Tauri mobile target that is a *remote* for your desktop — same chats and zones, but every message is run by the machine at home, over the LAN, with pairing by code and per-device tokens. A phone that ran its own models and kept its own store would be the cloud sync refused above; a remote client has no second copy to sync. Post-desktop-stable, LAN-only, and never a relay through anyone's server.
- **Latent-space multi-agent orchestration.** Attractive for Multizone efficiency but not implementable at the app layer (needs inference-engine latent I/O + a training pass) — tracked in the backlog, not scoped.

---

*See [COMPETITORS.md](COMPETITORS.md) for how these lines compare to what the landscape expects, and [ROADMAP.md](ROADMAP.md) for the principles behind them.*
