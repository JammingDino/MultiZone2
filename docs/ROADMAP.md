# Roadmap — MultiZone

High-level direction. Detailed work items live in [RELEASE_PLAN.md](RELEASE_PLAN.md).
Competitor context in [COMPETITORS.md](COMPETITORS.md).

---

## Vision

MultiZone is a local-first desktop app for interacting with LLMs where the user owns all their data and nothing leaves the machine unless they choose. The core differentiator is depth of customization — providers, zones, tools, appearance, and context are all user-controlled — and the Multizone mode: a Response Leader orchestrates a set of sub-agents each running their own zone, collaborating and challenging each other's outputs toward a single high-quality result. The app spans a spectrum from fast (Quick Chat via a base zone) to thorough (Multizone mode with full agent orchestration), and is built to be approachable for new users while exposing full control to power users.

## Principles

- **Local-first, user-owned data.** Nothing leaves the machine unless the user explicitly sends it. All storage is local SQLite; no telemetry, no cloud sync.
- **No zone-less state.** Every chat is grounded in a zone. Quick Chat inherits a configurable base zone rather than running against a raw provider.
- **Build components before modes.** Each major mode (Multizone, Deep Research, Code Interface) is assembled from independently useful components — never built whole and retrofitted. A subchat, a memory store, and a spawn-agent tool each stand on their own before they are combined.
- **The user stays in control.** The Response Leader is the only agent that talks to the user. Tool approvals, memory writes, and dangerous operations are always visible and stoppable.
- **Approachable surface, power user depth.** The app works out of the box. Full control — raw tool config, MCP servers, memory scopes, perspective layouts — is there for those who want it, never forced on those who don't.

## Releases

Semantic versioning. Each release is tagged `vMAJOR.MINOR.PATCH`.

| Version | Theme | Status |
| --- | --- | --- |
| **0.1.x** | Foundation & Polish | In progress |
| **0.2.x** | Organization — Zone library, Projects, Tags | Planned |
| **0.3.x** | Context & Knowledge — Skills, Memory, Branching | Planned |
| **0.4.x** | Research & Sources — Web search global, RAG, Citations, MCP, OCR | Planned |
| **0.5.x** | Subchats & Orchestration Infrastructure | Planned |
| **0.6.x** | Multizone Mode | Planned |
| **0.7.x** | Settings rework, UI/UX polish, DB/Markdown toggle | Planned |
| **0.8.x** | Voice I/O — STT dictation, TTS, hands-free mode | Planned |
| **0.9.x** | Tool Improvements — naming clarity, file management, self-authored skills, reliability pass | In progress |
| **0.10.x** | Reversible work — checkpoints, undo, review before apply | Planned |
| **0.11.x** | The app sets itself up — API refresh, an API tool, connector catalog | In progress — API refresh and the API tool done; connectors open |
| **0.12.x** | Planning & task control — plan mode, live task state, replay, chat-window pass | Built — runtime testing open |
| **0.13.x** | Tool visuals — a look for every tool, raw call one click away | Planned |
| **0.14.x** | The agent floor — edit reliability, runaway guardrails, retrieval, spend | Planned |
| **0.15.x** | Smaller lifts — chat search, palette, MCP resources, saved runs | Planned |
| **0.16.x** | In-chat rendering — charts from data, richer artifacts | In progress |
| **1.0.0** | Hardening & Public Release | Planned |
| **1.2.x** | Signed-in connectors — OAuth, keychain, per-scope consent | Planned |
| **Post-1.0** | Code interface + edit engine, study mode, shared mode surface, moddable app surface, Diffusion LLM, Mobile | Backlog |

---

### 0.1.x — Foundation & Polish

Everything currently built works correctly and consistently. The no-zone state is eliminated — Quick Chat inherits a configurable base zone. All known bugs are resolved: list_dir becomes token-efficient with a depth argument, Gemma thinking is supported, the smart router shows clear visual feedback, new chat flow is consistent whether inside a project or not, perspective zones render and behave identically to the primary zone and can use tools, web search config moves to global settings, and save/autosave behavior is polished throughout.

**Done when:** no known functional bugs remain, every chat mode has a zone, perspective mode is feature-complete, and the UI is consistent across all panels.

---

### 0.2.x — Organization

The organizational layer. Users can group chats into project folders in the sidebar — collapsible, with a project-scoped default zone and context snippet. Tags can be created, assigned manually or by the model via the `manage_tags` tool, and their context snippets injected into relevant chats. The zone library introduces a browsable, installable collection of curated and user-saved zones, replacing the current seed-on-first-run defaults. The base zone for Quick Chat is configurable here.

**Done when:** a user can organize all their chats into projects and tags, browse and install zones from the library, and configure which zone Quick Chat inherits.

---

### 0.3.x — Context & Knowledge

Conversation branching lets users fork from any message to explore an alternate direction without losing the original thread. Chat interaction polish follows: a live tokens/second counter, a fixed token counter that works correctly across multi-step tool chains, copy-as-markdown on any response, and the ability to edit AI responses inline. These two are the smaller, self-contained pieces and ship first. Skills are then introduced as injectable knowledge packages assigned to a zone — a user writes or imports a skill (e.g. a frontend design guide or a framework reference) and the skill's content is prepended to the system context when that zone is active. Memory rounds out the release: AI-written at three scopes — global (persists across all chats), project (persists within a project), and chat (local to one conversation).

**Done when:** a zone with skills assigned demonstrably outperforms the same zone without them on the relevant topic; the model writes and reads memory correctly across all three scopes; any message in any chat can be branched; the tokens/second counter and copy/edit actions work reliably across all message types.

---

### 0.4.x — Research & Sources

Web search provider and API key configuration moves to a dedicated global settings section. A URL-extract tool complements web search: where search finds pages, extract lets a model read any page in full, returning clean markdown or plain text from a list of URLs — with a basic/advanced depth toggle for JS-heavy or protected sites and tables, an optional relevance query to rerank content chunks, and opt-in images. This closes the loop so models can read and extract from any site, not just search-result snippets. MCP (Model Context Protocol) gets its own settings panel: users add MCP server connections, preview available tools from each server, set danger levels per tool, and enable them per zone — distinct from the existing built-in tool config. Global tool overrides let a user designate tools (built-in or MCP) that every zone has access to regardless of its individual config — a baseline toolset applied app-wide, with per-zone enablement layered on top. OCR and automatic text-only model detection allow PDFs and images to be handled gracefully with models that cannot process them natively. Inline citations attach source links directly to researched claims. RAG over local document collections is introduced here, backed by a local or API embedding model — a prerequisite for the later code interface.

**Done when:** a user can do a fully cited research session using web search and attached documents, with every claim traceable to a source; a model can extract full clean content from an arbitrary URL and use it in its response; MCP servers can be connected and their tools used in zones; global tool overrides apply to every zone; images and PDFs degrade gracefully with non-vision models.

---

### 0.5.x — Subchats & Orchestration Infrastructure

Subchats are full chats whose messages are sent by a zone (via the local API) rather than a human. They live in the sidebar as a collapsible list under the parent chat, making every agent-to-agent conversation inspectable. The spawn-subagent tool lets a zone start and drive a subchat, choosing which zone to assign. File presentation tooling — an HTML output agent for structured reports — is introduced here. These are the building blocks Multizone Mode will run on; each is independently useful before that mode exists.

**Done when:** a zone can programmatically start a subchat, have a multi-turn conversation with another zone via the API, and the full transcript is visible in the sidebar; the HTML output agent produces clean, readable reports from structured data.

---

### 0.6.x — Multizone Mode

The flagship mode. A Response Leader zone coordinates multiple sub-agents via subchats, each running their own zone. The leader deliberately presents opposing views to each agent to stress-test ideas, and is the only agent that communicates with the user directly. The stack tracer UI — a collapsible inline tree of agent calls styled like a thinking block — makes the full orchestration visible and explorable. This release assembles all components from 0.5.x and earlier into one coherent mode.

**Done when:** a user can start a Multizone session, configure the leader and sub-agents, watch the orchestration unfold in the stack tracer, and receive a final synthesized response; the full subchat transcripts are accessible from the sidebar.

> **Research watch — latent-space orchestration.** Multizone Mode is a *text-based* multi-agent system: agents collaborate by exchanging text over the local API, which is token-heavy and slow at depth. [RecursiveMAS](https://recursivemas.github.io/) proposes scaling agent collaboration in *latent* space instead — agents pass hidden states directly and only the final round decodes text (claimed +8.3% accuracy, 1.2–2.4× speedup, 34–75% fewer tokens). It is the natural efficiency/quality ceiling for this mode, but it cannot be implemented at the app/orchestration layer — it requires inference-engine-level latent I/O and a training step. Tracked in the Post-1.0 backlog.

---

### 0.7.x — Settings Rework & UI/UX Polish

A full settings audit and consistency pass. Every panel is reviewed for clarity, completeness, and visual consistency. The Data section is fleshed out as part of this pass — surfacing more about what the app stores and where: database location and size, per-category storage breakdown (chats, zones, attachments, embeddings/RAG indexes, MCP config), counts and last-modified info, and maintenance actions (vacuum, clear caches, export/import, reset). The exact set of surfaced items is decided at implementation time. The database/markdown toggle is introduced: users can choose to persist chats and zone configs as markdown files alongside the SQLite database, making everything viewable and editable in any text editor. Visual and interaction inconsistencies accumulated during 0.1.x–0.6.x are resolved here before the 1.0 release. Chat export lands here too: one-shot export of any chat as Markdown or a theme-aware PDF, styled to match the active app theme.

**Done when:** settings are internally consistent, the Data section gives a clear and complete picture of local storage with working maintenance actions, the DB/markdown export works reliably, chat export produces correct Markdown and correctly themed PDFs, and the UI passes a fresh-eyes review with no jarring inconsistencies.

---

### 0.8.x — Voice I/O

Voice dictation in and spoken responses out. Speech-to-text lets the user dictate into the input bar — push-to-talk or toggle-to-dictate — with the transcript committed when recording stops, and an optional auto-send on silence. Text-to-speech reads any response aloud, streaming-aware so playback starts sentence by sentence before the full answer lands, with an auto-speak toggle and per-zone voices. The two combine into a hands-free conversation mode with barge-in. STT/TTS are served by any configured Provider exposing an OpenAI-compatible endpoint — reusing the same Provider rows zones already point at rather than a fixed vendor list, with no embedded model host. On-device transcription holds the local-first line by pointing that provider at a local server (e.g. LM Studio serving a whisper model), the same way local LLMs work here; non-local providers are clearly marked as leaving the machine.

**Done when:** a user can hold a full spoken conversation with a zone — dictate a message, hear the response read back, and interrupt it — and "read aloud" works reliably on any individual response.

---

### 0.9.x — Tool Improvements

The toolset gets a pass of its own, having grown organically across eight releases. Tool names become plainly understandable to a non-technical user and to a small local model: `search_knowledge` becomes "search local files", `list_directory` and friends read as what they do rather than what they call. Every tool carries a human-facing display name and a one-line plain-English description in the zone editor, separate from the machine name the model sees. The tool list itself becomes manageable rather than a wall of checkboxes: tools are grouped by category, and enable-all / disable-all toggles — app-wide and per category — let a user arm or strip a zone's toolset in one click instead of a dozen. File management is completed — models can rename, move, copy, and (with approval) delete files, which today they cannot, making the file tools write-only in practice. Fast literal and pattern search over files (`find_files` / `search_file_text`) complements RAG: embeddings answer "what is this about", exact search answers "where is this string", and a local model working on a codebase needs both. Skills become self-authored: a `create_skill` tool lets a zone write a new skill from what it just worked out, so knowledge learned in one chat is available to every future chat — memory captures facts, skills capture procedures. Self-authored skills are always visible and editable in Settings → Skills, and are created disabled-by-default pending a user glance, keeping the "user stays in control" line intact.

The release closes with the tools the current set is simply missing. A plan tool gives a model somewhere to hold a multi-step task, which the Multizone leader has never had. `http_request` lets a zone call an API rather than only read a page. Context compaction lets a model summarize its own older turns, so a long chat degrades gracefully instead of silently shedding its beginning. And two knobs for the user: tool descriptions become editable per zone — the description is the whole of what a model knows about when to call a tool, and the wording that works for a frontier model is often not the wording that works for a 7B local one — while per-zone usage counters show which tools a zone actually reaches for, so a bloated toolset that is taxing every turn can be pruned on evidence rather than guesswork.

The release then closes on a reliability pass that wasn't planned — it came out of using the app. A tool that fails is recoverable; a tool that fails *quietly* is not, and web search had exactly that shape: DuckDuckGo answers a throttle with a challenge page, not an error code, so a rate limit reached the model as "No results found" and zones confidently told users a well-covered topic had no information. The same theme runs through the rest of it — `wsl_exec` gives Windows users a Linux escape hatch that can actually hold state across steps rather than resetting cwd and environment on every call, Node-based MCP servers stop failing with "program not found" on machines where they're plainly installed, and inline citations put their markers next to the claim they support instead of drifting into the model's trailing link list, can cite one source more than once, and keep earlier turns' sources available to later answers. Two more things the user simply watches: a tool call's arguments build up on screen for every provider rather than only the ones whose stream happened to fit our event pairing, and a chat names itself while the first answer is still streaming — from what the message actually contained, images included, rather than from its text alone.

The last thing the release fixes is not a tool at all — it is the loop the tools run in. Having good tools made it obvious that turns were ending before the work did: a fixed eight-iteration cap that a research turn burned through in a handful of messages and then fell silently off the end of, leaving a wall of retrieved sources and no answer; a model returning nothing at all after a long run of file reads, saved as an empty bubble; a model narrating its next step and then stopping without taking it. The cap becomes a user setting whose final steps are spent deliberately finishing — the model is warned it is running out, then called once with tools switched off, so a turn that runs out of room reports what it did and what is left rather than trailing off. The two stalls are told apart from a genuine answer and re-prompted, conservatively enough that a finished answer is never mistaken for a cliffhanger. And zones with tools are simply told how the loop works, because a model that doesn't know it will be called again after a tool result has every reason to stop and wait.

Finally, the release takes on the tool that fixing everything else exposed as the weakest: web search itself. The old single-engine DuckDuckGo scrape was fragile by construction — engines fingerprint an ordinary HTTP client's TLS as "not a browser" and answer with a challenge, so the app's whole research value rested on a request that was often quietly refused. Inspired by [Hound](https://github.com/dondai1234/master-fetch) — a keyless, host-driven web-research tool — three new tools replace it, credited throughout: `smart_search` fans out to seven keyless engines in parallel (DuckDuckGo, Bing, Brave, Yandex, Ecosia, Yahoo, Wikipedia) and fuses them so one engine being blocked no longer returns a false empty; `smart_fetch` reads pages and PDFs as clean markdown with honest failure reasons; and `smart_crawl` follows same-site links best-first to gather a topic in one call. The unlock underneath them is a browser-impersonating HTTP client (`wreq`) that carries a real Chrome TLS/HTTP-2 fingerprint — Hound's approach without the stealth browser MultiZone declines to ship — accepting a heavier native build (it links BoringSSL, so the build now needs NASM and a C toolchain) as the price of search that actually works.

**Done when:** a new user can read the zone editor's tool list and understand every entry without guessing; a model can rename and move files as fluently as it creates them; a model can find an exact string in a project without an embedding round-trip; a zone can write a skill that measurably improves its own later runs; a long conversation stays coherent past the context window instead of quietly forgetting how it began; no tool reports a failure as an ordinary empty result; a web search survives one engine being throttled instead of coming back empty; and a multi-step turn ends with an answer rather than with the last tool result.

---

### 0.10.x — Reversible work

The app can write, move and delete files, and has never been able to take any of it back. The user's only protection is the approval prompt — which asks before a change and offers nothing after it, so approving an edit currently means living with it. A checkpoint is taken before the first file-mutating call of a turn, snapshotting only the paths that turn touches; any turn that changed files can then be reverted whole or file by file, and the revert is itself checkpointed. Alongside it, approval gets the information it has always been missing: an edit is presented as a diff rather than as a wall of proposed content, approvable hunk by hunk. This is the single largest capability gap against every coding agent in the survey, and it costs nothing conceptually — it makes the tools that already exist safe to say yes to.

**Done when:** a user can approve an agent's file changes, dislike the result, and put the tree back exactly as it was in one action — including after a multi-zone teamwork run — and no approval prompt asks for a decision the user has not been shown enough to make.

---

### 0.11.x — The app sets itself up

Two problems that turn out to be one. The local HTTP API is still the 0.5.x app: ten routes written alongside subchats, with nothing added since, so skills, memory, MCP, knowledge, checkpoints, terminals, usage and settings are all invisible to it — and nothing about it is discoverable, so "is it even running on the right port" is a question neither a script nor a model can answer. Meanwhile connectors are configured by hand in a panel that assumes the reader knows what a stdio transport is. The API learns to describe itself (a generated route index, a health check that separates *enabled* from *bound* from *answering* from *authorised*, and a drift test that fails the build when a new command ships without a route). A zone gets a tool that calls that API on the user's behalf — proxying the request in Rust rather than handing the model a bearer token, because a live credential in the context is one prompt injection away from leaving a machine it was never supposed to leave. And connectors get a catalog: curated MCP entries with their command, their environment and a link to where the credential comes from, installable in one action, plus the missing `Authorization` header that today makes every hosted remote MCP server unreachable. Together these are a setup wizard that happens to be a conversation, which is the thing non-technical users are missing — not another settings panel. Detail in [CONNECTIVITY.md](CONNECTIVITY.md).

The release closes by making one surface *usable* rather than merely reachable. A route index tells a model which paths exist and nothing about what to put in a body, so appearance — the thing users change by voice more than anything else — gets a described, validated schema of its own, and a custom-CSS field so the answer to "make the sidebar narrower" is no longer "we didn't build a control for that".

**Done when:** someone who has never opened a terminal can connect a service by talking to a zone; a model asked why the API is unreachable names which check failed rather than shrugging; a model asked to repaint the app knows what the fields are called and is told when it gets one wrong; and adding a Tauri command without a route fails CI.

---

### 0.12.x — Planning & task control

The `plan` tool gives a model a checklist. What it does not give the user is a say. Plan mode makes planning a state of the chat rather than a checklist the model keeps, and the way into it is asking for one — there is no button, because pressing it would mean deciding before you typed whether what you were about to type needed a plan. While the mode is on, mutating tools are withheld, read-only tools stay so the plan is grounded in real files, and the result is a structured artifact — ordered steps, expected files, risk per step — that the user edits before approving. An approved plan becomes the executing turn's task list, rendering live as steps tick off, with the ability to strike, add, or stop after the current step instead of cancelling the whole turn. The Multizone leader gets the same surface: leader plan and sub-agent plans in one tree, which is the first time that orchestration has had anywhere to hold a task. The release closes with the record: a session event log and a replay view, so what an agent did is inspectable after the fact and not only while it scrolls past.

**0.12.3 — the chat window earns its space.** The record and the chrome around it, since a replay nobody can read and a header nobody can parse are the same kind of failure. Replay stops being only the event log: the conversation is already stored, so it is woven into the same timeline — what was asked, what each zone answered, and every tool call with its arguments, its output and how long it took — which is what makes "where did that number come from?" answerable after the fact. The header row goes from five glyph sizes to one, the spend chip becomes a legible dollar sign, and the zone control drops the model id it was spending its width on. The permanent project/tag bar becomes a header chip that opens it, so a chat that is filed nowhere no longer pays a row of the window to say so, and the jump from the landing view to a conversation is animated rather than cut. Launch stops flashing: the appearance is restored from a cache before the first paint, and the app's mark is drawn over it for the half-second the rest of the window takes to arrive.

**Done when:** a user can ask for a plan, rewrite it, watch it execute step by step, intervene mid-run without losing the turn, and afterwards replay exactly what happened — including what every tool returned.

---

### 0.13.x — Tool visuals

A tool step that isn't a plan, a plot, a diagram or a saved file renders as escaped JSON — 47 of 52 tools, including the ones an agent run is mostly made of. The release gives every tool a look: 14 visual families rather than 52 bespoke cards, a Visual/Input/Output tab strip so the exact arguments and the exact result string stay one click away instead of being the only thing on offer, and a shaped fallback so the unbounded set of MCP tools never drops to raw JSON either. The diff view this needs for file edits already exists — it was built for the approval prompt in 0.10.2 and the step card has simply never called it. The largest single gain is in Multizone mode, where a leader's step list is currently the least legible part of the app: sub-agent spawns become cards you can open the transcript from, and the team board — claims, refusals, notes — becomes visible for the first time. Full spec in [TOOL_VISUALS.md](TOOL_VISUALS.md).

**Done when:** no tool renders as raw JSON by default, every tool step exposes its unmodified input and output in one click, and a Multizone run can be read from the step list without opening the tracer.

---

### 0.14.x — The agent floor

A comparison pass against roughly twenty open-source agents and clients ([BORROWABLES.md](BORROWABLES.md)) put our orchestration, review and checkpointing ahead of most of the field — the teamwork lock layer has no equivalent in anything surveyed — and our *primitives* behind it. `edit_file` requires a byte-exact match and, when the anchor appears twice, silently edits the first one and reports success. There is no 429 path in the LLM client. Nothing stops a background sub-agent repeating a failing call until the task budget is gone, and nobody is watching a background sub-agent. Auto-approval's top notch is *Everything*, which the README tells people to select before a long run. Retrieval is embedding-only, so an exact error string is the query it handles worst.

This release fixes the layer underneath: an edit that refuses ambiguity, tolerates whitespace and syntax-checks itself; loop detection, backoff and explicit caps; per-category approval with shell prefix rules; the project's own `AGENTS.md` and a ranked repo map so seven agents don't rediscover the layout seven times; hybrid retrieval with a rerank; and cost in currency per sub-agent. It closes with an eval harness, because the premise of the whole panel is that it beats a single local model and there is presently no way to know.

**Done when:** an edit either lands correctly or explains itself, a runaway sub-agent stops on its own, a rate limit costs a retry rather than a panel member, and the panel's benchmark score is a number we can produce on demand.

---

### 0.15.x — Smaller lifts

The remainder of the comparison: cross-chat search, a command palette, fork scope options, MCP resources and prompts, saved parameterised runs, and a global-shortcut quick assistant. Independently useful, none load-bearing for 1.0, and grouped so they can be dropped or deferred as a block if 1.0 needs the room.

---

### 0.16.x — In-chat rendering

`render_graph` draws diagrams and plots functions. It cannot draw *data* — the case where a model has numbers and wants to show them — so models fall back to Mermaid approximations or hand-written SVG, and the app looks thinner in chat than tools with a fraction of its capability. A charting renderer takes a data spec rather than a diagram source, themed from the active app theme so it reads correctly in light and dark and never distinguishes series by colour alone. Tables the model has already produced offer to become charts, because the common case is that the numbers exist and only the presentation is missing. Charts survive export rather than degrading to a placeholder.

**Done when:** a model that has numbers can show them, in any of the ordinary chart types, without writing markup by hand — and the result is still there in the exported PDF.

---

### 1.0.0 — Hardening & Public Release

Performance audit (startup time, large chat scroll, streaming), installer polish, auto-updater integration, cross-platform smoke tests (Windows, macOS, Linux), and a REQUIREMENTS.md written for onboarding contributors. No new features — this is a quality and release-infrastructure milestone.

It also closes the gap between the first principle and the shipped binary. [PRIVACY.md](PRIVACY.md) states, from the source rather than from the intent, exactly what is stored and what leaves the machine — and writing it found the two places the principle was overstated. The app checks for an update ~2.5 seconds after every launch with no way to stop it, and provider API keys sit in the SQLite file in plain text. Neither is alarming on a single-user local install; both are things a public release has to say out loud, or fix. The check becomes opt-out, the keys get either the OS keychain or a plain warning at the point of entry, and the statement is linked from the README, first-run setup and Settings → Data rather than filed in `docs/`.

**Done when:** a new user can install, run, and use the app end to end without opening a terminal; all 0.1.x–0.12.x test checklists pass; no P0/P1 issues are open; and the privacy statement is accurate against the tree, with the update check switchable off and the key-storage position stated in the app.

---

### 1.2.x — Signed-in connectors

The "Connect Google" button, and the same again per provider: an OAuth client with a loopback redirect, refresh tokens in the OS keychain rather than SQLite — a long-lived credential for someone's mailbox is not app data — and per-scope consent so Calendar can be granted without Gmail. Deliberately after 1.0, because 0.11.x's catalog and static-token headers already carry a non-technical user most of the way: "Gmail — paste the token from here" is a different experience from "configure a stdio MCP server" and needs no OAuth. What this release adds is the single click. It is also mostly not MCP work, and Google's verified-consent review for restricted scopes is a process measured in weeks that applies to us as the OAuth client — a distribution question for a local-first app, not only an engineering one.

**Done when:** a user can connect Gmail, Calendar and Drive from a button, see exactly which scopes were granted, and revoke them — with no credential ever stored in the database or shown to a model.

---

## Post-1.0 Backlog

| Feature | Notes |
| --- | --- |
| Code interface + edit engine | Claude Code-style chat window for local models working on codebases; uses RAG/embeddings from 0.4.x for repo understanding. Scoped with it: replacing whole-file `write_file` with a real edit engine (diff hunks validated against the file as it currently is, fuzzy anchoring, syntax check before the write lands). Cursor and Antigravity are categorically better here and the gap is structural, not a missing feature — but the parts worth pulling forward are 0.10.x's checkpoints and diff review, which help every existing file tool immediately. Wants the shared mode surface below rather than a shell of its own |
| Study mode | A grounded mode for learning a body of material rather than working on it: answers restricted to the project's own sources, plus a set of study *tools* — mind map, study guide/briefing/FAQ/timeline, flashcards, quiz, data table, slide deck, infographic, audio overview — each one a tool with a renderer, which is the `update_plan` → `PlanBlock` pattern we already use. Most components exist (knowledge base, citations, `render_graph`, TTS, skills, HTML reports); the missing parts are source-only grounding that *refuses* rather than fills gaps, and durable study state. Wants a workspace rather than a chat panel — see "mode surface" below. Sized in [RELEASE_PLAN.md](RELEASE_PLAN.md#backlog--unscheduled) |
| Mode surface | A workspace shell a mode can furnish — a source/context rail, the conversation, and a collected set of generated artifacts. Wanted by both the code interface and study mode, which is the signal to build it once rather than grow two bespoke shells that duplicate every affordance. Components before modes: whichever mode lands first pays for it, and it is scoped as its own item before either |
| Moddable app surface (`.zone` packages) | A framework for a zone to build a capability the app does not have — a tool, its renderer, a settings page, a panel layout — talked into existence in conversation rather than downloaded. Most of it exists already: `app_control` drives the app through its own API, MCP is the runtime tool registry, `customCss` is arbitrary appearance, and `skillpacks.rs` is folder-backed packaging. The missing parts are an extension-point registry generated from Rust (the `/api/routes` pattern, with a drift test) and a renderer contract with somewhere safe to run it — mod code never touches the main webview, because `csp` is `null` and any script there holds the full IPC surface. **Packages are shareable and arrive disabled**, enabled per package by the user and never by the zone that wrote one. Capability is specced in two tiers — compose existing gated tools (built) vs. add new reach (specced only, picked up if real packages need it). Depends on 0.13.0 for the renderer seam. Sized in [RELEASE_PLAN.md](RELEASE_PLAN.md#backlog--unscheduled) |
| Diffusion LLM support | Text generation via diffusion-first models (e.g. Mercury Coder); architecturally distinct from autoregressive — isolated pipeline |
| Mobile app | Tauri mobile target (iOS/Android) as a **remote for the desktop**, not a second app: same chats, same zones, but the message is run by the machine at home, with its models, files and MCP servers. A phone cannot host a 30B local model or a filesystem tool, and two independent stores would be the cloud sync this project refuses — a remote client has no second copy to sync. The API is already the whole app (105 routes, SSE streaming) and `src/lib/tauri.ts` is a single seam a remote transport can implement; the new work is a LAN bind, pairing by code with per-device tokens, and answering approvals from the phone. LAN-only by design. Post-desktop-stable; sized in [RELEASE_PLAN.md](RELEASE_PLAN.md#backlog--unscheduled) |
| Multi-user/team | Shared zones, shared projects, access control |
| Shareable zone marketplace | Community-contributed zones beyond the local library |
| Latent-space orchestration ([RecursiveMAS](https://recursivemas.github.io/)) | Replace text passing between Multizone agents with latent hidden-state passing — only the final round decodes text. Promises large token/latency savings + accuracy gains for 0.6.x's flagship mode. **Not an app-layer feature:** requires the inference engine to expose hidden states and accept latent inputs (impossible over today's chat-completion APIs — Ollama/OpenAI-compatible/llama.cpp all exchange text/tokens only), plus a training pass to fit the ~13M-param "RecursiveLink" adapters (base weights frozen). The small, frozen-base adapter footprint makes a **local overnight fine-tune** plausible *if* MultiZone gains a training backend — a future bridge between the local-first principle and this technique. Bleeding-edge research as of 2026; gated on engine support landing first. |
