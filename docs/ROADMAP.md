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
| **1.0.0** | Hardening & Public Release | Planned |
| **Post-1.0** | Code interface, Diffusion LLM, Mobile | Backlog |

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

Web search provider and API key configuration moves to a dedicated global settings section. MCP (Model Context Protocol) gets its own settings panel: users add MCP server connections, preview available tools from each server, set danger levels per tool, and enable them per zone — distinct from the existing built-in tool config. Global tool overrides let a user designate tools (built-in or MCP) that every zone has access to regardless of its individual config — a baseline toolset applied app-wide, with per-zone enablement layered on top. OCR and automatic text-only model detection allow PDFs and images to be handled gracefully with models that cannot process them natively. Inline citations attach source links directly to researched claims. RAG over local document collections is introduced here, backed by a local or API embedding model — a prerequisite for the later code interface.

**Done when:** a user can do a fully cited research session using web search and attached documents, with every claim traceable to a source; MCP servers can be connected and their tools used in zones; global tool overrides apply to every zone; images and PDFs degrade gracefully with non-vision models.

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

Voice dictation in and spoken responses out. Speech-to-text lets the user dictate into the input bar — push-to-talk or toggle-to-dictate — with live partial transcription and an optional auto-send on silence. Text-to-speech reads any response aloud, streaming-aware so playback starts sentence by sentence before the full answer lands, with an auto-speak toggle and per-zone voices. The two combine into a hands-free conversation mode with barge-in. Local models (whisper.cpp for STT, Piper/Kokoro for TTS) are the default and run fully offline, holding the local-first line; API providers (Whisper/Deepgram, OpenAI/ElevenLabs) are available but clearly marked as leaving the machine.

**Done when:** a user can hold a full spoken conversation with a zone — dictate a message, hear the response read back, and interrupt it — entirely offline with local models, and "read aloud" works reliably on any individual response.

---

### 1.0.0 — Hardening & Public Release

Performance audit (startup time, large chat scroll, streaming), installer polish, auto-updater integration, cross-platform smoke tests (Windows, macOS, Linux), and a REQUIREMENTS.md written for onboarding contributors. No new features — this is a quality and release-infrastructure milestone.

**Done when:** a new user can install, run, and use the app end to end without opening a terminal; all 0.1.x–0.7.x test checklists pass; no P0/P1 issues are open.

---

## Post-1.0 Backlog

| Feature | Notes |
| --- | --- |
| Code interface | Claude Code-style chat window for local models working on codebases; uses RAG/embeddings from 0.4.x for repo understanding |
| Diffusion LLM support | Text generation via diffusion-first models (e.g. Mercury Coder); architecturally distinct from autoregressive — isolated pipeline |
| Mobile app | Tauri mobile target (iOS/Android); post-desktop-stable |
| Multi-user/team | Shared zones, shared projects, access control |
| Shareable zone marketplace | Community-contributed zones beyond the local library |
| Latent-space orchestration ([RecursiveMAS](https://recursivemas.github.io/)) | Replace text passing between Multizone agents with latent hidden-state passing — only the final round decodes text. Promises large token/latency savings + accuracy gains for 0.6.x's flagship mode. **Not an app-layer feature:** requires the inference engine to expose hidden states and accept latent inputs (impossible over today's chat-completion APIs — Ollama/OpenAI-compatible/llama.cpp all exchange text/tokens only), plus a training pass to fit the ~13M-param "RecursiveLink" adapters (base weights frozen). The small, frozen-base adapter footprint makes a **local overnight fine-tune** plausible *if* MultiZone gains a training backend — a future bridge between the local-first principle and this technique. Bleeding-edge research as of 2026; gated on engine support landing first. |
