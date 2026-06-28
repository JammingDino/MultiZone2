# Release Plan — MultiZone

Detailed work items grouped by release. Direction in [ROADMAP.md](ROADMAP.md).
`[x]` done · `[ ]` to do · `[~]` partial/built but untested. Items are movable between releases.

---

## 0.1.x — Foundation & Polish

### 0.1.6 — Smart chat routing

- [x] `smart_routing` boolean on `Chat` — router picks best zone per turn
- [x] Smart chat mode in `HomeScreen` mode picker (`setChatSmart` action)
- [x] Visual feedback while the router is running (spinner or status text in chat header)
- [x] Post-routing indicator: show which zone was selected for the current turn
- [x] Smart chat graceful degradation when no zones exist

---

### 0.1.7 — Bug fixes & tool improvements

**list_dir tool**
- [x] Add optional `depth` argument (integer, default `1`) — controls how many levels of child directories to recurse
- [x] Token-efficient output format: compact tree representation, omit metadata by default

**Web search — move config to global settings**
- [x] Add web search provider settings to the Settings modal (provider dropdown, endpoint field for SearXNG, API key field for Brave/Tavily/Serper)
- [x] Remove web search config from the per-zone tool config JSON and the zone editor UI
- [x] Backend reads web search config from app settings, not zone tool_config
- [x] Migrate gracefully: zones that have web_search config in tool_config — read once, write to global settings, clear from zone

**Gemma thinking support**
- [x] Detect Gemma models by model name (contains "gemma")
- [x] For Gemma models with thinking enabled: parse `<think>...</think>` tags in streamed output instead of sending `reasoning_effort` parameter (unsupported by Gemma)
- [x] Verify thinking blocks render correctly for Gemma output

---

### 0.1.8 — New chat consistency & zone state

**Eliminate no-zone state**
- [x] Add "base zone" setting in Settings → Chat: a zone selected as the fallback for Quick Chat
- [x] Quick Chat uses the base zone instead of a raw provider/model pair
- [x] Remove the provider-only code path from the backend send logic
- [x] Home screen: clarify mode picker labels — "Quick" should reflect that it uses the base zone, not a bare model; add tooltip distinguishing Quick vs Smart vs Zone-specific

**New chat flow consistency**
- [x] Unify the app-start home screen and the in-app "New chat" button into one consistent flow
- [x] New chat dialog: add options to assign a project and tags upfront
- [x] Project new chat: pre-selects the project but is otherwise identical to regular new chat
- [x] Settings → Providers: rename "quick chat provider" label to "Default provider"

**Save & autosave behavior**
- [x] Save buttons in zone editor, project editor, and tag editor close the relevant panel on save
- [x] Provider settings: remove save button; all provider fields autosave on change

---

### 0.1.9 — Perspective mode polish (current — release)

- [x] Perspective zones can use tools (tool calls execute the same way as for the primary zone) — primary and perspectives now run the same shared agentic loop
- [x] Perspective zone responses render with identical styling to primary zone responses; zone avatar and accent color are the only visual differentiator — shared `TurnBody` block renderer
- [x] Perspective zones shown in the chat header with their zone name and avatar; clicking opens zone details
- [x] Add/remove perspective zones from an active chat without breaking existing history
- [x] Per-chat perspective mode override (sequential vs parallel) saved and restored on reload
- [x] Cancelling mid-stream cancels all active perspective zone streams, not just the primary — all participants share one cancel flag; cancel also denies every pending per-zone tool approval

**Execution model:** the primary zone and all perspective zones are equal participants in a turn. In `parallel` mode they stream concurrently (one message → all responses stream side by side); in `sequential` mode the primary runs first, then each perspective. Tool approvals are keyed per participant (`chat_id` / `chat_id::zone_id`) so concurrent zones don't collide.

---

## 0.2.x — Organization

### 0.2.0 — Projects: sidebar & grouping

- [x] Sidebar: project folders render above the flat chat list; each folder collapses/expands
- [x] "New project" button in sidebar alongside "New chat"
- [x] Clicking a project folder filters the chat list to that project's chats — implemented as inline collapsible folders (each project's chats nest under it; collapse others to focus) rather than a separate filtered view
- [x] "Ungrouped" section shows chats with no project
- [x] Move a chat into a project from the chat context menu
- [x] Project editor: name, icon, accent color, default zone, context snippet, directory path (for filesystem tool scoping)
- [x] Deleting a project: option to keep chats (move to ungrouped) or delete all

### 0.2.1 — Projects: context injection

- [x] "Include project context" toggle in chat header (persists per chat as `project_context_enabled`)
- [x] Project context snippet prepended to system prompt when toggle is on
- [x] `default_context_enabled` on project: new chats in that project start with context on
- [x] Filesystem tool respects project `directory` as the scoped root when set
- [x] Project context visible in an expandable section in the chat header so the user knows what is being injected — shows the project snippet + every enabled tag snippet currently prepended

### 0.2.2 — Tags

- [x] Tags tab in ProjectsPanel: create, edit, delete tags (name, color, context snippet)
- [x] Tag chips on chat items in sidebar
- [x] Assign tags to a chat from the chat header (tag picker)
- [x] `manage_tags` tool: verify it creates tags and assigns them correctly; confirm it is available in relevant default zone configurations
- [x] Per-tag context toggle in chat header (enable/disable each tag's snippet independently)
- [x] Filter sidebar by tag: clicking a tag filters the chat list
- [x] Multiple active tags inject all their snippets independently

### 0.2.3 — Zone library

*Storage: the library is a folder of JSON files on disk (`app_data_dir/zone_library/`), holding 12 curated presets plus user snapshots/imports. The 7 curated MultiZone zones come pre-installed as live zones on first run; the 5 community extras stay library-only until installed. The library UI (Configure Zones / Zone Library) shows an installed-zones rail, a curated card grid with per-entry detail, install/configure/uninstall, save-to-library, JSON import (drop/browse/URL), pagination, and toasts — matching the provided design.*

- [x] Zone library panel: browsable list of curated and user-saved zones
- [x] "Save to library" button on any zone — saves a snapshot of current config (via "Save a zone…" in the library)
- [x] "Install from library" — creates a new zone from a library entry; duplicate detection by name
- [x] Curated default zones presented here (and pre-installed); installed state shown per card
- [ ] Base zone for Quick Chat is selected from the library or the user's zones (Settings → Chat) — *deferred to follow-up*
- [~] Import zone from JSON file (drop / browse / URL) done; **export** zone as JSON file still *deferred*
- [x] Library zone card shows: icon, accent color, system prompt preview, enabled tools
- [x] 11 curated zones: MultiZone Assistant, Idea Critic, Deep Researcher, Code Companion, Fact Checker, Brainstormer (pre-installed) + Writing Editor, Data Analyst, Meeting Scribe, Translator, Support Agent (community)
- [x] Configure Zones and the Zone Library are one unified panel (editing is an embedded view, not a separate modal)
- [x] Settings → Chat: configurable Zone Library page size (6 / 9 / 12 / 15 / 30)
- [x] Installed zones surface under "Saved by you"; "Curated" lists only the not-yet-installed presets

### 0.2.4 — Zone management & export

- [x] Right-click a zone (installed rail or a "Saved by you" card) opens a context menu
- [x] Context menu actions: Edit (open editor), Rename (inline), Export JSON, Delete
- [x] Export a zone as a JSON file, re-importable via "Add zones"
- [ ] Right-click actions on the chat sidebar's zone references — *follow-up if wanted*

---

## 0.3.x — Context & Knowledge

### 0.3.0 — Conversation branching

- [x] "Branch from here" button on any user or assistant message
- [x] Branching creates a new chat with history up to (and including) that message
- [x] New branched chat linked to parent in DB (`parent_chat_id`, `branched_from_message_id`)
- [x] Sidebar: branched chats appear as a collapsible sub-list under the parent
- [x] Branched chat inherits zone, project, and tag assignments from the parent — *also copies tool messages, reasoning, attachments and perspective zones; built, not yet runtime-tested*

### 0.3.1 — Chat interaction polish

- [x] Live tokens/second counter: live `tok/s` in the streaming status banner alongside elapsed time and token estimate; computed from the turn aggregate so it reflects whole-turn throughput
- [x] Fix token counter and elapsed timer for complex tasks: the per-turn `TurnAggregate` (content + reasoning + tool-call chars, single `firstTokenAt` origin) survives every iteration of the agentic loop — counts/time accumulate and never reset or stall between tool calls
- [x] Copy response as markdown: the Copy action on each assistant/perspective response writes the raw markdown source (joined text blocks) to the clipboard, not rendered HTML
- [x] Edit AI responses: click-to-edit on any assistant or perspective response (`update_message` command + `edited` column, migration 014); the final answer text is editable, saved to DB, shown with an "edited" marker; branching copies stored content so a branch from an edited message inherits the edited text — *built & typechecked; not yet runtime-tested*

### 0.3.2 — Skills

*Skills follow the [Anthropic Agent Skills](https://github.com/anthropics/skills) model: global, on-demand instruction sets the agent **discovers and loads itself**, rather than always-on per-zone prepends. Each skill is a name + a description written as the use case that should trigger it + freeform-markdown instructions. The name + description of every enabled skill is injected as a compact catalog into the system prompt of any zone that has the `skills` tool; when a request matches, the agent calls `load_skill` (a safety-0 tool, like any other tool call) to pull the full instructions — progressive disclosure that keeps context small. Skills are managed globally on their own Settings → Skills page; they are not bound to zones or chats.*

*Status: built & typechecked (migrations 015–017; cargo test + `npm run build` green); not yet runtime-tested in the app.*

**Data & catalog**
- [x] Skills data model: global `skills` table (id, name, description, content, **enabled**, created_at, updated_at). The 015 `zone_skills`/`chat_skills` tables are superseded and unused.
- [x] Settings → Skills page: create, edit, delete; per-skill global **enable/disable** toggle; freeform-markdown instructions; description framed as the trigger use case
- [x] Import skill from a `.md` / `.txt` file; export a skill back out as markdown

**Discovery & loading (progressive disclosure)**
- [x] Catalog block (`# Skills`, name + description per enabled skill) injected into the system prompt for any zone with the `skills` tool (`build_catalog`)
- [x] `load_skill(name)` tool (safety 0): returns the named skill's full instructions, or the catalog when the name is missing/unknown — the agent requests it like any other tool
- [x] `skills` tool in the quick-chat safe set and added to all curated zone presets, so the catalog is effectively available everywhere; selectable per zone in the editor

**Templates**
- [x] Built-in skills seeded on first run (gated by `seededSkills`), fully editable: **frontend-design** (rich, Anthropic-style design guide with a use-case description), markdown-formatting, json-output

**list_dir tool — empty-folder clarity** *(small tool improvement; movable)*
- [x] In the compact tree output, a directory at the depth limit renders `{}` when genuinely empty or `{"…": true}` when it has un-expanded children — so a depth-limited scan distinguishes the two
- [x] Marker applies at the deepest scanned level (and at the allowed-roots boundary): probes one entry to decide empty vs non-empty
- [x] Token-efficient — a single `"…": true` sentinel, not a child count; tool description updated to explain it

### 0.3.3 — Memory

*Model-managed long-term memory: the assistant writes and reads small facts that persist across turns and chats. Entries are scoped — `global` (every chat), `project` (chats in one project), or `chat` (one conversation) — and injected into the system prompt each turn in precedence order (global → project → chat). Writing and reading are exposed as safety-level-0 tools so the model curates its own memory without approval friction, while the user keeps full visibility and edit control through a memory viewer in settings. A soft per-scope size cap keeps the injected block bounded.*

*Status: built & typechecked (migration 016; cargo test + `npm run build` green); not yet runtime-tested in the app.*

**Data model & tools**
- [x] Memory data model: `memories` table (id, scope: global/project/chat, scope_id nullable, content, created_at, updated_at) + `idx_memories_scope`
- [x] `save_memory(content, scope?)` tool: model writes an entry; safety level 0 (safe, no approval); scope defaults to `chat`, `project` falls back to `chat` when the chat has no project
- [x] `read_memory(scope?)` tool: omit scope for all applicable (global + project + chat), or pass one; safety level 0
- [x] `delete_memory(id)` tool so the model can drop a stale entry; safety level 0. All three live under one `memory` ToolId
- [~] `memory` tool included in the quick-chat safe toolset (`safe_tool_ids`) and selectable in the zone editor — *not yet added to the curated zone presets' default tool lists*

**Injection & limits**
- [x] Memory injected into the system prompt each turn under a `# Memory` block: global first, then project, then chat-level (`build_memory_block`)
- [x] Soft size limit per scope — oldest entries trimmed on save when exceeded; limit configurable in Settings → Memory (`memoryScopeLimit`, default 50)
- [x] Currently-injected memory entries surfaced via the `memory-updated` event; viewer refreshes live during a turn

**Management**
- [x] Memory viewer in **Settings → Memory**: browse, edit, and delete entries across all scopes; each row shows its scope + owning project/chat — *full-text search deferred*

---

## 0.4.x — Research & Sources

### 0.4.0 — OCR & automatic model detection

*OCR uses the **pure-Rust `ocrs` engine** (ocrs + rten), not native Tesseract, to keep the cross-platform build clean — consistent with the codebase's rustls / `pdf-extract` no-native-deps pattern. The two `.rten` model files are loaded at runtime from `<app_data_dir>/ocr_models/` (created on first launch); when absent, image OCR degrades gracefully (a clear placeholder is sent) rather than breaking the turn. The vision-capability check is a model-name heuristic shared between backend (`ocr::is_vision_capable`) and frontend (`lib/vision.ts`) — unrecognised models are treated as text-only so their images are OCR'd rather than dropped.*

*Status: built & typechecked (cargo check + `npm run build` green); image-OCR not yet runtime-tested (requires the `.rten` model files to be present). Detection, PDF text fallback, indicator, and language setting are exercisable without the models.*

- [x] Automatic text-only model detection: model-name heuristic identifying vision-capable families; everything else treated as vision-incapable
- [x] When a vision-incapable model receives an image attachment: run OCR (pure-Rust `ocrs`, swapped in for Tesseract) and send extracted text — applied in `build_message_history`, results cached per-image to avoid re-OCR each turn
- [x] PDF fallback: if model is vision-incapable, the input bar extracts PDF text (PDF.js) regardless of PDF mode; the backend OCR also covers any PDF pages that still arrive as images
- [x] User-visible indicator when OCR fallback is active — amber badge in the input bar whenever the chosen model can't see images and an image/PDF is attached
- [x] OCR language hint setting in Settings (`ocrLanguage`, default `eng`) — plumbed to the OCR call (note: bundled `ocrs` models are English/Latin-centric, so the hint has limited effect until language-specific models are added)
- [~] *Limitations:* OCR fallback applies on the single-zone history path; multi-model/perspective chats are not yet OCR'd. Message-header (post-send) OCR indicator deferred — the input-bar indicator covers the pre-send case.

### 0.4.1 — Inline citations (current — release)

*Citations are derived per bot turn: web_search results (numbered with a `ref` + source URL in the tool output) plus the round's file attachments are collected into one ordered, de-duplicated list (`lib/citations.ts`). A remark plugin (`lib/remarkCitations.ts`) rewrites inline `[n]` markers in the answer into clickable superscript links (web) or styled markers (file); a collapsible "Sources" list (`CitationSources`) renders the full list at the foot of the message, numbered to match. The same path serves the primary and every perspective card.*

*Status: built & typechecked (cargo check + `npm run build` green); not yet runtime-tested. Inline-marker accuracy depends on the model emitting `[n]` per the tool's citation instructions; the Sources list is deterministic regardless.*

- [x] Web search tool results tag each used snippet with its source URL — each result carries a `ref` number + `url`, plus a `citation_instructions` note nudging inline `[n]` citation
- [x] Assistant messages with web search results render inline citation markers linked to source URLs — `[n]` rewritten to superscript links via the remark plugin (code/inline-code left untouched)
- [x] Citation list at the bottom of the message (collapsible) — `CitationSources`, numbered to match the inline markers, with domain + title per web source
- [x] File attachment references generate citations by filename and page number — PDF attachments from the round's user message become file citations (filename + page count)
- [~] *Limitations:* `[n]` mapping is global per turn in encounter order, so it's exact for the common single-search turn but best-effort across multiple searches (the Sources list stays correct either way). Only PDFs yield file citations — images/other types aren't reliably named in stored message parts; precise per-page file citation is not yet supported.


### 0.4.2 — MCP (Model Context Protocol)

*MCP is a first-class settings section, distinct from the existing tool config JSON in the zone editor.*

*The MCP client is hand-rolled (no heavy SDK) — JSON-RPC 2.0 over **stdio** (spawned subprocess, the dominant desktop transport) or **SSE/streamable-HTTP** (remote URL via reqwest). Live connections are cached in a process-global manager keyed by server id, so a stdio child stays warm across tool calls instead of paying npx-startup per call (`src-tauri/src/mcp/mod.rs`). Servers + their discovered tools persist in `mcp_servers` / `mcp_tools` (migration 018); each tool carries a user-assigned danger level (default moderate). Per-zone enablement reuses the zone's `tools_enabled` array via the stable qualified id `mcp__<shortServerId>__<tool>`; `build_tools_for_zone` appends MCP defs, `tools::dispatch` routes `mcp__` names to the manager, and the approval gate substitutes each tool's danger level for the built-in `tool_safety_by_name`.*

*Status: built & typechecked (cargo check + `npm run build` green, MCP unit tests pass); not yet runtime-tested against a live MCP server. Connection status is runtime-only (in-memory, not persisted).*

- [x] Settings → MCP: add, edit, remove MCP server connections (name, transport type: stdio/SSE, URL or command) — `McpServerEditor`; stdio takes a command + optional JSON env, SSE takes a URL
- [x] On connecting a server: fetch tool list and display name, description, input schema for each tool — `connect_mcp_server` runs the initialize handshake + `tools/list`, reconciles `mcp_tools` (new inserted, stale pruned, danger preserved); each tool row expands to show its description + input schema
- [x] User sets a danger level (safe / moderate / dangerous) per MCP tool — per-tool selector (`set_mcp_tool_danger`)
- [x] MCP tools appear in the zone editor's tools list alongside built-in tools, with their danger badge — grouped per server under the built-in Tools list
- [x] Per-zone MCP tool enablement: each zone independently enables/disables specific MCP tools — toggles the qualified id in `tools_enabled`
- [x] MCP tool calls route through the same approval/execution pipeline as built-in tools — `dispatch` forwards `mcp__` names to `mcp::manager().call`, gated by the tool's danger level
- [x] Server connection status shown in settings (connected / error / disconnected) — live status pill, error tooltip on failed connect

### 0.4.3 — RAG / local document knowledge

*Prerequisite for the code interface (post-1.0 backlog).*

*Design decisions (revised from the original outline): knowledge is **project-scoped and sourced from the project's `directory`** — one index per project, not a free-form multi-file knowledge base. Embedding models come **only from providers** (no bespoke local-model runtime): for a local model the user adds Ollama as a provider and picks an embedding model like `nomic-embed-text`, handled by the same OpenAI-compatible `/embeddings` path as OpenAI. The embedding model is **bound to the index** (one vector space), so changing it clears and re-indexes. Retrieval is **agentic** — a read-only `search_knowledge` tool the model calls when it needs grounding — gated by a **per-chat toggle** (`knowledge_enabled`) plus the project having a non-empty index, rather than per-zone enablement or automatic pre-turn injection. Vectors are stored as raw f32 BLOBs in `kb_chunks` and ranked by brute-force cosine in Rust (migration 019); no native vector extension.*

*Status: built & typechecked (cargo check + `npm run build` green, migration/regression test passes); runtime-confirmed working against a live embedding provider.*

*Follow-up additions (post-initial): a **global default embedding provider+model** (Settings → Knowledge) that new projects inherit at creation, a **global knowledge base over the app's default directory** for chats that aren't in a project (backed by a hidden reserved `__global_kb__` project, so all per-project machinery is reused; `search_knowledge` falls back to it), **live auto re-index** via a filesystem watcher (notify + 2s debouncer, `autoReindex` setting) that re-embeds changed files automatically, and **inline citation sourcing** for `search_knowledge` mirroring web search — results carry `ref` numbers and the Sources list/inline markers are filtered to only the passages the model actually cited (also fixed for web search, which previously listed every result).*

- [x] Embedding provider config: per-project embedding provider + model, chosen from the user's configured providers (OpenAI embeddings, or Ollama-as-provider for local) — `set_project_kb_config`, surfaced in the project editor's Knowledge section; plus a **global default** new projects inherit (Settings → Knowledge)
- [x] Document ingestion: walk the project directory, chunk text-bearing files (incl. PDF via `pdf-extract`) with overlap, embed in batches, store vectors in a local SQLite store (`kb_documents` / `kb_chunks`) — `index_project_knowledge`; unchanged files skipped by content hash, deleted files pruned
- [x] Knowledge bases scoped to a project (sourced from its directory) **and** a global KB over the app's default directory (usable by non-project chats) — reserved `__global_kb__` project, hidden from the projects UI
- [x] **Live auto re-index**: indexed directories are watched on disk and re-embedded automatically as files change (notify + debouncer); toggleable via `autoReindex`
- [~] Zone/chat config: a per-chat toggle offers the `search_knowledge` tool when the project (or global KB) is indexed; the model retrieves on demand (agentic) rather than chunks being auto-injected each turn — chosen over per-zone enablement
- [x] Knowledge base viewer: list ingested documents with chunk count and index time; re-index, remove a document, or clear the whole index — Knowledge section in the project editor + Settings → Knowledge for the global KB
- [x] Retrieval transparency: retrieved chunks surface as ordinary `search_knowledge` tool calls in the message thread, **and as inline `[n]` citations + a collapsible Sources list** (filtered to only the passages the model cited), mirroring web search

---

## 0.5.x — Subchats & Orchestration Infrastructure

### 0.5.0 — Subchat data model & API

- [x] `parent_chat_id` and `initiated_by_zone_id` columns on `Chat`
- [x] Sidebar: subchats shown as a collapsible sub-list under their parent chat
- [x] Local HTTP API: `POST /chats/:id/messages` accepts a `zone_id` as sender (not user)
- [x] Subchat turns render with the initiating zone's avatar instead of the user avatar
- [x] Subchats are read-only from the user's perspective (observable but not interactive)

### 0.5.1 — Spawn-subagent tool

- [x] `spawn_subagent(zone_id, initial_message, context_mode)` tool: creates a subchat, assigns the zone, sends the first message, returns subchat ID
- [x] `context_mode` options: `full` (whole conversation), `task_only` (just the initial message), `summary` (caller provides a brief)
- [x] `send_subchat_message(subchat_id, message)` tool: sends a message to an existing subchat and returns the response
- [x] `read_subchat(subchat_id)` tool: returns the full transcript of a subchat
- [x] Safety levels: spawn/send = moderate; read = safe
- [x] Subchat depth limit (default 3, configurable in settings) prevents infinite loops

### 0.5.2 — File presentation

*Status: built & typechecked (cargo build + `npm run build` green). Presentation is split from creation: the model writes/edits a file with the existing `file_system` tools (`create_file` / `edit_file`), then surfaces it with the standalone `present_file` tool (id `present_file`, safe/read-only; legacy id `save_output` still resolves). `present_file` resolves relative paths against the chat working directory (project dir, or app default dir) and returns a `rendered` payload — HTML files render inline via a sandboxed scripts-disabled iframe preview (`HtmlReportBlock`), other formats show a `SavedFileChip`. (An earlier combined `save_output_file` write+present tool was removed as redundant.) Two Tauri commands back the UI: `read_output_file` (bounded text read for the preview) and `open_path` (OS opener via the `opener` crate) — used by the "open in browser" button and by intercepted local file links in the report. Curated "Report Builder" zone added (library-only, `preinstall: false`); curated library version bumped to 6.*

- [x] HTML output agent zone template: pre-configured to format structured data as clean HTML reports — "Report Builder" curated zone (`present_file` + file_system + render_graph + web_search)
- [x] ~~`save_output_file(filename, content, format)` tool~~ → split into `create_file`/`edit_file` (write) + `present_file(path, format?)` (present), so writing and presenting are separate composable calls
- [x] Rendered HTML shown inline in the chat as a preview with an "open in browser" button — `HtmlReportBlock` sandboxed iframe + `open_path` for the full file
- [x] Local file links in HTML output open via Tauri shell open — anchor clicks intercepted in the preview, relative hrefs resolved against the report's directory, routed through `open_path`

---

## 0.6.x — Multizone Mode

*Design work for the stack tracer UI and leader/sub-agent configuration flow should be completed before implementation. See [overview.drawio](overview.drawio) for the initial concept.*

### 0.6.0 — Response Leader & orchestration

- [ ] Response Leader zone type: a zone configured to coordinate sub-agents; marked in the zone library with a dedicated indicator
- [ ] Multizone session start: user selects a leader zone and one or more sub-agent zones
- [ ] Leader drives sub-agents via `spawn_subagent` / `send_subchat_message` tools exclusively
- [ ] Leader presents opposing views to each sub-agent (not the user's original message) — enforced by leader system prompt pattern documented in the zone template
- [ ] Sub-agent responses returned to the leader as tool results; leader synthesizes before responding to the user
- [ ] Only `ask_user` calls from the leader surface to the user; sub-agent `ask_user` calls are suppressed

### 0.6.1 — Stack tracer UI

*Requires design sign-off before implementation.*

- [ ] Inline stack trace block in the assistant message: collapsible, styled like a thinking block
- [ ] Tree of agent calls: leader → sub-agent → (nested sub-agents if any)
- [ ] Each node: zone avatar, zone name, message count, expand/collapse
- [ ] Expanding a node shows the full subchat transcript inline
- [ ] Stack trace persists on chat reload (reads from subchat records in DB)

---

## 0.7.x — Settings Rework & UI/UX Polish

### 0.7.0 — Settings rework

- [ ] Settings modal reorganized: General, Appearance, Chat, Search, API, MCP, Data
- [ ] Appearance section: light/dark mode toggle, global accent color, typography (font family + size), visual effects (shadows, bloom/glow), background effects (type, speed, density, opacity)
- [ ] All settings labels reviewed for clarity; help text added where behavior is non-obvious
- [ ] Settings validated on input; invalid values highlighted inline rather than on save

### 0.7.1 — DB/Markdown toggle

- [ ] Settings → Data: "Export as markdown" toggle; configurable output directory
- [ ] Each chat mirrored as a `.md` file: frontmatter (chat ID, zone, project, tags, dates), messages as timestamped blocks
- [ ] Zone configs exported as individual JSON files in a `zones/` subdirectory alongside the markdown chats
- [ ] Markdown files updated on every message save
- [ ] Import from markdown: read a `.md` chat file back into the DB

### 0.7.2 — UI/UX consistency pass

- [ ] Audit all modals: consistent header height, close button placement, padding
- [ ] Audit all form fields: consistent label size, input height, focus ring
- [ ] Audit all buttons: consistent size, disabled state, hover state
- [ ] Sidebar: collapse/expand animation; active chat highlight
- [ ] Message thread: spacing between messages, avatar sizes, alignment
- [ ] Confirm all save buttons close panels as expected (from 0.1.8 and 0.2.x checklists)

### 0.7.3 — Chat export

- [ ] Export chat as Markdown: full chat exported as a single `.md` file (distinct from the live-mirror in 0.7.1) — frontmatter with chat title, zone, project, tags, dates; messages as timestamped blocks
- [ ] Export chat as PDF: theme-aware PDF styled to match the currently active app theme (accent color, background, font family, message bubble layout)
- [ ] PDF page header: chat title, zone name, and export date; page numbers in footer
- [ ] Export entry point in the chat header or chat context menu

---

## 0.8.x — Voice I/O

*Voice dictation in and spoken responses out. Honors the local-first principle: local STT/TTS models run fully offline; any API provider is clearly marked as leaving the machine. All voice config lives in a new **Settings → Voice** section.*

### 0.8.0 — Speech-to-text (dictation input)

- [ ] STT provider config in Settings → Voice: local (whisper.cpp via Rust binding) or API (OpenAI Whisper, Deepgram) — local is the default
- [ ] Microphone capture in the input bar: a mic button with push-to-talk (hold) and toggle-to-dictate (click) modes
- [ ] Live partial transcription rendered in the input field as the user speaks; final transcript committed on stop
- [ ] Input device selection and a visible recording / audio-level indicator while capturing
- [ ] Language selection + auto-detect; configurable local model size (speed vs accuracy tradeoff)
- [ ] Transcript insertion mode: insert at cursor vs replace field; optional auto-send on sustained silence (configurable threshold)

### 0.8.1 — Text-to-speech (spoken responses)

- [ ] TTS provider config in Settings → Voice: local (Piper / Kokoro) or API (OpenAI, ElevenLabs) — local is the default
- [ ] "Read aloud" action on any assistant / perspective response (in MessageActions) with pause / stop controls
- [ ] Streaming-aware playback: responses are chunked by sentence and queued as they arrive so speech starts before the full answer completes
- [ ] Auto-speak toggle: assistant responses are spoken automatically as they stream
- [ ] Voice selection per provider; rate and pitch controls
- [ ] Per-zone default voice so different zones can sound distinct

### 0.8.2 — Hands-free conversation mode

- [ ] Voice conversation mode: STT input and TTS output chained into a continuous hands-free loop
- [ ] Barge-in — the user speaking interrupts and stops current playback
- [ ] Conversation state indicator in the chat header (listening / thinking / speaking)
- [ ] Fully offline when local STT + TTS are selected; API providers surfaced as a "leaves your machine" warning consistent with the local-first principle

---

## 1.0.0 — Hardening & Public Release

- [ ] Performance: measure and optimize startup time, first message render, large chat (500+ messages) scroll
- [ ] Streaming: verify no dropped tokens or UI lag under sustained use
- [ ] Installer: Windows (NSIS or WiX), macOS (DMG), Linux (AppImage)
- [ ] Auto-updater: Tauri updater plugin wired to GitHub releases
- [ ] Cross-platform smoke tests on Windows 11, macOS, and Linux
- [ ] Write REQUIREMENTS.md for contributor onboarding
- [ ] In-app keyboard shortcut reference
- [ ] Clean uninstall: no orphaned files or registry entries

---

## Backlog — unscheduled

- [ ] Code interface: chat window for local models working on codebases; uses RAG from 0.4.3; requires design session
- [ ] Diffusion LLM support: text generation via diffusion-first models; architecturally isolated from the chat-completion pipeline
- [ ] Mobile: Tauri mobile target (iOS/Android)
- [ ] Deep research mode: multi-step sourced research using subchats; requires design session before scheduling
- [ ] Zone snapshot/versioning: save zone config at chat creation time so editing a zone does not alter historical context
