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

### 0.1.9 — Perspective mode polish

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
- [x] Base zone for Quick Chat is selected from the library or the user's zones (Settings → Chat) — implemented as a "Quick Chat base zone" `SettingSelect` in Settings → Chat (`baseZoneId`) listing every one of the user's zones (installed library zones included), with a "— none —" fallback to the default provider model
- [x] Import zone from JSON file (drop / browse / URL) done; **export** zone as JSON file shipped in 0.2.4 (zone context menu → Export JSON)
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

### 0.4.1 — Inline citations

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

### 0.4.4 — URL extract tool

*The read-the-full-page complement to `web_search`, closing the research loop so a model can search → pick a result → read it in full. Implemented as a new `extract` tool ([extract.rs](../src-tauri/src/tools/extract.rs), fn `extract_url`) — pure-Rust, no headless browser (consistent with the native-dependency-avoidance stance), fetching each URL with `reqwest` and cleaning the HTML with the existing `scraper` dep. Registered like any built-in tool: `ToolId::Extract`, dispatch, moderate (level-1) safety like `web_search`, and an ALL_TOOLS entry ("Read URL") so it's selectable per-zone. Added to the Deep Researcher and Fact Checker curated zones (versions bumped) with a "search, then read" nudge in the Deep Researcher prompt.*

*Status: built & typechecked (cargo build + `npm run build` green; 4 unit tests pass — DOM extraction, chrome stripping, image URL resolution, relevance scoring); not yet runtime-tested against live pages.*

- [x] `extract` tool reads one or more URLs in full (accepts `urls[]` or a single `url`, max 10) and returns clean main text as lightweight markdown — semantic content root (`main`/`article`/`body`), headings/lists/blockquotes/pre preserved, nav/header/footer/aside/script/style/forms stripped
- [x] Content-type guard rejects binary payloads (only HTML/text/xml read); per-URL `max_chars` budget with a `truncated` flag; concurrent fetches
- [x] Optional `query` reranks extracted paragraphs by keyword overlap so a long page truncates least-relevant content first
- [x] Opt-in `include_images` returns the page's image URLs, resolved to absolute against the page URL
- [x] Inline-citation integration: each page carries a `ref` number + `citation_instructions`, mirroring `web_search`, so the existing `[n]` marker + Sources pipeline works unchanged
- [~] *Limitations:* no headless browser, so JS-only pages return whatever static markup they ship (surfaced as a note in the tool description and an explicit "no readable text" content message); the roadmap's "advanced" depth toggle for JS-heavy/protected sites is out of scope for the pure-Rust MVP

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

*Status: built & typechecked (cargo check + `npm run build` green). Builds on the 0.5.x subchat infrastructure. The leader is the chat's primary zone (`is_leader` flag, migration 022); the sub-agent roster is stored per-chat in `chat_subagents` (distinct from perspective `chat_zones` — sub-agents only run when the leader spawns them). A multizone session starts from the HomeScreen: choosing a leader zone as the primary swaps the perspectives picker for a sub-agent roster picker, and the roster is persisted via `set_chat_subagents` before the first turn. The engine injects a leader orchestration preamble (delegation protocol + roster + opposing-views guidance) when the answering zone is a leader, and suppresses `ask_user` in any sub-agent (subchat) turn. A library-only "Response Leader" curated zone (`is_leader: true`, subchat tools) documents the prompt pattern; curated library version bumped to 7. Stack-tracer UI for visualising the leader→sub-agent call tree is deferred to 0.6.1.*

- [x] Response Leader zone type: a zone configured to coordinate sub-agents; marked in the zone library with a dedicated indicator — `is_leader` flag, Crown indicator in the library/zone-picker, "Response Leader" toggle in the zone editor (auto-enables the subchat tools)
- [x] Multizone session start: user selects a leader zone and one or more sub-agent zones — HomeScreen sub-agent roster picker shown when the primary zone is a leader, persisted to `chat_subagents`
- [x] Leader drives sub-agents via `spawn_subagent` / `send_subchat_message` tools exclusively — reuses the 0.5.1 subchat tools; the leader template enables them and the preamble mandates their use
- [x] Leader presents opposing views to each sub-agent (not the user's original message) — enforced by leader system prompt pattern documented in the curated "Response Leader" zone template **and** injected as an orchestration preamble each turn
- [x] Sub-agent responses returned to the leader as tool results; leader synthesizes before responding to the user — inherited from the subchat tool-result flow
- [x] Only `ask_user` calls from the leader surface to the user; sub-agent `ask_user` calls are suppressed — `ask_user` is stripped from the toolset on any subchat turn

### 0.6.1 — Stack tracer UI

*Status: built & typechecked (cargo check + `npm run build` green). The trace is reconstructed from persisted records, not live state: a new `get_subchat_tree(chat_id)` command (recursive CTE over `chats.parent_chat_id`, subchats only) returns every descendant subchat with its conversational message count (`SubchatNode` model). The `StackTrace` block ([StackTrace.tsx](../src/components/Message/StackTrace.tsx)) renders in a leader's `BotTurnView`, scoped to that turn by the `subchat_id`s parsed out of the turn's `spawn_subagent` tool results (`spawnedSubchatIdsFromBlocks`) — so it survives reload and ties each trace to the turn that produced it. The block is collapsible (thinking-block styling); the tree is leader → sub-agent → nested, each node showing the zone avatar, name, and message count; expanding a node lazily loads and renders that subchat's transcript inline. Renders nothing for ordinary (non-leader) turns.*

- [x] Inline stack trace block in the assistant message: collapsible, styled like a thinking block — `StackTrace` (Network icon, chevron header) mirrors the thinking-block container
- [x] Tree of agent calls: leader → sub-agent → (nested sub-agents if any) — leader root + recursive `SubchatNodeRow` via the `parent_chat_id` child map
- [x] Each node: zone avatar, zone name, message count, expand/collapse — zone avatar/name resolved from the store, message count from `SubchatNode.messageCount`
- [x] Expanding a node shows the full subchat transcript inline — `SubchatTranscript` lazy-loads `get_messages` and renders the user/assistant turns
- [x] Stack trace persists on chat reload (reads from subchat records in DB) — derived entirely from persisted tool results + the `get_subchat_tree` query, no live streaming state

### 0.6.2 — UX & accuracy pass

*Status: built & typechecked (`npm run build` green). A batch of small, well-scoped bug fixes shipped as one release; one commit per change. No schema or backend changes — entirely frontend/store except the version bump. The headline fix is the citation rework: inline `[n]` markers were auto-inserted for every search result sharing as few as 3 words with the answer, so a single `web_search` sprayed a marker every few words. Replaced with a hybrid — trust the model's explicit `[n]` markers when present (no auto-insertion), otherwise a tight heuristic that only marks a source with a verbatim host/filename or a distinctive word (≥5 chars) unique to one candidate across the whole set. The Sources list ([CitationSources.tsx](../src/components/Message/CitationSources.tsx)) now splits into "cited" (the used subset, numbered to match the inline markers) and a secondary "more retrieved" toggle holding the full candidate list. Token/timer accuracy also improved: per-message stats now read from the turn aggregate so multi-step turns count every step, and tok/s discounts tool-execution wall-clock (tracked on the turn aggregate via `tool_call_executing`/`tool_call_result`) while the overall timer keeps full wall-clock.*

- [x] Web + citation links open in the OS default browser — anchor clicks routed through the existing `open_path` command instead of `target="_blank"` (a no-op inside the Tauri webview); covers markdown body, auto-inserted inline citations, and the Sources list
- [x] Long model names truncate in the chat top bar — zone/model label in [ZonePicker.tsx](../src/components/Chat/ZonePicker.tsx) clamped to a max width with ellipsis (full value on hover), so a long model id no longer pushes the rest of the bar around
- [x] Tool-call args/output cap their height with a scrollbar — Arguments and Output panes in [StepBlock.tsx](../src/components/Message/StepBlock.tsx) clamped to `max-h-280px` with `overflow-auto`, matching the thinking-block behavior
- [x] Token totals span every step of a multi-step turn — saved per-message stats read from the turn aggregate (which accumulates across the whole agentic loop) rather than just the final assistant iteration
- [x] tok/s excludes tool-execution time — cumulative tool wall-clock tracked on the turn aggregate and subtracted from the tok/s denominator (live + saved); the overall duration still counts full wall-clock, so live tok/s holds steady while a tool runs instead of decaying
- [x] Inline citations no longer spray; Sources split into "cited" vs "more retrieved" — hybrid model-marker/tight-heuristic strategy (see status note), full provenance preserved behind a secondary toggle
- [x] Embedding model picker shows the full list on open — swapped the native `<datalist>` (filter-only) for the shared `ModelCombobox`, which lists every model on focus and narrows only after the user types

### Backlog — known issues (unscheduled)

*Surfaced during the 0.6.2 review; not yet slated to a release. Movable. #10 and #11 are the highest-impact.*

- [x] **State not saving — search provider** — *closed by deletion in 0.9.12*: the single-provider `web_search` tool was retired in favour of the keyless `smart_search`, so the provider/endpoint/key settings it fed were removed entirely. The field that wouldn't persist no longer exists
- [x] **Dropdowns not styled consistently** — *fixed in 0.7.0*: a shared `SettingSelect` (styled control + chevron) now backs Default provider, Quick chat base zone, Search provider, and MCP transport
- [x] **Branch only works from the primary response in perspective mode** — *fixed*: perspective `ParticipantCard`s now receive `branchFromMessageId={p.messageId}`, so the Branch action appears on every perspective card. The backend `branch_chat` already copies history by the pivot's timestamp, so branching from a perspective's message id forks the chat up to and including that round (no backend change needed)
- [x] **Chat history mix-ups** — *root-caused and fixed in 0.9.12*. The guess was right: index keys. `MessageThread` was mounted without a `key`, bot turns are keyed `bot-${i}` and text blocks `text-${i}`, so a `TextBlockView` instance was reused across chat switches — and `useThrottledStreaming` synced its rendered copy inside an effect keyed on `[streaming]` alone, which never re-runs when both the old and new chat are idle. The block kept the previous chat's text; user messages (keyed by id) updated, hence mismatched pairs. The hook now returns `source` directly when idle, and `MessageThread` is keyed by chat id. See [PRE_1.0_PASS.md](PRE_1.0_PASS.md#1-chat-crossover--answers-from-the-previous-chat)
- [x] **Tool approvals inside subchats never reach the user** — *closed in 0.9.12*. 0.9.11 had already fixed the rendering half (banners no longer gated on `isSubchat`); what remained was discovery — `ChatPanel` only rendered `pendingApprovalByChat[activeChatId]`, so an approval waiting in a background sub-agent was invisible from the leader chat where the user actually sits. The store had the data all along (the stream listener routes by the event's own chat id). Now: an amber banner above the composer names every other chat with a pending approval and jumps to it, plus a shield marker on the sidebar row. No backend change
- [x] **Most settings not persisted across app updates** — *fixed in 0.7.0*: root cause was the SQLite settings DB living under the bundle-identifier app data dir (`%APPDATA%\com.multizone.desktop`), which the Windows installer clears on update. User-facing preferences (`app_settings`, `theme`, `default_zone_id`) are now mirrored to an installer-safe sibling file (`%APPDATA%\MultiZone\settings-backup.json`) on every write and restored automatically when the DB comes up fresh/wiped. `reset_database` also clears the backup so a deliberate reset stays reset

---

## 0.7.x — Settings Rework & UI/UX Polish

### 0.7.0 — Settings rework

*Status: built & typechecked (`npm run build` green). The settings modal keeps every existing section but regroups the nav into labelled groups — **Models** (Providers), **Interface** (Appearance, Chat), **Tools & context** (Search, Skills, Knowledge, Memory, MCP), **System** (API, Data) — via a new `NavGroup` header component. Styling was unified: a shared `SettingSelect` (styled, chevron) replaces the bare native `<select>`s on the Providers default-provider, Quick-chat base zone, Search provider, and MCP transport fields; a `ToggleRow` component standardises the labelled on/off rows (Chat auto-title / reasoning, Appearance shadows / bloom); the `.input` class that the Knowledge tab relied on was promoted from inside `ProviderForm` to a modal-level `<style>` so it's always present. Two misfiled controls moved from Chat → Appearance because they're visual, not behavioural: **Perspective layout** (stacked/columns) and **Zone library page size** (the sequential/parallel *run mode* stays in Chat as a performance setting). Inline validation arrived via a reusable `NumberField` (Memory max-entries) and a red-border + message on the API port — both validate per-keystroke and highlight invalid input rather than silently reverting on save. Separately, ephemeral view state is now durable: a new [uiState.ts](../src/lib/uiState.ts) (`usePersistentSet` / `usePersistentBool`, localStorage under `ui.*`) persists collapsed project folders, the sidebar open/closed state, folded branch groups, and expanded stack-trace blocks / subchat transcripts across sessions.*

- [x] Settings modal reorganized into labelled nav groups — all sections kept (Models / Interface / Tools & context / System), not dropped to the planned subset
- [x] Appearance section: light/dark mode, global accent color, typography (font family + size), visual effects (shadows, bloom/glow), background effects (type, speed, density, opacity) — plus the relocated Perspective layout + Zone library page size
- [x] Consistent styling pass: shared `SettingSelect` for dropdowns, `ToggleRow` for toggle rows, global `.input` class, `Section` helper
- [x] Settings validated on input; invalid values highlighted inline rather than on save (`NumberField`, API port)
- [x] Open/closed view state persists across sessions — project folders, sidebar, branch groups, stack-trace + subchat expansion ([uiState.ts](../src/lib/uiState.ts))
- [x] Settings survive app updates — preferences mirrored to an installer-safe backup outside the bundle-identifier data dir and restored on a fresh/wiped DB ([settings.rs](../src-tauri/src/commands/settings.rs), [state.rs](../src-tauri/src/state.rs)); closes the "settings lost on update" backlog item

### 0.7.1 — Chat export

*Status: built & typechecked (`npm run build` green). One pure module — [export.ts](../src/lib/export.ts) — builds both formats off a single resolved `ExportChatData` snapshot (chat metadata + the fetched message list + a zoneId→info map), driven by an `ExportMenu` button in the chat header ([ExportMenu.tsx](../src/components/Chat/ExportMenu.tsx), hidden on read-only subchats). Markdown: YAML frontmatter (title, chat_id, zone, model, project, tags, created/updated/exported ISO dates) + `## Role · timestamp` blocks, body text from the visible `text` content parts only (hidden context-injection parts excluded), image parts noted as `_N images attached_`; downloaded via a Blob (same pattern as the Skills export, no extra fs permissions). PDF: a theme-aware standalone HTML document rendered into a hidden iframe and sent to the OS print dialog ("Save as PDF"). Message markdown is rendered to HTML via the app's own stack (`react-markdown` + GFM through `renderToStaticMarkup`), so formatting survives — headings, bold/italic, lists, fenced code, blockquotes, tables, links — styled to the inlined light/dark palette + user accent + configured font, laid out as user-right / assistant-left bubbles. The page is sized to the full rendered content height so the export is **one continuous page with no breaks**; the title/zone/export-date header sits inline at the top (an earlier `position:fixed` header overlapped the first message and was cut off). Only user/assistant turns with visible text or images are exported — tool/system/empty turns are dropped.*

- [x] Export chat as Markdown: single `.md` with frontmatter (title, zone, model, project, tags, dates) + timestamped message blocks (distinct from the planned live-mirror in 0.7.2)
- [x] Export chat as PDF: theme-aware print document matching the active theme — accent, light/dark background, font family, message-bubble layout — with rendered markdown formatting preserved
- [x] Continuous single-page PDF (sized to content height, no pagination); inline header with chat title, zone/project, and export date
- [x] Export entry point in the chat header (`ExportMenu`), with a Markdown / PDF dropdown

### 0.7.2 — DB/Markdown toggle

*Status: built & typechecked (`cargo check` + `npm run build` green). **Plaintext markdown storage with two-way sync** — the DB stays the source of truth, but when the toggle is on every chat also lives as a real `.md` file the user can read, edit, version, and move outside the app, and edits flow back in. A new backend module — [mirror.rs](../src-tauri/src/commands/mirror.rs) — owns both directions. Config (`markdownMirrorEnabled` + `markdownMirrorDir`) lives in the same `app_settings` JSON the rest of the app uses, so it cheaply no-ops when off.*

***DB → files.** `mirror_chat` rewrites a chat's whole `.md` from current DB state on each call (always correct regardless of which save fired it), in the **same format as the 0.7.1 manual export** (YAML frontmatter + `## Who · timestamp` blocks). Files are keyed by chat id (filename suffix `--<chat_id>.md`) so a title change renames cleanly instead of orphaning; subchats are skipped. Hooked into the message engine at the turn chokepoint (`run_turn`, covering send + regenerate + all perspectives), plus per-participant regenerate, message edits, auto-title, and chat deletion (removes the file) — all best-effort so a write failure only logs and never blocks the engine. Zone configs are written as `zones/<id>.json` alongside on each pass.*

***Files → DB.** A `notify`-debounced watcher over the mirror folder (mirroring the knowledge-watcher pattern, init at startup + re-synced on settings change) pulls external `.md` edits back in. A content-hash record of every file we write lets the watcher ignore its own echoes, avoiding a feedback loop. Sync is deliberately conservative and lossless: the title and same-shape message-text edits flow back (matched one-to-one against the chat's visible turns, leaving tool/perspective turns markdown can't represent untouched); structural rewrites are left for the DB to own. A `chat-file-synced` event refreshes the open chat live.*

*Two commands back the UI: `mirror_all_chats` (re-write everything; run when enabled / folder changes) and `import_chat_from_markdown` (bring a loose file in as a new chat). Settings → Data gained the toggle, folder picker, "Mirror all chats now", and "Import from markdown…".*

- [x] Settings → Data: storage toggle ("Store chats as markdown files"); configurable output directory
- [x] Each chat stored as a `.md` file: frontmatter (chat ID, zone, project, tags, dates), messages as timestamped blocks
- [x] Zone configs exported as individual JSON files in a `zones/` subdirectory alongside the markdown chats
- [x] Markdown files updated on every message save (turn chokepoint + edit/regenerate/auto-title; delete removes the file)
- [x] **Two-way sync** — external edits to a `.md` (title, message text) are watched and pulled back into the DB; self-write echoes suppressed by content hash; structural rewrites left to the DB
- [x] Import from markdown: read a loose `.md` chat file in as a new chat (zone/project matched by name)

### 0.7.3 — UI/UX consistency pass

*Status: built & typechecked (`npm run build` green). The headline change is a shared modal shell — [Modal.tsx](../src/components/common/Modal.tsx) (`Modal` + `ModalTitle`) — adopted by all four panel modals (Settings, Zone editor, Zone library, Projects). Previously each hand-rolled its own overlay/panel/header with drifting values (header `h-12` vs `py-3` vs `h-14`, `rounded-lg`/`shadow-xl` vs `rounded-xl`/`shadow-2xl`, and three different close-button treatments); they now share one `h-14` header, `px-5` padding, `rounded-xl`/`shadow-2xl` panel, and a single muted→text close button in a consistent spot, with `max-h-[94vh]`/`max-w-[96vw]` so large modals never overflow the viewport. The sidebar's active-chat highlight was indistinguishable from hover (both used `panel-hover`); the active chat now gets an accent-tinted background + inset accent bar + medium weight, and collapse/expand animates the width (`transition-[width] 200ms`) instead of snapping. Message-thread spacing/alignment were already consistent (turn `gap-5`, `h-7 w-7` avatars, `gap-3` gutter, `ml-10` status banners); the one drift — user avatars lacked the `shadow-sm` bot avatars carried — was aligned. Save-button behaviour was audited: the zone form closes the editor on save, the project form refreshes and closes the panel — both as expected.*

- [x] Audit all modals: consistent header height, close button placement, padding — shared `Modal`/`ModalTitle` shell adopted by Settings, Zone editor, Zone library, Projects
- [x] Audit all form fields: consistent label size, input height, focus ring — shared `.input`, `SettingSelect`, `ToggleRow`, `NumberField` from 0.7.0 carry the field chrome; modal bodies reuse them
- [x] Audit all buttons: consistent size, disabled state, hover state — modal close buttons unified; panel action buttons share the bordered hover-accent / disabled-opacity pattern
- [x] Sidebar: collapse/expand animation (`transition-[width]`); active chat highlight (accent tint + inset accent bar, distinct from hover)
- [x] Message thread: spacing between messages, avatar sizes, alignment — verified consistent (`gap-5` / `h-7 w-7` / `gap-3` / `ml-10`); user-avatar `shadow-sm` aligned to bot avatars
- [x] Confirm all save buttons close panels as expected — zone form closes the editor; project form refreshes + closes the panel

---

## 0.8.x — Voice I/O

*Voice dictation in and spoken responses out. Honors the local-first principle: transcription runs through the same Provider rows the rest of the app uses (no embedded model host), and on-device is available by pointing a provider at a local server — the same way local LLMs work here. API providers are clearly marked as leaving the machine. All voice config lives in a new **Settings → Voice** section.*

### 0.8.0 — Speech-to-text (dictation input)

- [x] STT provider config in Settings → Voice: any configured Provider exposing an OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, or a local server like LM Studio serving a whisper model) — same Provider rows zones already use, no fixed vendor list. No embedded speech engine: an earlier `whisper-rs`/`whisper.cpp` build was dropped because it forced a `libclang`/CMake toolchain on every build, against this project's native-dependency-avoidance stance; "local" is now "point the provider at a local server"
- [x] Microphone capture (pure-Rust `cpal`, WAV-encoded via `hound`) with a mic button in both the in-chat input bar and the new-chat composer — push-to-talk (hold) and toggle-to-dictate (click) modes, sharing one `useDictation` hook
- [x] Final transcript committed on stop (the recording is uploaded and transcribed once capture ends; no live partials, which needed the dropped in-process engine)
- [x] Input device selection and a visible recording indicator (the mic button pulses red) while capturing
- [x] Language selection + auto-detect
- [x] Transcript insertion mode: insert at cursor vs replace field; optional auto-send on sustained silence (configurable threshold)

### 0.8.1 — Text-to-speech (spoken responses)

- [x] TTS provider config in Settings → Voice: reuses a configured Provider's OpenAI-compatible `/audio/speech` endpoint (no fixed vendor list), with model + voice selection
- [x] "Read aloud" action on any assistant / perspective response (in MessageActions) with pause / resume / stop controls
- [x] Auto-summarizing of the responses as to avoid tts-ing massive blocks of verbose response — condensed via the chat's own model above a configurable character threshold
- [x] Streaming-aware playback: responses are chunked by sentence and queued as they arrive so speech starts before the full answer completes
- [x] Auto-speak toggle: assistant responses are spoken automatically as they stream
- [x] Voice selection per provider; playback speed (rate) control
- [x] Per-zone default voice so different zones can sound distinct (stored in the zone's tool_config, overrides the global voice)

### 0.8.2 — Hands-free conversation mode

- [x] Voice conversation mode: STT input and TTS output chained into a continuous hands-free loop (toggle from the composer; committed transcript auto-sends, spoken response auto-restarts listening)
- [x] Barge-in — the user speaking (starting dictation) interrupts and stops current playback
- [x] Conversation state indicator in the chat header (listening / thinking / speaking)
- [x] Fully offline when local STT + TTS are selected; API providers surfaced as a "leaves your machine" warning consistent with the local-first principle (noted in Settings → Voice)

### 0.8.3 — Speech pipelining & voice cloning

- [x] Pipelined synthesis: upcoming sentences are synthesized in parallel ahead of playback (configurable prefetch depth, 1–8) so the next clip is ready the instant the current one ends, instead of a synth round-trip per sentence; clips still play strictly in order
- [x] Voice cloning: upload a reference sample + transcript (with optional auto-transcription of the sample via the STT provider) to register a named custom voice, for providers that support it (e.g. a local F5-TTS OpenAI-shim exposing `/audio/voices`); capability is a clearly-labelled toggle since most hosted providers don't support it
- [x] Provider-advertised voices: the voice field autocompletes from the provider's `/audio/voices` list when available, falling back to free text
- [x] Settings: split Voice into dedicated **Dictation** (STT) and **Speech** (TTS, cloning, conversation) sections
- [x] Response MIME pass-through so speech providers that return WAV (not MP3) play correctly

---

## 0.9.x — Tool Improvements

*A pass over the toolset: naming clarity, completing the file tools (move/copy/delete/search), and self-authored skills. Renamed tools keep a legacy alias in `ToolId::from_str` so existing zones and stored tool-call history don't break.*

### 0.9.0 — Tool naming & discoverability

- [x] Rewrote every built-in tool's user-facing label/description for plain English ([types.ts](../src/lib/types.ts) `ALL_TOOLS`, now typed `ToolInfo` with a `category`); machine names (what the model sees) left unchanged except the knowledge tool
- [x] Renamed `search_knowledge` → `search_local_files`; old name still dispatches
- [x] Legacy alias map in `ToolId::from_str` keeps renamed/old tool ids resolving from existing zones and history
- [x] Tools grouped by category in the zone editor (Files · Web · Knowledge · Agents · System · MCP)
- [x] Tri-state master toggle (on/off/mixed) plus per-category and per-MCP-server group toggles (`GroupToggle`); writes explicit ids rather than a wildcard
- [x] Curated zone presets updated; `safe_tool_ids` gains `plan`; curated library version bumped to 8

### 0.9.1 — File management & search tools

*Two new zone-selectable tool groups, so a zone can produce files without being able to destroy them: `file_manage` (dangerous) and `file_search` (read-only).*

- [x] `move_file(from, to)` — moderate safety; refuses an existing destination unless `overwrite: true`
- [x] `copy_file(from, to)` — moderate safety; single files only
- [x] `delete_file(path)` — dangerous (always approved); refuses a directory unless `recursive: true`, refuses to delete an allowed root
- [x] `create_folder(path)` — idempotent mkdir -p
- [x] `find_files(pattern)` — glob search, paths only
- [x] `search_file_text(query, glob?)` — regex/literal content search with file + line number; skips binaries and noise dirs
- [x] All move/copy paths scope-checked through a shared `checked_path` guard, covered by tests

### 0.9.2 — Self-authored skills

*A zone can now write a skill from a procedure it worked out, not just the user — the counterpart to memory (0.3.3), which captures facts.*

- [x] `create_skill(name, description, instructions)` — writes a new skill, stamped with the authoring zone; safe (level 0) since it's created disabled
- [x] Self-authored skills enter no catalog until the user enables them in Settings → Skills; carry a "written by \[zone\]" badge
- [x] `update_skill(name, instructions)` — moderate safety (approval required); leaves enabled state alone
- [x] Guardrails: duplicate-name detection, cap of 20 unreviewed self-authored skills

### 0.9.3 — Other recommended agent tools

- [x] **`plan` tool** (`update_plan`) — a checklist the model maintains across a turn, rendered inline as a progress list; stateless on the backend (lives in conversation history, so it survives reload/branching/export)
- [x] **`http_request`** — general HTTP call (status/headers/body); dangerous safety, no host allowlist (needed for localhost), 100 KB body cap, 30s timeout
- [x] **Context compaction** (`compact_context`) — model summarizes older turns; the summary replaces them going forward, nothing is deleted from DB/UI; moderate safety
- [x] **`ask_user` options** — already existed (options, free-text, multi-question form)
- [x] **User-editable tool descriptions** — per-zone overrides in `tool_config`, applied in `build_tools_for_zone` (covers MCP tools too)
- [x] **Tool usage stats** — per-zone call/error counters shown in the zone editor, with a reset control

---

### 0.9.4 — Token accounting refinements

- [x] Tool-call output tokens (streamed function-call args) now counted in per-message stats and tok/s
- [x] Context meter in the chat header — estimated input/output token split from all persisted messages, click to expand

---

### 0.9.5 — Tool reliability & citation accuracy

*Unplanned — fixes found by using the app: search misreported throttling as "no results", the Linux escape hatch couldn't hold state, and citation markers landed in the wrong place.*

- [x] `web_search` narrowed to DuckDuckGo (default), SearXNG, Brave, Tavily, Serper; the old "multi"/Marginalia fan-out is gone (auto-migrates)
- [x] DDG's anti-bot challenge (HTTP 202, not 429) is now detected and reported as a rate-limit error instead of "No results found"
- [x] `wsl_exec` — run Linux commands via WSL; one-shot by default, opt-in `persist=true` for a shell that holds cwd/env/venvs across calls
- [x] Windows PATHEXT resolution fixed for spawned programs — fixes `npx`-based MCP servers failing with "program not found"
- [x] Citation markers now anchor on the actual claim instead of a trailing link list; a source can be cited more than once
- [x] Citations now carry over from earlier turns when a later answer relies on them
- [x] Tool-call argument streaming fixed for providers whose opening delta differs (name-first vs args-first)
- [x] Title generation now runs in parallel with the answer instead of waiting for it to finish, and sees actual content (images included), not flattened text
- [x] Forced regenerate now re-reads the whole conversation instead of just the first message

---

### 0.9.6 — Long tasks that finish

*Unplanned — multi-step turns were ending before the work did, all three causes in the agentic loop.*

- [x] Step budget is now a setting (`maxToolSteps`, default 30, clamped 4–200); the model is warned near the end and forced to prose-only on the final step
- [x] Stalled turns (empty response, or an action announced but not taken) are detected and retried, up to 3× per turn
- [x] Empty assistant messages (no content, no tool calls) are no longer persisted
- [x] Zones with tools now get a system-prompt preamble explaining the agentic loop and the stall rules above

---

### 0.9.7 — Hound-based smart web tools

*Found via [Hound](https://github.com/dondai1234/master-fetch); the original single-engine `web_search` was frequently anti-bot-blocked. Three new tools, credited to Hound throughout. Legacy `web_search`/`extract_url` stay available for the key-based providers.*

- [x] Browser-emulating HTTP client (`wreq`, BoringSSL) — real Chrome TLS/HTTP2 fingerprint so keyless scraping succeeds instead of hitting a 202 challenge; adds a NASM/CMake build dependency, MSRV bumped to 1.85
- [x] `smart_search` — 7 keyless engines queried in parallel (DuckDuckGo, Bing, Brave, Yandex, Ecosia, Yahoo, Wikipedia), merged via Reciprocal Rank Fusion; one engine failing doesn't sink the query
- [x] `smart_fetch` — reads pages or PDFs as clean markdown, with relevance-query trimming; supersedes `extract_url` with PDF support and honest failure reasons
- [x] `smart_crawl` — same-site crawl from a seed URL, best-first when a `query` is given, capped at 15 pages
- [x] Wired into `ToolId`/`dispatch`/frontend registry; default and curated zones now use the smart tools
- [x] `cargo test` green; live smoke tests confirm all three tools end-to-end

---

### 0.9.8 — Traced PDF export & silent diagram repair

*PDF export showed only the model's prose, hiding tool calls, plans, and diagrams; a failed Mermaid diagram just sat as an error box.*

- [x] PDF export now includes the whole run — tool calls, reasoning markers, plans, diagrams — not just final text ([exportTrace.ts](../src/lib/exportTrace.ts))
- [x] Each tool call renders as a timestamped card with a plain-language summary, subject, and outcome; unmapped/MCP tools fall back to a prettified name
- [x] Reasoning renders as a marker (timestamp + character count) without exposing content
- [x] Plans, diagrams, plots, presented files, and search results render as real artifacts (checklist, inline SVG, file card, result list) instead of raw JSON
- [x] Summary strip under the export header: message/tool/reasoning counts, elapsed time, tools used
- [x] Mermaid parse failures now trigger an automatic one-shot repair (`fix_diagram`) in the background, with the corrected source written back so a reload shows no trace of the failure; manual "Ask model to fix" remains as fallback
- [x] `cargo test` + `npm run build` green

---

### 0.9.9 — Portable setup & saner defaults

*Two settings answered the same question, titling ran like a full turn, and there was no way to carry a setup to a second machine.*

- [x] Settings export/import ([settingsBundle.ts](../src/lib/settingsBundle.ts), Settings → Data): one JSON file carrying providers (keys optional), zones, skills, MCP servers, preferences and theme; ids preserved so cross-references survive and a re-import updates in place. Machine-local values (paths, mic, API token) and the seeding flags are excluded; import is two-step with a summary before anything is written
- [x] "Default provider" removed — the base zone (Settings → Chat, renamed from "Quick Chat base zone") is the single default assistant, and the fallback provider is derived from it ([baseZone.ts](../src/lib/baseZone.ts)); Rust resolves in the same order
- [x] Perspective zones now run in parallel by default (stacked layout unchanged); sequential stays for local models tight on VRAM
- [x] Title generation put on a leash: thinking disabled outright (`reasoning_effort: none` + `chat_template_kwargs: {enable_thinking: false}`, retried plain for providers that reject them), a ~200-word ceiling, and images only from a wordless turn — at most one, instead of four
- [x] Titles that come back as reasoning are now rejected rather than used: the candidate is cleaned (markdown, quotes, `Title:` labels) and validated (1–10 words, ≤80 chars, no trailing colon or code fence), falling back to the chat's opening message. Prompt asks for a noun phrase, so "History of Mechanical Pencils" over "Researching The History of Mechanical Pencils". Covered by unit tests
- [x] Default file directory (the file-tools fallback root) defaults to the OS Downloads folder on first run, so file tools work outside a project without setup; the markdown chats folder is unchanged (unset, chats stay in the app's own storage)
- [x] Per-zone live stats fixed ([app.ts](../src/store/app.ts), [StatusLine.tsx](../src/components/Message/StatusLine.tsx)): in a multi-zone turn each perspective's status line was fed by its *current* agentic-loop iteration rather than by the turn, so its timer restarted on every step (a zone eight steps in could read 39s) and its label claimed "Writing…" while the zone was mid tool call. Perspectives now keep the same per-turn aggregate the primary has, one per zone (`perspectiveTurnByChat`), and both branches fold events through a single shared reducer so the two accountings can't drift again. All status lines render from one component, so every zone reports its own phase (thinking / requesting *tool* / running *tool* / writing) plus elapsed, tokens and tok/s from its own generation. They also moved out of the strip under the thread and into the answering zone's own response block, so a side-by-side turn shows each zone's numbers in that zone's column instead of a stack of readouts under all of them. Saved per-message stats for a perspective answer now cover its whole turn too — they previously counted only the final step's characters and never discounted tool execution time, under-reporting tokens and skewing tok/s against the primary
- [x] Whitespace-only assistant text no longer splits a turn ([grouping.ts](../src/lib/grouping.ts)): models routinely store `"\n\n"` as the content of a message that carries a tool call. That was truthy, so it became a text block — rendering nothing but breaking the turn's steps into two activity rails around an empty gap. Only text with actual content counts as a block now, so consecutive steps merge into one rail and the copied answer loses the stray blank lines
- [x] Compact steps ([ActivityRail.tsx](../src/components/Message/ActivityRail.tsx), [stepSummary.ts](../src/lib/stepSummary.ts), Settings → Chat → Step display, on by default): an eleven-step turn used to be eleven stacked cards the reader had to scroll past to reach the answer. Each unbroken run of thinking/tool steps now folds into one thin horizontal rail — the sibling of the vertical accent line beside a response — that names the step in progress ("Reading file · notes.md") while working, then reports the run ("Worked through 11 steps"), with failure counts surfaced so a collapsed run can't hide an error. Clicking it opens the same per-step cards as before. A text block ends a run, so the model's prose always sits at the turn's top level; and the results a user actually asked for — plans, diagrams, plots, presented files, `ask_user` — are lifted out of the rail and render outside it (only the newest `update_plan` of a run, since the plan is a living document). Off restores the card-per-step view
- [x] Installed skill folders ([skillpacks.rs](../src-tauri/src/skillpacks.rs), Settings → Skills): MultiZone now reads the multi-file skill format the ecosystem publishes — a folder with `SKILL.md` plus reference pages and scripts — so packages like impeccable and HyperFrames can be installed with their own CLI and offered to every zone. Scans a managed folder (`<app data>/skills`) plus any folder the user adds, and understands the harness layouts an installer writes (`.claude/skills/<name>/`, `.agents/skills/<name>/`, and 12 more), so a repo that already ran `npx impeccable install` is picked up in place. `load_skill` gained a `file` argument that serves a pack's sub-files — jailed to the pack directory and tolerant of the harness-prefixed paths a SKILL.md writes inline — so progressive disclosure works for a zone with no filesystem tools; the catalog marks multi-file skills so the model expects to keep reading. Packs are read-only in Settings (the installer owns the tree), default enabled, and can't be shadowed by a `create_skill` of the same name. Settings carries a copyable install command for the managed folder

### 0.9.10 — Parallel sub-agents & shared-tree collaboration

*Status: built & tested (`cargo test --lib` 84 passing, `npm run build` green). A Response Leader could only ever talk to one sub-agent at a time: `spawn_subagent` awaited the nested turn inside the tool call, so a five-specialist panel cost five serial round trips and the leader sat idle through all of them. Both spawn and send now take `background: true`, which registers the run in a process-global registry ([subchat.rs](../src-tauri/src/tools/subchat.rs)) and drives the turn on a detached task behind an erased future (the same trick that already broke the run_turn → dispatch → run_send_entry recursion, but owning its context so it can be `tokio::spawn`ed). The leader gets the subchat id back immediately, so several spawns in one assistant message fan out genuinely in parallel; `collect_subagents` waits on the runs' `watch` channels with a deadline and then reads each reply out of the transcript — which is why a collected result survives whatever else the app was doing. Reuse got the same treatment: `list_subchats` reports the sub-agents a chat already has (zone, turns, original task, busy) and the leader preamble lists them by id every turn, because a leader on turn two otherwise has no idea it briefed anyone on turn one and re-spawns the same panel from scratch.*

- [x] Non-blocking sub-agents: `background: true` on `spawn_subagent` / `send_subchat_message` returns the subchat id at once and runs the turn detached, so one leader can put a whole panel to work in a single message and keep working while they think
- [x] `collect_subagents` — wait for background sub-agents (all of this chat's in flight by default, or named ids) with a deadline; `timeout_seconds: 0` polls status. Reports `ok` / `failed` / `still_running` per sub-agent, and returns whatever a failed run managed to write
- [x] `list_subchats` — the sub-agents a conversation already owns, so a leader continues one instead of duplicating it; the leader preamble also lists them (with ids) and any uncollected background runs each turn
- [x] Cancelling a chat cancels its background sub-agents ([messages.rs](../src-tauri/src/commands/messages.rs) `cancel_stream` walks the running-children tree), and denies their pending tool approvals — otherwise Stop looked like it did nothing while detached turns kept streaming
- [x] Leader orchestration preamble rewritten for the new shape: fan out rather than queue, reuse existing sub-agents, never end a turn with sub-agents in flight
- [x] Zone teams: a library preset can name a `team` ([library.rs](../src-tauri/src/commands/library.rs)), and the library groups those into a **Teams** section that installs every missing member in one action, leader first, sharing the name pool so members can't collide ([zoneLibrary.ts](../src/lib/zoneLibrary.ts) `installTeam`)
- [x] Shared-workspace coordination ([teamwork.rs](../src-tauri/src/tools/teamwork.rs), migration `026_teamwork.sql`) — the answer to "can they make their changes *alongside* each other rather than against each other". Sub-agents already had read/write/execute and inherited the parent's project directory, so they were already pointed at one working tree; what they had no way to do was know the others existed, which is why the only safe patterns were one-at-a-time or hand-a-patch-back. `claim_files` takes an advisory lock on a path with a stated intent, and `guard_write` (one hook in `dispatch`, so it covers every write tool and any future one) **refuses** a write to a file another agent holds — a claim isn't a convention a model can forget. An unclaimed write auto-claims, so the protection holds for a zone that never calls the tool; claims expire and are released when the agent's turn ends, so a crashed sub-agent can't own a file forever. `post_note` / `team_status` are the session's shared board, because a parallel edit only composes if the decisions travel with it and one sub-agent cannot read another's transcript. Scoped to the session (the sub-agent family's root chat), branch-safe, reads never blocked, and a single-zone chat never touches the tables at all (one count decides). Claim keys are built with the file tools' own `resolve_path`, so a claim and a write can't disagree about which file they mean
- [x] Leader preamble gains a shared-tree section when the leader has `teamwork`: decide the seams and post the contract *before* spawning, give each sub-agent a file-disjoint slice, read `team_status` between stages, and switch to hand-back-a-diff when work must be compared rather than combined
- [x] **Code Team** — a lead plus six specialists ([defaultZones.ts](../src/lib/defaultZones.ts)) for general codebase collaboration, replacing the SWE-Bench-shaped draft: talk to Code Team Lead conversationally about a symptom, a feature or an annoyance and it clarifies (`ask_user`, once, up front), has Code Scout map the ground and suggest file-disjoint seams, posts the contract, then runs Implementer (Careful) 0.15 and Implementer (Inventive) 0.85 on different slices of the *same tree at the same time* while Code Test Author writes tests against the same contract — Code Reviewer attacks the result, Code Verifier (0.0, facts only) builds and runs the suites on the combined tree. Compete mode for a hard bug: same brief to both implementers, no applying, diffs handed back, decided on test evidence. Solo mode because convening six agents to rename a variable is a worse answer, not a thorough one. Seven zones on one model at seven temperatures; shared collaboration rules in one constant rather than seven prompts; final report is written for a colleague, with the one-fenced-`diff` form kept for when a patch (not applied edits) is what was asked for
- [x] Toolsets made generous rather than minimal, across the whole curated set. Roles had been given only what their job strictly required, which is how the Code Team shipped with **nobody able to search the web** and no access to skills — a standard agent capability, missing from a team of agents. Every zone now has search and full page reads (a half-remembered library API is the most common way a confident patch is wrong) and `skills`; the coding roles add the code runner (the Reviewer can now *run* the breaking input it invented, which ends an argument that a described break only starts); `memory` goes to the roles whose durable facts outlive a session, and the shared rules point it at **project** scope, where it is injected into every agent on the project — the board's long-lived counterpart. Code Companion, Writing Editor, Data Analyst, Translator, Support Agent, Meeting Scribe and the MultiZone Assistant got the same pass, and the prompts that gained a capability say when to reach for it
- [x] Curated library refreshed (version 9): every preset's toolset brought up to the current tool surface (file search, present-file, compact, memory, smart fetch/crawl, shell) and the prompts that still described renamed tools rewritten — MultiZone Assistant now documents base zone / Smart chat / Multizone / Knowledge / Skills / Memory / MCP; Deep Researcher, Code Companion, Fact Checker, Data Analyst, Meeting Scribe, Support Agent, Writing Editor, Report Builder each gained the tools their own examples already implied
- [x] "Update from library" ([ZoneLibrary.tsx](../src/components/Zones/ZoneLibrary.tsx)): installing writes a copy, so a refreshed preset was invisible to anyone who already had the zone. An installed curated zone whose prompt/tools/temperature drift from the shipped entry now shows an amber **Update** badge, and the detail view re-applies the definition while keeping the zone's id, name, provider and model
- [x] Zones can ship with thinking enabled (`thinking` on a curated def) — on for the panel roles where deliberation is the point, off for the mechanical Test Runner
- [x] PDF export settings moved from Chat → Appearance (it is a question of how the document looks), and the export dropdown's explanatory footnote removed — the print-dialog hint lives with the setting now

### 0.9.11 — Terminals that stay open, exports that keep the panel

*Three gaps that all came down to something being dropped on the floor. Every way of running a command waited for it to finish, so a dev server or anything that asks a question part-way through simply could not be driven. Exporting a Multizone chat kept the leader's answer and threw away the panel it cross-examined to produce it. And a model asked about the app it is running inside had nothing to read but its own guesses.*

- [x] **Persistent terminals** ([terminal.rs](../src-tauri/src/tools/terminal.rs), tool group `terminal`) — a process the app keeps alive between calls, with reader tasks draining stdout and stderr into a bounded window the whole time, so nothing printed between tool calls is lost. `terminal_start` / `terminal_write` / `terminal_read` / `terminal_list` / `terminal_stop`, addressed by short ids (`t1`, `t2`). Several run at once; each holds its own stdin and output locks, so a 30-second wait on one doesn't block a read of another
- [x] Timing controls on every call that can wait, because driving an interactive program is a timing problem: `delay_ms` waits *before* typing (start a server, send the sudo password five seconds later — the case that motivated this), `wait_for` waits for a regex in the new output up to `timeout_ms` and reports `matched` so a miss is visible, `wait_ms` collects for a fixed span. Waiters are armed with `Notify::enable()` before the buffer is read, so output landing in the gap can't cost a full timeout
- [x] Cursors: every call returns one, and passing it back reads only what is new. Output past the window is dropped from the front and the read is told it has a `gap`, rather than silently skipping
- [x] Output is cleaned the way a terminal would show it — ANSI CSI/OSC escapes stripped, and a line redrawn with `\r` (every progress bar) collapsed to where it landed instead of a hundred copies of itself. `TERM=dumb`, `NO_COLOR` and `PYTHONUNBUFFERED` are set for the child, since block buffering on a pipe is what makes a live process look dead
- [x] Lifetime: deliberately no idle reaper — "still running an hour later" is the point. Terminals end when stopped, when their process exits, when their chat is deleted, or at app exit, which needed `Builder::run` swapped for `build()` + a `RunEvent::Exit` hook ([lib.rs](../src-tauri/src/lib.rs)) because on Windows a child is not taken down with its parent. `terminal_stop` uses `taskkill /T` there, so a shell's children go with it. Capped at 8 live terminals per session
- [x] Visibility scoped to the session (root chat + its sub-agents) via `teamwork::session_root`, so a leader's dev server is something its own panel can query and an unrelated chat cannot see. Pipes, not a PTY — documented in the tool description and module docs, including `sudo -S` and why Ctrl-C can't be sent
- [x] **Sub-agent conversations in chat exports** ([export.ts](../src/lib/export.ts), Settings → Appearance → Chat export): the delegated conversations now travel with the transcript, nested under the turns that spawned them, in both Markdown and PDF and at every detail level (in text-only mode they are the only trace of the delegation left). Diagrams a sub-agent drew are rendered too
- [x] The user/agent distinction the nesting made necessary: a `user`-role turn inside a subchat is *not* the person — it is the spawning zone briefing its sub-agent. Drawn as a left-aligned dashed brief labelled `Leader → Sub-agent`, never the right-aligned bubble that means "you said this"; Markdown gets the same arrow in its heading. A one-line legend under the header says it once for the whole document. `terminal_write`'s summary line names the terminal rather than reprinting what was typed, since that is how a password reaches a prompt
- [x] `SubchatIndex` hands each conversation out exactly once at its spawn call, which both prevents a double-render and terminates a cycle in the parent chain; anything never claimed is printed at the end rather than dropped
- [x] **`about-this-app` skill** ([defaultSkills.ts](../src/lib/defaultSkills.ts)) — a built-in reference on zones, perspectives, leaders and sub-agents, teamwork, projects and directories, knowledge, memory, skills, the tool surface and approvals, so "tell me about this harness" or "how should I set up a project" is answered from fact instead of invention. Deliberately not named after the app, so it reads as a base-level skill rather than branding
- [x] Skill seeding gained a version (`seededSkillsVersion` / `SKILL_SEED_VERSION`, mirroring `libraryCuratedVersion`): one-time seeding meant a skill added later could only ever reach brand-new installs. A version behind the shipped set fills in the missing built-ins *by name*, so an edited or deleted original is left alone
- [x] **MultiZone Assistant retired** (curated library version 10). Its entire reason to exist was a system prompt describing the app — which meant MultiZone could only explain itself to someone who happened to be sitting in that one zone, and the description went stale on every release. `about-this-app` does the same job for *every* zone with the skills tool, Quick Chat included, and is one file to keep current instead of a prompt duplicated into a preset. The skill's triggers now name the app, so "tell me about MultiZone" reaches it, and it absorbed the providers/MCP framing the zone carried. `seedCuratedLibrary` already prunes withdrawn curated entries, so it disappears from the library on update; a copy the user has already installed is left alone rather than deleted out from under their chats. Five starter zones still pre-install on first run
- [x] `terminal_stop` now stops what the terminal *started*. Reported from a real run: a time server kept answering the browser after stop returned `stopped: true, running: false`. `terminal_start` with a command runs it under a shell, so the server is a grandchild — and the kill signalled the supervisor first, which took the shell down and re-parented the server out of reach before the tree-kill ran. The call then truthfully reported the shell dead while the thing holding the port lived on. The tree comes down first now (`taskkill /T` on Windows; a process group and a negative-pid `kill` on Unix, so the group exists to be signalled), then the supervisor reaps. Regression test is black-box — a grandchild writes a second marker only if it survives — and it fails against the old ordering
- [x] Subchats are no longer read-only ([ChatPanel.tsx](../src/components/Chat/ChatPanel.tsx)). They were observable-but-inert on the theory that a conversation belongs to the zone that started it, which made a sub-agent's work a dead end: the interesting finding is usually *in* the subchat, and the only way to follow it up was to go back to the leader and ask it to relay. A subchat is an ordinary chat bound to the answering zone, so it now takes messages like any other, and the banner names the zone that can also send to it. **Export** works there too — the button was hidden by the same gate, and a subchat's own descendants come along
- [x] Opening that door meant opening two more, or the turn would hang where nobody could see it: tool-approval banners and `ask_user` cards were gated on the same `isSubchat` flag, so a user-sent turn that hit a dangerous tool would have waited on a prompt that never rendered. `ask_user` is also no longer stripped unconditionally in a subchat — `TurnOverride::agent_driven` (set by the subchat tools, false everywhere a person is on the other end) distinguishes a leader-driven turn, which genuinely has nobody to ask, from a user-driven one, where taking the question away just makes the sub-agent guess
- [x] Skills put to work across the Code Team. Every member already had the tool, but "check for a skill first" was one bullet among nine in the shared rules, which is not how something that changes *what the code should look like* gets treated. The shared rule now frames a skill as part of the brief rather than background reading, and three roles got the specific case spelled out: the **Lead** reads the catalog before convening and names the applicable skill in each agent's brief (they cannot know which one it judged relevant to their slice, and a skill missed at the start is a rewrite at the end), the **Test Author** checks for test requirements before writing a line (coverage floors, what may never be mocked, how fixtures are built — testing is where a project is most likely to have written its rules down), and the **Verifier** checks how the repo is actually built and run before inventing a command, since a confident failure from the wrong invocation is the one mistake nobody downstream re-checks

### 0.9.12 — Pre-1.0 hardening pass

*Status: built & tested (`cargo test --lib` 116 passing, `npm run build` green); the four behavioural fixes are not yet runtime-confirmed — each has a 🔁 entry in [TEST_CHECKLIST.md](TEST_CHECKLIST.md). Full write-up with causes and reviewer notes in [PRE_1.0_PASS.md](PRE_1.0_PASS.md).*

*The theme is subtraction and plumbing rather than features: three long-standing bugs root-caused, one duplicate toolset deleted, and the release infrastructure 1.0 needs.*

- [x] **Chat crossover fixed** — the "Chat history mix-ups" backlog item, root-caused to index-keyed React instances plus a `useThrottledStreaming` effect keyed on `[streaming]` alone (see the backlog entry above)
- [x] **`web_search` and `extract` removed** — `smart_search` / `smart_fetch` are the only web tools now. Retired ids resolve to their replacements in `ToolId::from_str` and in `dispatch`, so existing zones keep their capability; a new test asserts both the aliasing and that no definition offers the old names. Stored history still renders (display names and citation handling kept). Takes the global search-provider settings with it
- [x] **Knowledge earns its use** — a `# Knowledge` system-prompt block, gated identically to the `search_local_files` tool, naming the indexed scope and the routing rule (conceptual → search, exact string → `search_file_text`, known path → `read_file`). Free of counts and timestamps so it can't break the prefix cache the way the old `compact_hint` did. Shows in the context meter as its own row
- [x] **Sub-agent approvals surface** — a banner naming any other chat with a pending approval plus a sidebar shield marker, so a background sub-agent no longer stalls invisibly until its ~5-minute auto-deny
- [x] **Auto-updater** — `tauri-plugin-updater` + `process`, signed `latest.json` published alongside the installers, and a check/download/install/restart section in Settings → Data. **Needs two GitHub secrets set by hand before it works** — see [PRE_1.0_PASS.md](PRE_1.0_PASS.md#️-action-required-before-this-works)
- [x] **Version stamps reconciled** — 0.9.9 → 0.9.12 across `package.json`, `Cargo.toml`, `tauri.conf.json` (v0.9.9 shipped but the post-release bump never ran, so two releases of documented work sat under the old number)
- [x] **Formal test checklist** — [TEST_CHECKLIST.md](TEST_CHECKLIST.md), twelve sections with regression / setup-dependent / fresh-install markers and a sign-off table

---

### 0.9.16 — Streaming that stays smooth

*Two zones answering one arithmetic question made the whole app jitter — not the model's fault and not the machine's. Three separate costs were multiplying: a store write and a React pass per token, a full markdown re-parse per repaint whose cost grew with the length of the answer, and one timer per streaming block so concurrent zones never repainted together.*

- [x] **Stream events are applied in batches** — arrivals are queued and drained on a 16 ms timer ([ChatPanel.tsx](../src/components/Chat/ChatPanel.tsx)), same events in the same order, but React coalesces a burst of tokens into one render instead of one render each. A timer rather than `requestAnimationFrame` so a minimised window still drains; the queue is flushed on unmount so a chat can't be stranded mid-stream
- [x] **Finished text is parsed once** — [`splitMarkdownBlocks`](../src/lib/markdownBlocks.ts) cuts an answer at top-level blank lines and [`StreamingMarkdown`](../src/components/Renderers/StreamingMarkdown.tsx) renders each group through its own memoized renderer, so a repaint re-parses only the group still being written. Cost per repaint stops depending on how much has already been written. The split is conservative: never inside a code fence or a display-math region (`$$…$$`, `\[…\]`, `\begin{align}…`), and adjacent groups are re-joined where splitting would change meaning (loose lists renumbering, indented list continuations, broken blockquotes). Documents using reference-style link or footnote definitions opt out entirely, since those change how text above them renders
- [x] **One shared repaint tick** — [streamTick.ts](../src/lib/streamTick.ts) replaces the per-block `setInterval`; every live view repaints in the same task (one render pass, not N staggered ones) and the interval widens with the number of concurrent streams (60 ms → +40 ms each, capped at 200 ms), so an extra participant costs a slightly coarser repaint rather than a proportional drop in frame rate
- [x] **Reasoning is throttled too** — a long think streamed into a `<pre>` at token rate was the same jitter for a cheaper node; it now rides the shared tick ([useThrottledStreaming.ts](../src/lib/useThrottledStreaming.ts), lifted out of `Message.tsx` so both consumers share it)
- [x] Group wrappers keep the answer's spacing — the first/last-child margin reset is scoped to the whole answer rather than to each group ([styles.css](../src/styles.css))
- [ ] Measure it: frame timings for one stream and for four, before and after, on a long answer — the fix is reasoned from where the cost is, not yet from a profile

---

## 0.10.x — Reversible work

*The one thing every coding agent has that we don't: a way back. `write_file`, `move_file` and `delete_file` are one-way doors — the user's only protection is the approval prompt, which asks before the change and offers nothing after it. Approving an edit should not mean living with it. Prompted by Reasonix's auto-checkpoints and by Cursor/Antigravity, where reverting a bad run is a single click.*

### 0.10.0 — Checkpoints

*Status: the engine is built and unit-tested ([checkpoints.rs](../src-tauri/src/checkpoints.rs), migration [029](../src-tauri/migrations/029_checkpoints.sql), `cargo test --lib` 123 passing). Nothing is wired to a button yet — that is 0.10.1.*

- [x] A checkpoint is taken automatically before the first file-mutating tool call of a turn — content snapshots of every path the turn touches, not a whole-directory copy. Hooked in `tools::dispatch` rather than in each tool, so every caller is covered (GUI, HTTP API, sub-agents) and a new file tool is covered the day it is added
- [x] One checkpoint per turn, extended by each later mutating call: reverting is one action however many files a turn touched, and the state kept is the state before the *turn*, not before the second edit of the same file
- [x] Snapshot store on disk (`app_data_dir/checkpoints/blobs/<xx>/<hash>`), content-addressed so an unchanged file across many turns is stored once; creations recorded as "did not exist" so restoring one removes it rather than leaving the agent's file behind
- [x] The restore records what the tool *left behind* as well as what it found, so it can tell "the agent wrote this" from "somebody edited it afterwards"
- [x] Best-effort in both directions — a checkpoint that cannot be taken is logged and the tool still runs, because refusing to edit a file because we could not back it up is a worse failure than the one it guards against
- [x] Works for sub-agent and perspective turns too — checkpoints key on chat + turn + participant zone, so each zone in a teamwork run has its own revertible unit
- [x] Retention policy with a size ceiling, surfaced in Settings → Data alongside the other storage categories — 512 MB / 30 days by default (`0` on either = no limit), applied at startup and after any turn that took a checkpoint, plus an "Apply limits now" button beside a turns-kept / files / bytes-on-disk readout. **The newest checkpoint is never pruned** whatever the limits say — a ceiling of one byte should mean "keep almost nothing", not "the turn that just ran is already irreversible" — and blob collection is reference-counted, so content shared between checkpoints outlives the pruning of one referrer
- [x] What cannot be captured is named rather than glossed: a directory, a file over the 32 MB ceiling, or an unreadable path is recorded with the reason and reported by the restore instead of silently succeeding

### 0.10.1 — Undo in the transcript

*The restore engine landed with 0.10.0 (`restore()`, with per-path selection, conflict detection and an undo-of-the-undo checkpoint, all unit-tested); the Tauri commands and the transcript UI followed. One item is left, and it is a manual one: a real turn edited and reverted in the running app.*

- [x] Restoring puts every path a turn touched back to its pre-turn contents — engine
- [x] Per-file restore, so a run that got three edits right and one wrong doesn't have to be thrown away whole — engine (`only` argument)
- [x] Revert is itself a checkpoint — undo is undoable — engine, and covered by a test that reverts a revert
- [x] Conflict handling when a file was edited outside the app since the checkpoint: reported as a conflict and left exactly as found, with an explicit `force` for a user who has been told and insists — engine. This is the one failure the feature must not have, so it is the test written first
- [x] Tauri commands: `list_checkpoints` (with each path's change type and whether it has diverged *now*, computed at read time rather than stored) and `restore_checkpoint` (optional path subset, optional force)
- [x] A turn that changed files shows what it changed, under the answer: each path with its change type, click-to-reveal, per-file revert, and a "Revert turn" action ([TurnChanges.tsx](../src/components/Message/TurnChanges.tsx)). A diverged path is marked "edited since" and its revert becomes a two-step "Revert anyway…" → "Confirm revert", so overwriting the user's own edit is never one click
- [x] Checkpoints are anchored to the assistant message the turn opened with (migration [030](../src-tauri/migrations/030_checkpoint_message.sql)), so a five-step turn offers one revert at the top rather than five
- [ ] Runtime-test the whole path: a real turn that edits a file, then revert it from the transcript
- [x] The existing "Branch from here" and a revert compose: branching a chat at a reverted point starts from the restored tree — `restore_to_message` undoes every later turn's checkpoint **newest first**, which is what makes it work at all (each restore hands the turn before it the state it expects, so conflict detection keeps meaning "somebody edited this outside the app" instead of tripping on our own later writes). The branch button asks rather than assumes, and only when there is something to undo: *N later turns changed M files*, rewind or not, with diverged paths named up front and reported as left-as-found after

### 0.10.2 — Review before apply

*Status: built & tested (`cargo test --lib` 143 passing, `npm run build` green); not yet runtime-tested. Checkpoints answer the half of "approving an edit shouldn't mean living with it" that comes after the change; this is the half that comes before. The line diff is the pure-Rust `similar` crate ([diffs.rs](../src-tauri/src/diffs.rs)); the tool-facing layer — what a pending call would write, narrowing it to a hunk selection, and the staging queue — is [review.rs](../src-tauri/src/review.rs) with migration [031](../src-tauri/migrations/031_staged_edits.sql). One [DiffView](../src/components/common/DiffView.tsx) serves both the approval prompt and the queue, since both ask the same question and shouldn't answer it in two visual languages.*

- [x] Diff preview in the approval prompt for `create_file` / `edit_file`: the change as added and removed lines rather than a wall of proposed content, so approval is an informed act. Computed from the file as it stands (not from what the model remembers), and best-effort — a preview that can't be rendered never blocks an approval
- [x] Approve / reject per hunk for multi-hunk edits — the selection **rewrites the call's arguments** so the tool writes exactly what was agreed to. Per-hunk approval that only recorded a preference would be a worse lie than not offering it. The tool's *name* is left alone, so history, checkpoints and the usage counters stay coherent
- [x] A "review queue" mode where a zone's edits stage rather than land, and the user applies the batch after reading it (Settings → Chat, off by default) — apply/discard whole, per file, or per hunk; each apply is checkpointed so it stays revertible; a file edited on disk since queueing is reported as a conflict and left as found unless the user insists
- [x] The queue is usable by an agent, not just visible to a user: `read_file` serves the staged version, so a model that edits one file three times builds on its own last version rather than silently on the stale disk — and the staged tool result tells it the change is queued, not written, so it doesn't report to the user that a file has been saved when it hasn't

---

## 0.11.x — The app sets itself up

*Two problems that turn out to be one. The local HTTP API is the 0.5.x app — ten routes written alongside subchats, with nothing added since, so skills, memory, MCP, knowledge, checkpoints, terminals, usage and settings are all invisible to it; and nothing about it is discoverable, so "is it even running" is a question neither a script nor a model can answer. Meanwhile MCP servers and connectors are configured by hand in a settings panel that assumes you know what a stdio transport is. A zone that can read the app's own configuration, check what is reachable, and say why something is not, is a setup wizard that happens to be a conversation — which is what non-technical users are actually missing. Full write-up in [CONNECTIVITY.md](CONNECTIVITY.md).*

### 0.11.0 — The API tells the truth about itself

*Status: built & tested (`cargo test --lib` 147 passing, `npm run build` green); not yet exercised against a live server. The route table and handlers are [api/routes.rs](../src-tauri/src/api/routes.rs); the ten hand-rolled 0.5.x handlers stay in [api/mod.rs](../src-tauri/src/api/mod.rs) alongside the server, auth and SSE plumbing. The structural decision: **handlers call the Tauri command functions rather than re-implementing them in SQL** — `AppHandle::state()` hands back the same managed `AppState` the GUI uses, so a route and a button cannot behave differently, which is the other way an API rots. 10 routes became 105.*

- [x] `GET /api/routes` — method, path and one-line description for every route, served from the same table `COVERAGE` points at and the drift test checks, so the README and the API cannot disagree. Carries a `routeSetVersion` so a caller can tell "the app is older than my script" from "my script is wrong"
- [x] `/api/health` answers the questions a caller actually has, separately: enabled in settings · socket bound · answering · token present · token accepted · app version and route-set version. **`tokenAccepted` is reported without requiring auth** — "is my token wrong" is exactly the question you cannot ask through a door your token has to open
- [x] The bind outcome is persisted (`api_bind_state` settings row), not just shown once in Settings — written on every start, failed start, and deliberate stop, read by both `/api/health` and Settings → API, which now shows a red "switched on but not listening on port N: *the OS's own words*" panel instead of a toggle that reads "on" with nothing behind it
- [x] Drift test: every Tauri command has either a route or an explicit "GUI-only" exemption *with a reason written out*, checked against the `generate_handler!` list in `lib.rs` — in both directions, so a stale claim about a command that no longer exists also fails. It caught a command on its very first run (`api_bind_state`, added minutes earlier in this same release). **This is the item that keeps the rest of the release from rotting the same way**
- [x] Filled every gap the drift test found — skills and skill packs, memory, MCP servers/tools, knowledge (global and per-project), subchat trees and sub-agent rosters, checkpoints and the review queue, tool and token usage, settings rows, the markdown mirror, and zones/providers/projects/tags **as writes**, so a script can provision the app rather than only drive it

### 0.11.1 — A tool for the app's own API

*Status: built & tested; shipped as `app_read` / `app_control` ([app_control.rs](../src-tauri/src/tools/app_control.rs)) rather than one `app_api`, because the read and the write are different acts and deserve different danger levels. One item is left, and it is a runtime one.*

- [x] The model names a route and a body and the tool makes the call — but **in-process**, through the same `axum` router the socket serves ([`api::call_in_process`](../src-tauri/src/api/mod.rs)), rather than over a loopback socket with a token attached. No port, no socket, no token anywhere in the path, and the tool works whether or not the user has ever switched the HTTP server on — which is the common case for someone who has never wanted remote access
- [x] **The token is never returned to the model.** The obvious design — a tool that hands over port and token so the model can `http_request` its way around — puts a live bearer credential into the context, one prompt injection away from leaving the machine, in an app whose whole premise is that nothing leaves unless the user sends it. Proxying costs one indirection and removes the whole class; serving in-process removes the credential as well
- [x] Self-diagnosis: `app_read "/api/health"` reports the five checks separately (enabled · bound · answering · token present · token accepted), so "why can't you reach the API" is answered with the one that is false. The tool is deliberately not a hand-written catalog of app actions either — `GET /api/routes` is the catalog, so a route added next release is callable the day it lands with nothing in the tool to update
- [x] Writes go through the same approval pipeline as any dangerous tool; reads are moderate — `app_read` reads the user's own app, including provider settings, so it is not in the safe default set either. Two paths are refused outright whatever they are dressed up as: running a turn from inside a turn (that is `subchat`, under the user's supervision) and answering a tool approval (the model granting itself permission)
- [x] The write side tells an open window what it changed, so a preference or a zone changed by a model or a script is visible immediately rather than at the next restart
- [x] Runtime-test it against the running app: ask a zone to change the theme, create a zone, and diagnose a deliberately broken API setting

### 0.11.2 — Connectors without a config file

*Status: built & tested (`cargo test --lib` 154 passing, `npm run build` green); not yet runtime-tested against a live server. The catalog is [mcp/catalog.rs](../src-tauri/src/mcp/catalog.rs) over [connectors.json](../src-tauri/src/mcp/connectors.json), the diagnosis is [mcp/diagnose.rs](../src-tauri/src/mcp/diagnose.rs), and the commands are [commands/connectors.rs](../src-tauri/src/commands/connectors.rs) with migration [032](../src-tauri/migrations/032_mcp_headers.sql). Prompted by Google's [Gmail MCP guide](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server), which asks for a hosted HTTP server behind an OAuth token — a setup the MCP panel could not express at all.*

- [x] Connector catalog: curated MCP server entries — command, URL, required environment variables or headers, prerequisites, and a link to where each credential comes from — installable in one action. The zone library pattern applied to `McpServer` rows; no protocol work at all. Shipped set: Gmail, GitHub, Context7, Tavily, the reference filesystem server, Playwright. Installing writes the row and stops; nothing launches or connects until the user presses Connect
- [x] Catalog entries are JSON files on disk and importable from a URL (one entry, a list, or `{entries: […]}`), so the set is community-extensible rather than something we alone curate. An imported entry sharing an id with a shipped one replaces it — that is how a user fixes an entry that has gone stale between releases — and an id is validated as a filename-safe slug before it is ever written
- [x] `headers` on `McpServer`, applied in `HttpConn::send`. The HTTP/SSE transport sent `Content-Type`, `Accept` and `Mcp-Session-Id` and had nowhere to put an `Authorization` header, which made **every** hosted remote MCP server unreachable — a one-column gap with a whole-ecosystem consequence. A 401 now also says which of "no credentials are configured" and "the credentials were rejected" it is, since only one of those is fixed by pasting a fresh token
- [x] Connection diagnosis worth reading: the checks run in the order they can fail — enabled · command · program-on-PATH · the credentials the entry marks required · the handshake — and the report names the first false one with the next step. stdio stderr is captured rather than discarded (it was `Stdio::null()`), so "the server exited without answering" arrives with the server's own words attached. Checking the credentials *before* the handshake is the point: a missing `TAVILY_API_KEY` and a missing npx both look like a child that exited immediately, and telling them apart afterwards is guesswork
- [x] The model may propose and diagnose a connector; the user approves the write. `list_connectors` and `diagnose_mcp_server` are routed as reads reachable by `app_read`; installing is `POST /api/connectors/install`, which is `app_control` and therefore an approval prompt. Silently adding an MCP server that launches a process is precisely what an injected prompt would ask for
- [x] Runtime-test the whole path: install a catalog entry, connect it, break it deliberately, and read what Diagnose says
- [~] Gmail specifically is reachable but not yet *comfortable* — Google's access tokens last about an hour, so the entry is paste-again-when-it-expires. Refresh, per-scope consent and keychain storage are 1.2.x, as scoped there

### 0.11.3 — Appearance the model can reach, and controls that behave like themselves

*Status: built & tested (`cargo test --lib` 160 passing, `npm run build` green); not yet runtime-tested. The theme blob is now described in Rust — [theme.rs](../src-tauri/src/theme.rs) — and served by two routes in [api/routes.rs](../src-tauri/src/api/routes.rs). 0.11.1 gave the model the whole API and 0.11.0 gave it a route index; what neither gave it was any idea what a **body** should contain. `PATCH /api/settings/theme` accepted `{"colour":"#fff"}` as happily as `{"accent":"#fff"}`, wrote it, and returned 200 — so the model told the user the theme had changed and nothing had. That is the failure mode this release closes, on the appearance surface first because it is the one users ask for by voice.*

*Alongside it, two places where the app stopped behaving like itself: editing a message dropped you into a control that exists nowhere else and silently removed the attachments, the attach button and the microphone; and the title bar could not be dragged — or safely tapped — with anything but a mouse.*

- [x] **Custom CSS** on the theme (Settings → Appearance → Custom CSS), injected as one `<style>` element kept last in `<head>` so an equally specific rule wins without anyone having to discover `!important`. Behind its own toggle, because the whole point of the escape hatch is that it can write a rule that hides the control you would need to undo it — switching the sheet off has to be possible without first finding the offending line. Capped at 100 000 characters, which is a runaway paste rather than a preference
- [x] `GET /api/theme` — the resolved theme (defaults filled in, so a reader sees what is *in force* rather than only what happens to have been written) alongside a schema: every field with its type, range, default and a line on what it is for, plus the palette-key ↔ CSS-variable table with both base palettes. The same self-description principle as `/api/routes`, one level down, which is why the tool description gets a pointer to it and not a copy that would rot
- [x] `PATCH /api/theme` — validated, and the validation is the entire reason it exists next to the settings route: an unknown field, a colour that isn't hex, an effect that doesn't exist or a number out of range comes back named (`unknown theme field \`colour\` — the fields are: …`) instead of being written and ignored. One retry the model can act on, rather than a success it reports to the user
- [x] The palette section — background · panels · hover · borders · text · muted text, per mode — is reachable and documented as such, which was the specific ask. `colorsDark` / `colorsLight` replace their map whole (the merge is top-level), so `{}` is how a caller resets one
- [x] The tool-facing `ThemePalette` reads the user's own palette overrides rather than the stock ones, so `render_graph`'s "pick colours readable against the background" guidance is finally about the background on screen
- [x] **Editing a message is the composer**, not a stray dialog ([EditComposer.tsx](../src/components/Chat/EditComposer.tsx)): same shell, same paperclip, same mic, attachment chips above it, Save and Cancel where Send would be. The old editor was a bare textarea with two buttons — a control appearing nowhere else in the app — and it took three things away at the moment you most wanted them: the attachments vanished from view (still resent as hidden parts, but invisible and impossible to remove), nothing suggested you could attach more, and there was no microphone in the one place where speaking a corrected sentence is most useful
- [x] Attachments in an edit are staged items rather than opaque hidden parts, so removing one means it is gone and adding one means it is sent. Hidden parts no marker claims are still carried through untouched — losing unnameable context on every edit would be worse than either — which is what `splitAttachments` is for
- [x] The file-staging loop (classify · render a PDF or extract its text · refuse a binary out loud) is one `useAttachments` hook instead of two copies that had already drifted: the input bar honoured the OCR fallback when choosing how to attach a PDF and the home screen didn't. Editing would have been a third
- [x] **Every colour picker takes a hex value**, in one `HexColorField` ([ColorPicker.tsx](../src/components/common/ColorPicker.tsx)) used by all four: accent, the palette grid, the background-effect colour, and the zone/project/tag picker. A bare `<input type="color">` opens the OS dialog — on Windows an RGB one — so a colour you already had as `#4f9cf9` could only be entered by converting it to three numbers by hand, and the value you had chosen was never shown back to you in the form you think of it in. The `#` is optional and three-digit shorthand expands; a value applies live as soon as it parses, and anything that isn't a colour is marked and reverted on blur rather than written and rendered as nothing. The palette grid drops to two columns to make room, which it can afford
- [x] **The title bar works with a finger or a stylus.** `data-tauri-drag-region` is a script Tauri injects that listens for exactly one event — `mousedown` — which touch and pen never produce while the contact is down; Chromium synthesizes it only after deciding the gesture was a tap. Dragging was impossible, and a tap was worse: the late `mousedown` started a drag with nothing held down, i.e. `ReleaseCapture()` + a posted `WM_NCLBUTTONDOWN` into the OS move loop whose ending release had already happened, so the bar stopped responding. Non-mouse pointers are handled directly now (drag on `pointerdown`, double-tap to maximize), with the late compatibility `mousedown` swallowed in the capture phase so the injected script cannot start the second, stuck drag
- [x] Dictation over a selection replaces it, as typing does. Starting a recording with text highlighted used to splice the transcript in at the left edge of the selection and leave the highlighted text sitting there — the one behaviour no one expects, since every other way of putting characters into a selected field overwrites it. The caret lands after the spoken words
- [x] Runtime-test: ask a zone to repaint the palette and write a custom sheet, and confirm both land in the open window without a restart

---

## 0.12.x — Planning & task control

*We have a `plan` tool — a checklist the model keeps. That is the smallest version of this. The competitors that feel controllable have three things we don't: a mode where the model plans and is not yet allowed to act, a plan the **user** can edit before it runs, and a record of what actually happened that can be re-read afterwards.*

### 0.12.0 — Plan mode

*Status: built & tested (`cargo test --lib` 174 passing, `npm run build` green); not yet runtime-tested against a live model. The mode and the artifact are [plans.rs](../src-tauri/src/plans.rs), the two mode tools are [tools/plan_mode.rs](../src-tauri/src/tools/plan_mode.rs), the editable card is [PlanReview.tsx](../src/components/Chat/PlanReview.tsx), and the table is migration [033](../src-tauri/migrations/033_plan_mode.sql).*

*Surveyed first, and each of the four took one idea: Claude Code's phase-structured planning prompt and its rule that `ExitPlanMode` **is** the request for approval (so the model should not also ask in prose); PI's symmetric `EnterPlanMode()` / `ExitPlanMode()`, which is where the model getting to take *itself* into planning comes from; Codex's plan-as-ordered-steps with live progress; and — from [Armin Ronacher's reading of Claude Code's plan mode](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/) — the two criticisms worth designing against: that the tools are not actually restricted (it is prompt reinforcement over an unchanged toolset), and that the plan lands in a file the user cannot see or edit. Both are inverted here: the toolset is genuinely filtered, and the plan is a row the user rewrites.*

- [x] A per-chat mode where mutating tools are withheld and the model's job is to produce a plan — read-only tools stay available so the plan is grounded in the actual files. Enforced twice: the mutating definitions are dropped from the request (`apply_plan_mode`), and the executor refuses a withheld name if the model produces one anyway, with a result that says why and what to do instead. An allowlist rather than a deny-list, so a tool added later is unavailable while planning until someone thinks about it — the test asserts that from the deny side
- [x] The plan lands as a structured artifact, not prose: ordered steps, each with intent, the files it expects to touch, and its risk level. Sanitised on the way in from either end (a bare string is a step; an unknown risk falls back rather than failing the call), because the same normalisation should apply whether the model or the editor produced it
- [x] The user edits the plan — reorder, delete, rewrite, add a step — before approving it, and what they approve is what is written back to the row
- [x] Approving a plan hands it to the executing zone as the turn's task list, injected from the table on every request of the turn rather than from anything the model remembers. `update_plan` is redirected into the approved plan while one is in force: statuses are the model's to change, step text is not, and a call with a different number of steps is refused with the approved list attached
- [x] **The model can take itself in and out of the mode.** `enter_plan_mode` withholds its own mutating tools from the next step onward when a request turns out bigger than it sounded; `exit_plan_mode` files the plan and ends the turn, the way `ask_user` does. The asymmetry is the point — giving up your own permissions needs nobody's consent, handing them back to yourself needs the user's
- [x] Plan mode is a first-class chat state, not a tool a zone may or may not have enabled: a `plan_mode` column on the chat, applied to the toolset of every request. It composes with Quick / Smart / Zone / Multizone rather than replacing them — a plan is still planned *by* somebody. Originally also a toggle on the composer and a "Plan first" entry in the new-chat mode menu; both were removed in 0.12.1 in favour of asking (see below)
- [x] Six routes on the local API (`POST /api/chats/:id/plan-mode`, the two plan reads, approve / reject / steps), so a script or a model driving the app through `app_control` can see and answer a plan too
- [ ] Runtime-test the whole path: ask for something large, watch the mutating tools disappear, edit the plan, approve it, and confirm the executing turn is held to the edited steps

### 0.12.1 — Live task state

*Status: built & tested (`cargo test --lib` 174 passing, `npm run build` green); not yet runtime-tested. The panel is [TaskPanel.tsx](../src/components/Chat/TaskPanel.tsx); the stop request is one column, migration [034](../src-tauri/migrations/034_plan_control.sql).*

- [x] The plan renders as a live checklist above the composer, steps ticking off as the turn executes them, with the current step marked and the progress bar counting everything settled rather than only what succeeded. Reloaded when the transcript grows a tool result — the moment a status can have moved — rather than polled
- [x] Steps can fail without failing the run: `failed` is a status, the reason is kept on the step, and the task list tells the model what to do with one (carry on with what does not depend on it, or stop and report — but say which). A step reported failed with no reason gets one written for it, since a red mark with no explanation is exactly what makes a failure unreadable afterwards
- [x] Mid-run the user can strike a step or add one — the list is re-read on every request of the turn, so the model sees the change at its next step and is told not to reinstate something that was removed
- [x] **Stop after the current step.** Cancelling was the only control the app had over a run, and it is the wrong one for "not that step": everything in flight is lost to change one line. The request is recorded on the plan and honoured at the next step boundary by withholding the tools for one more step — the same mechanism the step budget uses to guarantee the turn ends in prose — so the work finishes and gets reported instead of vanishing
- [x] Plan state persists with the chat: it is a row, so a long task can be closed and re-opened, and the plan proposed yesterday is still the thing waiting for an answer today
- [x] Multizone leader gets the same surface: a sub-agent's plan is linked to the leader's when it is filed, and the panel renders them as one tree — the first place an orchestration run has had to hold a task where the user is actually sitting
- [x] **Asking is the way in.** The composer toggle and the new-chat "Plan first" entry are gone; `enter_plan_mode` is the only way into the mode from a chat. A button was the wrong shape for it — it asked the user to predict, before typing, whether what they were about to type was big enough to need a plan, which is exactly the judgement they came to the model for. Saying "plan this first" now does the same thing, and the model reaches for the tool unprompted when a request turns out larger than it sounded. What stays on the composer is an indicator, not a switch: a mode that silently withholds tools has to be visible while it is on. Leaving is still approving or rejecting the plan, and `POST /api/chats/:id/plan-mode` still sets the mode directly for a script or a model driving the app
- [ ] Runtime-test: run a plan of several steps, strike one mid-run, add one, and stop after a step
- [ ] Runtime-test: ask for a plan in prose with no button to press, and confirm the model enters plan mode via `enter_plan_mode`

### 0.12.2 — Replay & the event log

*Reasonix keeps a session event log and can replay a transcript; we kept everything in SQLite already and exposed none of it as a timeline.*

*Status: built & tested (`cargo test --lib` 174 passing, `npm run build` green); not yet runtime-tested. The log is [events.rs](../src-tauri/src/events.rs) over migration [035](../src-tauri/migrations/035_session_events.sql); the replay is [ReplayView.tsx](../src/components/Chat/ReplayView.tsx).*

- [x] Session event log: turn start and end, every tool call with its arguments, every approval declined, every failure, zone switches, file mutations, and every plan decision — one ordered, queryable record per chat. Append-only and deliberately denormalised: the human-readable line is written at the time it happens, so replaying a session months later does not depend on the zone, the file or the plan still existing
- [x] Recording can never fail a turn — every writer is best-effort and logs rather than propagates, because a log that breaks what it observes is worse than no log. Arguments are summarised, not copied: a whole file's contents is truncated with its length noted, so the log stays a record rather than a second database
- [x] Replay view — step or play through a past session, filter by kind, and read what each event carried, with the clock showing elapsed time from the first event (the axis that makes "it spent four minutes on that search" visible). Play runs at a fixed cadence rather than the original timings: a faithful replay of a nine-minute turn takes nine minutes, and stepping is what this is for
- [x] The log is exported with the chat — a Session log table in the Markdown and a closing section in the PDF, after the trace, because the trace is the run as it reads and the log is the run as it was recorded
- [x] `GET /api/chats/:id/events` serves the same record to a script or a model driving the app
- [ ] Runtime-test: run an agentic turn with an approval declined and a tool failure, then replay it

### 0.12.3 — The chat window

*The replay shipped in 0.12.2 could say a tool ran and not what it returned, which is the one question a replay is opened to answer. Around it, the header row had five glyph sizes and the window announced every launch with a flash of the wrong theme.*

*Status: built, typechecked (`npx tsc --noEmit` clean, `vite build` green) and checked in a browser harness; not yet runtime-tested in the Tauri shell — see section 11c of [TEST_CHECKLIST.md](TEST_CHECKLIST.md).*

- [x] Replay carries the transcript as well as the log ([ReplayView.tsx](../src/components/Chat/ReplayView.tsx)): the question asked, each zone's answer, thinking markers with durations, and every tool call's **arguments and output** with how long it took, interleaved with the log's own approvals and failures by timestamp. Built on `buildTrace` — the same reduction the PDF export uses — so the pairing of a call to its result is not implemented twice, and it costs nothing on disk because the conversation was already stored. Ties go to the log, since a `tool_call` row is written the instant the call is issued. Each row now shows elapsed *and* wall-clock time; prose renders as prose and JSON as JSON; a very long output is clamped with a note rather than turning the pane into a document viewer
- [x] One glyph size across the header row ([chrome.ts](../src/lib/chrome.ts)), imported by every control in it so the next one added cannot drift. The spend chip is a plain dollar sign at that size — the receipt glyph it replaces was the smallest thing in the header and unidentifiable. *Known reading: the figure beside it is billed tokens, not currency; the tooltip and popover say so*
- [x] The zone control shows the zone name and not the model id, which was making the widest control in the header the one carrying the least actionable text. The id stays on the tooltip and on every row of the menu
- [x] The project/tag bar is a header chip that opens it, not a permanent second row ([ChatPanel.tsx](../src/components/Chat/ChatPanel.tsx)). The chip carries what the bar used to spend a row displaying — the project with its colour, the tag count — and the sidebar already groups by project and filters by tag, so the strip is where you *change* those, not where you read them. Open/closed persists per install
- [x] Entrance animations between the landing view and a conversation ([styles.css](../src/styles.css)): the header drops in, the thread rises, the composer follows a beat later so the eye finishes where the user is about to type. All of it off under `prefers-reduced-motion`
- [x] Launch no longer flashes. The appearance is restored before the first paint from a snapshot of `<html>`'s own class and inline style, written on every appearance change ([index.html](../index.html), `saveBootSnapshot` in [store/app.ts](../src/store/app.ts)) — deliberately a replay of the last settled frame rather than a second implementation of the theme, so it cannot fall out of step. The webfont link goes out in the same breath
- [x] Appearance now follows the store unconditionally: a `useApp.subscribe` repaints on any change to `theme` / `appSettings` whatever route made it (a load, the HTTP API, an imported bundle), and `loadAppSettings` applies its defaults when nothing is stored. This is the fix for the interface font size appearing to need a visit to Settings → Appearance before it took effect — the mechanism was never identified by reading, so the sync was made declarative instead. **Needs the runtime check in 11c to confirm**
- [x] Boot splash ([BootSplash.tsx](../src/components/BootSplash.tsx)) — the window icon's "M" drawn in the user's accent over the background the window is already using, so it leaving reveals a finished window rather than cutting to a different one. Under a second, once per launch (not once per mount, which StrictMode would make a flicker), and any click, tap or keypress skips it
- [x] **Fixed in the same release:** the entrance animations filled `forwards`, and a filling animation on opacity or transform keeps its stacking context — which trapped every header dropdown inside the un-positioned header, where the `position: relative` message thread painted over it. Menus rendered under the transcript and could not be clicked. Fill mode is `backwards`: the last keyframe is the element's natural state, so nothing is gained by persisting it. Reproduced and fixed under Playwright (`elementFromPoint` over the open menu, and a click that timed out before and lands after)
- [x] The app's own typeface is fetched at launch, not when a settings tab happens to ask for it. Inter leads the default stack and no OS ships it, so the app ran on Segoe UI until Settings → Appearance loaded its preset previews — at which point every glyph in the app re-rendered on a panel where the user had changed nothing. `applyAppSettingsToDom` now requests the effective face (custom, or Inter), so it goes out behind the splash and is cached in the boot snapshot for next time
- [x] The landing view greets by the hour from a small pool per bucket instead of four fixed strings, and the onboarding line under it is gone — everything it pointed at is directly below it and labelled ([HomeScreen.tsx](../src/components/Chat/HomeScreen.tsx), `GREETINGS`)
- [x] Touch and stylus can actually move the window ([TitleBar.tsx](../src/components/TitleBar.tsx)). 0.11.3 fixed the *stuck* drag and left the drag inert, because `startDragging()` cannot work from a finger: on Windows it posts `WM_NCLBUTTONDOWN` into the OS move loop, and that loop follows mouse messages, which touch only produces after the contact lifts. The pointer is now captured and the window repositioned from the contact's own screen coordinates (client coordinates are useless — the window follows the finger), coalesced to one `setPosition` per frame, restoring a maximized window first. Double-tap-to-maximize and mouse behaviour are untouched
- [ ] Runtime-test: launch in light mode with a 22px interface size and a custom font, then replay a turn that ran tools

---

## 0.13.x — Tool visuals

*Every tool step that isn't a plan, a plot, a diagram or a saved file renders as escaped JSON in a `<pre>`. That is 47 of 52 tools, including the ones an agent run is mostly made of — edits, shell, sub-agents, the team board. Full design in [TOOL_VISUALS.md](TOOL_VISUALS.md); the short version is 14 visual families, a Visual/Input/Output tab strip so the raw call is one click away rather than the only thing on offer, and a shaped fallback so MCP tools never drop to raw JSON either.*

### 0.13.0 — The dispatch, the tabs, and the fallback

*Status: built, `npx tsc --noEmit` clean and `npm run build` green; not yet exercised in the Tauri shell — runtime checks listed in section 11d of [TEST_CHECKLIST.md](TEST_CHECKLIST.md).*

- [x] Family lookup ([visuals/families.ts](../src/components/Message/visuals/families.ts)) rather than an if-chain: every built-in tool is mapped to one of 14 families, a new tool joins by adding a line, and an unmapped tool — every MCP tool, by definition — gets the shaped fallback. The map is exhaustive even where the family isn't implemented yet, so the intended grouping is written down rather than rediscovered
- [x] Visual / Input / Output tabs on every tool step (`ToolTabs` in [StepBlock.tsx](../src/components/Message/StepBlock.tsx)). Visual leads where one exists; the card opens on Input when the result is an error, because that is the tab the answer is usually on
- [x] Shaped fallback ([Shaped.tsx](../src/components/Message/visuals/Shaped.tsx)): an array of uniform objects becomes a table, an object a key/value list with nested values folded below the first level, a long or multi-line string becomes text. A string that is itself JSON is shaped too — several tools return a document in a string field, and showing it escaped is the exact problem this solves
- [x] Family 1 wired to the existing `DiffView` in read-only mode ([EditVisual.tsx](../src/components/Message/visuals/EditVisual.tsx)). The diff is built from the call's own arguments, not from disk: what this step did, not what the file looks like after four more edits. Common leading and trailing lines stay context, so one changed line inside a ten-line anchor reads as one changed line. Reports a whitespace-tolerant match or a multi-occurrence replace when 0.14.0's resolver says so
- [x] Family 5 (terminal) brought forward from 0.13.1 — it was the same shape as family 1 and is most of what an agent run does: command line, stdout, stderr tinted, exit-code pill, tail-anchored at 200 lines, ANSI escapes stripped rather than printed
- [x] Family 14 stays where it renders (above the tabs) and is marked `existing` in the map, so the tab strip doesn't show a second copy
- [x] One height cap (320px, own scroll) across the tabs and every family
- [x] Streaming-safe: the pending-arguments pane is unchanged, the tab strip only appears once there is a result
- [x] **Runtime-tested:** an MCP tool result renders shaped rather than raw ✅
- [x] **Runtime-tested:** a long `run_command` output tail-anchors and stays inside its own scroll ✅

### 0.13.1 — The tools a run is made of

*Status: built, `npx tsc --noEmit` clean and `npm run build` green. The two runtime checks carried over from 0.13.0 both passed.*

- [x] Family 5 (terminal) — landed in 0.13.0
- [x] Family 2 (file card) ([FileVisual.tsx](../src/components/Message/visuals/FileVisual.tsx)): `read_file`, `create_folder`, `move_file`, `copy_file`, `delete_file` — path (clickable, reveals in the file manager), size, line count, extension, and the first 15 lines as text rather than as an escaped JSON string. `from → to` on one line for move and copy; a delete shows the path struck through
- [x] Family 3 (tree) ([TreeVisual.tsx](../src/components/Message/visuals/TreeVisual.tsx)): `list_directory` renders the nested object it returns as an indented tree with folder and file counts, and the backend's `…` depth marker reads as an ellipsis rather than a file; `find_files` groups its flat list by folder. Truncation is always stated — a listing that silently stopped at the limit is how someone concludes a file isn't there
- [x] Family 4 (match list) ([MatchVisual.tsx](../src/components/Message/visuals/MatchVisual.tsx)): `search_file_text` hits grouped by file with per-file counts and the term highlighted (matched literally, not compiled — the query is a regex by default and a highlight that throws would take the card down with it); `search_local_files` passages carry their similarity score and source document
- [x] The dispatch moved out of `StepBlock` into [ToolVisual.tsx](../src/components/Message/visuals/ToolVisual.tsx), shared with replay
- [x] **Replay shows the same visuals** ([ReplayView.tsx](../src/components/Chat/ReplayView.tsx)). Replay is opened precisely when something went wrong, so a worse view of a call there than in the transcript was the wrong way round. The raw output stays below the visual under its own label; a tool returning prose rather than JSON is unchanged
- [x] PDF reads show which pages were extracted — `read_file` already reported `page_count` and `pages_read`, and a PDF read is a *selection*, so which pages came back is the first thing you need to know about it
- [x] Family components have no tests — there is still no frontend test runner (see [TEST_STRATEGY.md](TEST_STRATEGY.md))

### 0.13.2 — Making a Multizone run legible

*Status: built, `npx tsc --noEmit` clean and `npm run build` green; not yet exercised in the Tauri shell.*

- [x] Family 9 (agent card) ([AgentVisual.tsx](../src/components/Message/visuals/AgentVisual.tsx)): zone name, the task as prose, a status pill (running / done / failed / no reply), turn count, and **Transcript** expandable from the step that spawned it — `SubchatTranscript` is now exported from [StackTrace.tsx](../src/components/Message/StackTrace.tsx) and reused rather than reimplemented, so both places show the same leader↔sub-agent exchange. `collect_subagents` renders one card per agent with its reply folded; a background agent still working says so and names `collect_subagents` as the way to pick it up
- [x] Family 10 (team board) ([BoardVisual.tsx](../src/components/Message/visuals/BoardVisual.tsx)): claims as file chips with the stated intent, releases struck through, notes tinted by kind (decision / blocked / done), and `team_status` as the board itself — agents, claims and notes in one card. Agents are tinted by a hash of their name so the same agent is the same colour across claims and notes, which is what makes a board readable at a glance rather than line by line
- [x] Error looks, where the backend gives them structure: a write refused because another agent holds the file (`error_kind: "claimed"`) renders as a board card naming the holder, their intent and how long they have had it. This is the moment the teamwork layer exists for and it was arriving as a red string
- [x] The other error looks named in [TOOL_VISUALS.md](TOOL_VISUALS.md) — a non-zero exit as a pill, a 404 as a status pill — land with families 8 and the terminal error paths in 0.13.3. A generic error is deliberately left as its own text on the Output tab: a card repeating the same string adds nothing

### 0.13.3 — The rest, and export

*Status: built, `npx tsc --noEmit` clean and `npm run build` green.*

- [x] **Fixed first — the visuals only rendered in replay.** The activity rail sets `hideVisual` on every step, and the tab strip was treating that as "this card already shows a visual", so every family card was suppressed in the rail — which is the whole chat. Replay bypasses the rail, which is why it alone worked. `hideVisual` refers only to the *lifted* visuals (plans, diagrams, plots, saved files), and `ToolVisual` returns nothing for that family anyway, so the flag has no business in the condition
- [x] Visual is unambiguously the landing tab wherever one exists — expanding a step is a request to see what the tool did, not to read its arguments back
- [x] Families 6 and 7 ([WebVisual.tsx](../src/components/Message/visuals/WebVisual.tsx)): `smart_search` ranked results with domains, and the **engine strip** — which engines contributed and which failed, information the tool has always returned and nobody could see, so a result merged from six engines looked identical to one from the single engine that happened to answer. `smart_fetch` / `smart_crawl` as page cards with word counts, per-page errors, and the crawl's shape (pages read, errored, truncated)
- [x] Family 8 ([HttpVisual.tsx](../src/components/Message/visuals/HttpVisual.tsx)): method, URL, a status pill (2xx green, 4xx/5xx red, 3xx amber — a redirect that wasn't followed is a fact, not a failure), response headers folded away, and the body shaped rather than escaped. `app_control` shares the family, since it speaks the same shape against the app's own API
- [x] Families 11, 12, 13 ([StateVisual.tsx](../src/components/Message/visuals/StateVisual.tsx)): memory with scope chips and the trim notice, skills with description and file chips, and the state changes as single lines. `get_current_datetime` renders with **no card at all** — a bordered panel around "it is Tuesday" makes the transcript worse
- [x] Export fidelity ([export.ts](../src/lib/export.ts)): file writes export as a real `+/−` diff and shell tools as command / output / exit code, both tail-anchored like the screen. Sub-agents already nest their transcripts under the spawning turn, so an agent card there would have duplicated what the export does better
- [x] Family icons on step cards ([familyIcon.tsx](../src/components/Message/visuals/familyIcon.tsx)) — a run of twenty steps was a column of identical wrenches, and the strip is usually read collapsed
- [x] **Runtime-test:** a search step shows the engine strip, and a blocked engine shows as failed
- [x] **Runtime-test:** a PDF export of a turn that edited a file and ran a command carries the diff and the console

### 0.13.4 — Image-only chats get titles

**Image-only chats were left unnamed** — a blank row beside a blank icon, or "New Chat" forever. Three separate causes, all of them a path reaching for text that a wordless message does not have:

- [x] With auto-title **off**, the frontend derived the title from the message's text parts and renamed the chat to the **empty string** ([store/app.ts](../src/store/app.ts)). It now names the attachment ("Image", "3 Images"), and never renames to nothing — keeping "New Chat" is worse than a good title and better than a blank row
- [x] With auto-title **on**, a model reply that failed `clean_title_candidate` fell back to the first message's text, which was empty, so `fallback_title` returned "New Chat". It now counts the images in the stored content and names them
- [x] The instruction asked for "a title for the message above… a noun phrase naming the topic". Asked that of a wordless turn, models name the *medium* — "Image Attachment", "Uploaded Screenshot" — which is a noun phrase, and useless as a row in a list where every such chat gets the same one. A wordless image now gets its own instruction: name what the image shows, not that it is an image
- [x] The image itself was already being sent (`build_title_context` has handled vision since it was written, with a `[image attachment]` stand-in for models that cannot see) — so this was never a missing capability, only three fallbacks that assumed text
- [x] 5 tests covering the counting, the fallback titles, and which instruction each shape of message gets. `cargo test --lib`: 197 passed
- [ ] **Runtime-test:** send an image with no text to a vision model — the title names what is in the picture, not "Image Attachment"

### 0.13.4 — The session log becomes opt-in

- [x] `pdfExportSessionLog` (default **off**) beside the other Chat export settings in Settings → Appearance. The log is the run as *recorded* — every turn started and finished, every tool run, the approvals declined — which is evidence rather than reading, and on a long run it is a table of hundreds of rows appended to a document usually exported for its conversation
- [x] PDF only. The Markdown export keeps its log unconditionally: a markdown file is far more often the machine-readable copy, and the reason to suppress the log — page after page of table in a document someone will read — does not apply to it
- [ ] **Runtime-test:** off by default on an existing install, and the toggle changes the exported document

---

## 0.14.x — The agent floor

*A comparison pass against ~20 open-source agents and clients ([BORROWABLES.md](BORROWABLES.md)) found the gaps clustered in one place. Orchestration, review, checkpointing and coordination are ahead of most of the field — teamwork locks have no equivalent in anything surveyed. What is behind is the layer underneath: the edit primitive, the retry path, the retrieval, the guardrails on a runaway turn. A panel of seven agents amplifies whatever is under it, including a bad edit primitive.*

*0.14.0 clears the ground before that work rather than being part of it: the checks moved onto the machine that writes the code, and the MCP servers a zone was configured with now connect at launch instead of at first use.*

### An edit that is hard to get wrong — landed early, in 0.13.0

*This was the planned 0.14.0. Its first three items shipped ahead of schedule with 0.13.0, because 0.13.0's diff visual is only honest if the edit it draws is the edit that happened, so it is recorded here as done rather than held open for a version number. Covered by 15 tests; `cargo test --lib` 192 passed. The one item still open moved to 0.14.1.*

- [x] `edit_file` counts occurrences before writing and refuses with the count when it is not 1, or takes them all when `replace_all` is set. `replacen(.., 1)` used to take the first hit silently — a wrong edit that reports success, the worst failure mode a file tool has. An empty `old_text` (which passed `contains` and inserted at offset zero) and an edit that changes nothing are refused too
- [x] On no exact match, retry line-wise ignoring indentation and trailing whitespace, and re-indent the replacement onto the indentation the file actually uses — otherwise an anchor quoted without its leading spaces silently de-indents the block it edits. Refused again, with the count, if the tolerant match is itself ambiguous
- [x] Resolution lives in one function ([`resolve_edit`](../src-tauri/src/tools/filesystem.rs)) which `review::proposal` also calls, so the diff a user approves is the diff that lands rather than two implementations of the same rule
- [x] Syntax check after the write, auto-revert with the reason. Reported only as a *regression* — parsed before, doesn't after — so a checker that misreads a construct misreads it in both versions and cancels its own blind spot out; an already-broken file isn't blamed on this edit and the edit that repairs one is let through. JSON is really parsed; C-like files get a bracket scan that understands strings and comments, and skips single quotes in Rust where a lifetime and a char literal need a real lexer to tell apart
- [x] This is the cheap 80% of the backlog's "file editing as an engine" and did not wait on the code interface
- → Windowed `read_file` moved to 0.14.1

### 0.14.0 — Checks come home, and servers that start themselves

*Housekeeping the agent floor is built on: the checks now run where the code is written, and the tools a zone was configured with are actually connected when the first message is sent.*

- [x] **The CI job moved onto the development machine.** `npm run build`, `npm test` and `cargo test --lib` ran on every push and PR; the Rust job alone is ~13 minutes of rustc on a hosted Windows runner, against ~40 seconds on a warm local target directory. Now two hooks in [.githooks/](../.githooks/) — `npm run check` (typecheck + script tests, ~15s) on commit, `npm run check:all` (+ build + `cargo test --lib`, ~75s) on push, which in this repo is also the publish. [ci.yml](../.github/workflows/ci.yml) keeps both jobs on `workflow_dispatch` as a clean-checkout second opinion; the automatic triggers are commented out, not deleted. The trade is named in [TEST_STRATEGY.md](TEST_STRATEGY.md) — a hook cannot catch the class of failure that made both CI jobs fail on v0.13.3, where this working tree differed from the runner in exactly the way that mattered
- [x] **Every enabled MCP server connects at launch.** A server sat at "Disconnected" until someone pressed Connect or a tool call happened to need it — `Manager::call` connects lazily, so the capability was never missing, but the first tool call of a session paid npx startup inside the turn, and a server that had been broken since the last launch announced itself as a failed step mid-run rather than a red row in Settings. `start_enabled` reads the enabled servers and returns; each connection is its own task, so nothing sits in front of the first window paint and one hanging server does not hold up the others. The per-server switch is the opt-out, so there is no new setting
- [x] Tool reconciliation moved into a shared `sync_tools`, so an autostarted server ends up with exactly the rows a hand-connected one does. 4 tests, the load-bearing one being that a resync keeps the user's danger level — this now runs on every launch, so getting it wrong would silently reset every level on the first restart
- [x] **Mobile re-scoped as a remote for the desktop**, not a second app — the backlog's one line left the only interesting question, *what runs the message*, unanswered. Same chats and zones on the phone; the desktop runs the turn. Design in [CONNECTIVITY.md](CONNECTIVITY.md#part-3--the-phone-as-a-second-window), sized in the [backlog](#backlog--unscheduled)
- [ ] **Runtime-test:** launch with two servers configured and one deliberately broken — the good one shows connected before the first message, the broken one shows its error in Settings rather than during a run

### 0.14.1 — Guardrails on a runaway turn

- [x] Windowed `read_file` ([filesystem.rs](../src-tauri/src/tools/filesystem.rs)) — `offset`/`limit` over lines, default 1200, and the file's real line count reported every time. Moved from the edit-primitive work above; it is the same problem as the guardrails, one step earlier — a 40,000-line log read whole is a turn that runs out of context rather than one that loops. Where something was left out the result names the exact next call ("showing lines 1–1200 of 3000, continue with offset 1201"): "truncated" alone produces either a model that answers from a fragment as though it were the file, or one that re-reads the same window forever. Lines over 2000 characters are clipped *by character* — a byte cut lands mid-codepoint and hands back an anchor that cannot match. A file that fits gains no new fields, so nothing changes for the ordinary case. 9 tests
- [x] Loop detection ([runaway.rs](../src-tauri/src/llm/runaway.rs)): hashes `(tool, arguments, result)` per call over a window of 12. Four identical triples, three consecutive identical errors, or an A/B/A/B alternation stops the turn. The whole triple is what counts — same arguments with changing results is a poll or a build, and two tools that both return `{}` is a coincidence
- [x] A fourth shape the plan did not name, found while writing it: **a leader re-briefing one sub-agent all turn**. Every message differs and every answer differs, so no triple repeats and nothing alternates — invisible to all three rules above while the turn spends its whole budget passing one task back and forth. Seven delegations to the same target stops it; reading and collecting are not counted, since those are how a leader *uses* what came back
- [x] Stopped, not aborted: one more step with the tools withheld and a note stating the evidence rather than the verdict ("you called X four times and got the same result" leaves reporting as the only move; "you are looping" invites one more attempt with a preamble). A hard abort saves one request and leaves the user a dead run with no sentence — and a sub-agent's parent with nothing at all, since what the parent reads is its last message
- [x] Surfaced in the stack tracer (a mark on the sub-agent's node, since a run that went in circles still returns a confident-sounding paragraph), as an amber card in the thread, and as a `runaway` session event. For a sub-agent it is **also recorded on the parent chat** — a background one is exactly the case nobody is watching
- [x] Backoff and cooldown in [client.rs](../src-tauri/src/llm/client.rs): up to 3 retries on 429/5xx/transport with **full-jitter** exponential backoff (500ms doubling, capped at 8s), honouring `Retry-After` up to 20s. Full jitter rather than "exponential ± a bit" because seven members that all wait 1s arrive together and trigger the same limit again. Three transient failures in a minute put the provider on ice for 30 seconds, with a message that says it is the app backing off rather than the provider refusing. A 401 or a 404 never counts toward that — a zone naming a model that does not exist must not take the other zones down with it. There was no 429 path at all before this
- [x] Optional fallback zone per zone (migration 036, picker in the zone editor's Advanced section), so a leader loses a provider rather than a panel member. Once per turn, and never itself: a chain would hide which provider actually died
- [x] Explicit caps beside the turn budget: **session spend** (`maxSessionTokens`, counted over the chat *and* every sub-agent under it, because the panel is what spends) and the **handoff cap** above. Delegation depth already existed as `subchatDepthLimit`. The spend cap ships **off by default** — against a model on your own machine a long session costs time rather than money, and a default that stopped legitimate local runs would be the wrong trade for the people this app is built for. Loop detection, on for everyone, is what catches the runaway shape
- [x] Four copies of `ZONE_COLS` folded into one beside the struct, found while adding the fallback column. They had drifted: the API's had been missing `is_leader` since that field was added, so `GET /api/zones` failed to map a row and answered with an error nobody had seen — `query_as` needs every field, so a stale copy compiles fine and fails at runtime, in whichever path nobody is watching
- [ ] **Runtime-test:** a model told to read the same file until it succeeds is stopped and explains itself; a background sub-agent doing it marks its node in the tracer
- [ ] **Runtime-test:** a zone pointed at a dead provider with a fallback configured answers from the fallback, and the transcript says which zone answered

### 0.14.2 — Approval that isn't all-or-nothing

- [x] Per-category auto-approval ([approvals.rs](../src-tauri/src/approvals.rs)) beside the single global setting whose top notch is *Everything* — which the README told people to select before any long run, because a sub-agent cannot show a prompt. Seven categories rather than the five scoped: **read, edit, shell, web, MCP, sub-agents, app state**. Web earned its own because "search the web but do not touch my files" is a real policy, and app state because `app_control` rewriting the user's app belongs nowhere else. The axis is deliberately not the danger level: `delete_file` and `run_command` are both danger 2, and letting an agent edit a repo is not agreeing to let it run anything
- [x] Each category is auto / ask / **inherit**, and the third is a real state rather than a default — an install that never opens the panel falls back to the old slider and behaves exactly as it did. An unrecognised tool is categorised as app state, not read: a tool this build does not know about is the last thing to wave through
- [x] Shell allow-prefix and deny-prefix lists, longest match wins, so "allow `git`, deny `git push`" resolves correctly. Prefixes match on **whole words** — otherwise allowing `git` quietly allows `gitleaks`. A tie goes to deny, since two equal-length rules disagreeing is a configuration mistake and the safe reading of a mistake is the strict one. A denied command is **refused**, not prompted: writing the rule down was the answer, and asking again would be asking a question the user already answered
- [x] Per-zone overrides (migration 037, in the zone editor's Advanced section): a scout that only reads, an implementer that may edit, and neither holding unreviewed shell. Merged per key, so a zone that says something about shell does not discard the user's global decision about reads — and a zone's prefix lists are *added to* the global ones rather than replacing them, because a deny list that can be dropped by configuring something else is not a deny list
- [x] The README's "set auto-approval to *Everything* before a long run" advice is replaced with the thing that is now possible: auto for read/web/sub-agents, ask for shell, and an allow list for the commands you are happy to see run
- [x] **Runtime-test:** a zone with shell on *Ask* and `npm run test` allowed runs the tests without prompting and still asks about `rm`
- [ ] *Deferred to 0.14.3, with the project-root work:* "edit inside the project root" as a **path** constraint. The category answers whether editing is auto-approved, not where — and a path policy wants the same treatment as the shell lists rather than a boolean bolted onto a category

### 0.14.3 — A limit that stops, and a prompt worth reading

*Fixing what 0.14.1 and 0.14.2 shipped, after the first real run with them on. Every item here comes from watching the thing work rather than from the plan.*

- [x] **The spend limit is a hard stop.** 0.14.1's version withheld tools and let the turn keep answering, and the next turn started as though nothing had happened — so a session set to 0.1M sailed past it and carried on. Now the check ends the run: no further request, in this chat or any other in the session. The wrap-up step it used to take was the bug in miniature — another paid request, and the largest kind, since a wrap-up re-sends the whole context. A limit that spends past itself to apologise for spending is not a limit
- [x] **And it asks.** Reaching the limit raises a prompt in the thread with the numbers and three answers — a specific higher limit computed from what was actually spent (being offered 110k when you are already 26% past 100k is not an offer), a much higher one, or none. Choosing one raises the limit *and continues the stopped run*, because a limit you have to raise and then re-ask is one people switch off permanently. Leaving it alone is also an answer, and the card says so
- [x] **The limit is visible before it bites** ([ContextMeter.tsx](../src/components/Chat/ContextMeter.tsx)): `126.4k/100k` on the header chip, amber at 80% and red at 100%, and a filled bar in the popover — the one bar there, because it is the one number with an end. Labelled *spend, not context*, which is the confusion the whole meter invites: context is how big the next request is, spend is what the session has been billed, and only one of them can stop a run
- [x] **The approval prompt shows the call** ([IntentVisual.tsx](../src/components/Message/visuals/IntentVisual.tsx)). It said "the model wants to run run command" and hid *which command* behind a link that unfolded raw JSON. Approving a shell call without reading the command is not approval, it is assent, and the prompt was asking for assent. Now it draws the call the way the step card draws a finished one — same families — with the raw arguments still one click down
- [x] **A rule can be written from the prompt**, which is where the question is being asked: *Always allow* / *Never allow* with a chosen prefix (`npm run build` → `npm run build`, `npm run`, `npm`), shown in full, saved to the same global lists Settings edits. Walking to Settings to write a rule about a call you are being asked about, while the turn sits blocked, is a trip nobody makes
- [x] **Notifications when a run is waiting on a person** ([notify.ts](../src/lib/notify.ts), `tauri-plugin-notification`): a tool approval or an `ask_user`, and only those two — both block indefinitely, and the approval times out after five minutes and leaves the agent stalled with no visible cause. Only when the window is in the background, since a toast for what is already on screen is noise. Taskbar attention always; an OS notification when unfocused. A finished turn deliberately never notifies — that is how people learn to dismiss toasts unread, including the two that matter
- [x] **tok/s means the provider's speed again.** The live figure is now a rolling five-second window, so it follows a provider that changes speed instead of a whole-turn average that drifts. The final figure excludes time spent waiting for an approval as well as tool time: a turn where someone took two minutes to press Approve reported 1.0 tok/s from a provider running at fifty — a number about the person, not the model. The stats card names both waits (`…of which tools ran`, `…of which awaited approval`) so the gap between total and generating time is never a mystery
- [x] `StreamPayload` was serialising `message_id` and `zone_id` while every reader in the frontend used `messageId` and `zoneName` — `rename_all` renames variants, not fields. Both reads were silently `undefined`: the routing chip named no zone. Fixed with `rename_all_fields`, which is what the TS types already described
- [x] **Runtime-test:** a session set below what it has already spent stops on the next message, offers a raise, and continues when one is taken
- [x] **Runtime-test:** an approval arriving while the window is in the background raises a notification, and the taskbar entry clears once answered

### 0.14.4 — Whose limit, and what the clock was measuring

*Two corrections from the next run, both of the same kind: a number that was right about something other than what it claimed to describe.*

- [x] **The spend limit is per session, not global.** Raising it from the card in one chat raised it for every chat — the opposite of what lifting a ceiling to let *this* piece of work finish is supposed to mean. Chats gain their own `spend_limit` (migration 038), resolved against the **session root** so a chat and its sub-agents share one ceiling: a sub-agent with a limit of its own would be a limit inside a limit, and whichever was smaller would silently win. The Settings value stays, now as the default for chats that have not chosen. `NULL` inherits and `0` means unmetered, which is why the column is nullable rather than zero-defaulted — "no limit" is an answer, not the absence of one. Reachable over the API as well (`POST /api/chats/:id/spend-limit`), which the drift test insisted on
- [x] **tok/s no longer counts prefill.** After every tool result the model re-encodes a context that has just grown, and on a long agentic turn that is most of the wall clock — counted, until now, as generation time. It is tracked per step and excluded, and the first step's encode is deliberately *not* counted twice: that one is the time-to-first-token, and the turn's clock only starts at the first token
- [x] The status line names it — **"Reading the conversation…"** rather than "Generating…", because the difference between "the model is slow" and "the context is large" is the whole diagnosis — and the stats card carries `…of which read the context` beside the tool and approval rows
- [x] **Runtime-test:** two chats, one with a raised limit, and the other still stops at the default
- [x] **Runtime-test:** a ten-step turn against a local model reports a tok/s close to what the provider's own logs show

### 0.14.5 — What the agent knows before it starts

*Everything here is context the agent should have had before its first step, and until now had to earn one tool call at a time. Two of the five deviate from the plan as written; both deviations are recorded on the item rather than quietly absorbed.*

- [x] **Edit constrained to a path, not just to a category** ([approvals.rs](../src-tauri/src/approvals.rs)) — carried over from 0.14.2. Allow and deny lists over the paths an edit would touch, the same shape as the shell lists, with **one deliberate difference: an allow list here is a boundary, not a shortcut.** A command matching no shell rule falls through to the category; an edit outside every allowed path is *asked about even where the category says auto*, because being asked about exactly those is the reason to draw one. `{project}` stands for the chat's own directory, so the rule almost everyone wants is written once rather than per project. Paths are canonicalized before comparison — symlinks followed, `..` resolved, case folded on Windows and only on Windows — and matched a whole segment at a time, so `/srv/app` does not cover `/srv/app-backup`. Both ends of a `move_file` are checked, since moving a file out is as much an escape as writing outside. A rule that cannot be anchored (a `{project}` with no project) is **dropped rather than widened**: dropping an allow rule costs a prompt, keeping it could cost a repository. Writable from the approval prompt too, offering the folder chain narrowest-first — the pre-selected default has to be the rule someone would have written anyway, not the largest one on offer. 17 tests
- [x] **The project's own `AGENTS.md` / `CLAUDE.md`** ([instructions.rs](../src-tauri/src/instructions.rs)), read from the working directory up to the repository root and put in front of every zone that has tools. Our project memory is good and entirely private to us; most repos an agent meets already carry one of these, and we walked straight past it. The walk **stops at the `.git`** — climbing further is how a stray `CLAUDE.md` in a home directory ends up in the prompt of every project underneath it, which is a surprise that is very hard to notice from inside a chat. Outermost first, so the nearest file is the last thing read; both names, collapsed when identical, since `CLAUDE.md` is very often a symlink to `AGENTS.md`. Cut at 20k characters with a note naming what was left out, because this is re-sent on every step of every turn. The preamble is explicit about precedence — above the model's own habits, below what the user asks for now — since these are instructions from a third party
- [x] **Path-triggered rules**: a directory deeper in the tree carrying its own `AGENTS.md` (`src/generated/` saying "never edit these by hand" is the common one) is injected the first time a file under it is read, edited or created. Once per directory per turn, including the directories that turn out to hold nothing, so a model working through twenty files in one folder pays for the lookup once. Anything at or above the working directory is left alone — it is already in the system prompt, and a mid-turn repeat would imply that copy matters more. A sweep (`find_files`, `search_file_text`) does not count as deciding to work somewhere, or one glob would fire every rule in the repository. Surfaced in Replay, so an unexplained change of behaviour has a visible cause
- [x] **Repo map** ([repomap.rs](../src-tauri/src/repomap.rs)): every source file's definitions, ranked by a PageRank over the reference graph, rendered into a token budget (1,000 by default, `0` off) and injected at session start. Ranking is the whole idea — an alphabetical dump of 4,000 symbols costs the context budget and buries the ten names that matter, and being referenced by something that is itself referenced is the only thing that distinguishes a map from a word count. Cached per directory against a hash of the walk's own output, so an unchanged tree costs milliseconds; **held for ten minutes past a change**, because an agent editing files would otherwise move the system prompt every turn and throw away the provider's prefix cache for the whole conversation behind it. 13 tests
  - **Deviation, stated rather than absorbed:** extraction is per-language line patterns, not tree-sitter. A C grammar per language is tens of megabytes of generated code on every clean build, in a repo that moved its CI onto this machine specifically to keep the edit loop short — and `tree-sitter-typescript` alone would undo that. What line patterns lose is a definition written in an unusual shape, and the cost of losing one is that a symbol ranks lower than it deserves; nothing downstream treats the map as exhaustive, and it says so in the map itself. `definitions` is one function and one enum, so swapping a parser in behind it stays a contained change if the accuracy ever proves insufficient
- [x] **Per-project lint and test commands** ([checks.rs](../src-tauri/src/checks.rs), migration 040) run once a turn's edits have landed, output handed back to the model. An agent that has just edited four files reports success in prose, which is the thing it is best at and therefore the thing that tells you least — and a compete-mode leader picking between two diffs was picking between two write-ups. Lint before tests, since a type error explains a test failure and is cheaper to read than the same failure as fifty lines of stack. Once per turn: a suite re-run after every repair attempt is how thirty seconds of tests becomes the whole step budget. Output truncated from the *front*, because a compiler prints its errors last. A command that never ran has **not** passed — "we could not tell" must never read as "it is fine" — and the model is told it may disown a failure that was already there, or this becomes a repair loop over someone else's bug. Nothing is inferred: guessing `npm test` in a repository whose dependencies were never installed fails confidently about the wrong thing
  - **Deviation:** the plan said the output is "fed back as the next turn's input". It is fed back within the *same* turn, as one further step, so the turn ends on what the checks said. A failing test the model learns about next turn is a failing test the user has already been told was a success
- [x] Three inline copies of the project column list folded into `PROJECT_COLS`, found while adding the two new columns — the same drift that made `GET /api/zones` fail at runtime in 0.14.1, where `query_as` needs every field and a stale copy compiles fine
- [ ] **Runtime-test:** a zone with `{project}` in its edit-allow list writes inside the project without prompting, is asked before writing to the desktop, and is refused outright inside `.git`
- [ ] **Runtime-test:** a repository carrying an `AGENTS.md` has it in the context meter's breakdown before the first message, and a rule in `src/generated/AGENTS.md` arrives only once the model reads a file there
- [ ] **Runtime-test:** a project with `npm run typecheck` configured, given a task that breaks the build, sees the error and fixes it before answering — and the same turn reports a pass when it does not

### 0.14.6 — Plans worth reading, and a card that stays in its half of the window

*0.12.0 shipped the plan as an artifact and then spent three releases proving what a thin artifact it was. Asked to plan a technical report, the model filed eight lines — "Source selection strategy", "Formatting and typography spec" — and the user approved a table of contents. Asked the same question in ordinary prose it produces the section-by-section word budget, the font stack at 11pt on 1.15 leading, the 65–75 character measure, and the reason LaTeX beats a Word export. The tool was the thing making it worse.*

*Status: built & tested (`cargo test --lib` 314 passing, `npm run typecheck` clean, `npm test` green); not yet runtime-tested against a live model. The step gains `detail`/`acceptance` and the plan gains `context`/`doc_path` in [plans.rs](../src-tauri/src/plans.rs) over migration [041](../src-tauri/migrations/041_plan_depth.sql); the drafting and reading tools are [tools/plan_mode.rs](../src-tauri/src/tools/plan_mode.rs); the card is [PlanReview.tsx](../src/components/Chat/PlanReview.tsx).*

- [x] **A step carries a specification, not a label.** `detail` is Markdown of any length the step deserves — the approach and the alternatives rejected with the reason, the concrete parameters (numbers, formats, thresholds, versions), what specifically goes wrong here — plus `acceptance`, which is how anyone tells the step is genuinely finished rather than nominally done. `context` on the plan holds what is not a step at all: the scope decision and the ones turned down, the assumptions, what the research found, what is still open. Clamped rather than refused at 6 000 / 12 000 characters, because a model that wrote 8 000 has done the thinking and failing the call over the last 2 000 costs more than the truncation
- [x] **`draft_plan_step` — one step per call.** The one-shot shape is what produced the headings: asked for eight steps in a single call, a model spreads its attention over all eight, and there is no moment in that call when it is thinking about step 5 and nothing else. Now there is one per step. The draft is a `drafting` row the user never sees, so a weak step is rewritten with `replace_index` before anyone reads it, and `exit_plan_mode` with no arguments files whatever was drafted. Passing the whole plan to `exit_plan_mode` still works — a model revising after a rejection should not need a second round trip
- [x] **The plan is a file.** `<app data>/plans/<slug>--<id>.md`, rewritten on every drafted step, on the user's edits, on approval, and as the run ticks steps off — so the document is always the plan that was *agreed to* rather than the one that was proposed. Deliberately in the app data directory and not the user's project: writing a plan should never touch a working tree
- [x] `read_plan` reads it back — the whole plan, or one step. Not `read_file`, because the plan documents live outside every zone's allowed roots and should stay there. Offered outside plan mode as well, but only to a chat that has actually planned: by step 6 of a long run, step 6's specification has been compacted out of context, which is exactly when it is needed. `update_plan` also hands back the current step's `detail` and `acceptance` unasked, so the common case costs no extra call
- [x] **The searching is the planning.** The preamble is rewritten around five phases — ask with `ask_user` *before* researching, research hard, draft a step at a time, re-read for the step you missed, file — and says outright that the search tools are all available and there is no budget to conserve. A planning turn also gets double the step budget (floor 24): its whole output is reading, none of it can change anything, and a plan filed because the loop ran out mid-research is precisely the thin plan this release exists to stop
- [x] **A planning turn's last step keeps the tools that end it.** The final step of any turn runs with tools withheld, which guarantees prose — and for a planning turn prose is the one outcome the mode exists to prevent, since a plan in the transcript is a plan the user cannot edit or approve. `exit_plan_mode` and `draft_plan_step` survive that step; everything else still goes
- [x] **The approval card no longer takes the window.** It replaced the composer, so the only way to disagree was the "Keep planning" button — a rejection with no reason attached, leaving the model's next attempt a guess, while the obvious answer (typing what is wrong) was the one thing the layout forbade. It now sits above a live composer. Tool approvals and `ask_user` still take the row: those are questions with a fixed set of answers and nothing to type
- [x] **Fixed in the same release: the plan surface broke scrolling.** Both the card and the task panel were flex items with `min-height: auto` and visible overflow, so a long plan grew without limit, pushed the transcript up out of the column and put a second, detached scrollbar on the window. Worse, neither region was a scroll container and the thread's is in a sibling subtree — so the wheel had nothing to scroll anywhere over them and did nothing at all. Both are bounded now (46vh and 32vh) and scroll inside themselves, with `shrink-0` on the rows so the flexbox cannot re-decide it
- [x] **The card is paged.** A step is now several paragraphs and often a table; eight of those stacked vertically is a page nobody reads. One step at a time, with a numbered rail above it for jumping and reordering that marks the risky ones, a Context page when the plan has one, and a list view for the whole thing at a glance. The specification renders as Markdown in its own bounded scroller *inside* the step, and the editor grew a textarea for it — the user can write the detail the model didn't
- [x] A running plan's steps expand to show what was agreed ([TaskPanel.tsx](../src/components/Chat/TaskPanel.tsx)), which is the only way to answer "is it doing the right thing?" mid-run — a line reading "Source selection strategy" cannot settle it. The panel's header is sticky, so "Stop after this step" survives the list scrolling
- [x] The landing screen is balanced ([HomeScreen.tsx](../src/components/Chat/HomeScreen.tsx)): it was centred geometrically in a tall window, which reads as low, and its composer was `max-w-2xl` against the in-chat `max-w-3xl` — so sending the first message made the box you had just typed into jump 96px wider. Same width either side of that transition, and 9vh off the bottom so it lands where it looks centred rather than where it measures centred
#### Reaching the mode at all

*The deeper plans above are worth nothing if the mode is never entered, and it almost never was. Asked in plain words for a plan, a model wrote one in prose and never touched the tool — so the user got an answer they could not reorder, edit or approve unless they knew to type `enter_plan_mode` themselves. Four causes, all of them ours, and none of them the model's judgement.*

- [x] **The tool was usually not offered.** `enter_plan_mode` was gated on the zone holding a mutating tool, on the reasoning that a read-only zone has nothing to withhold and so gains nothing. That is half of what the mode is; the other half is the artifact — an ordered, editable, approvable plan — and that is worth as much to a zone writing a 5 000-word report as to one editing files. A Quick chat on a search-and-read base zone, which is the setup someone asks for a report plan in, never saw the tool at all, so no phrasing could have produced a plan. Any zone with tools can plan now
- [x] **The system prompt never mentioned it.** Plan mode lived entirely in one tool description among twenty. A `PlanOffer` snippet now says what the mode is for and when to reach for it, with the test that actually fires in practice: *if you are about to write out a numbered list of what you are going to do, call `enter_plan_mode` instead.* It gives way to the mode's own preamble once inside, so the model is never told to enter a mode it is in
- [x] **The prompt pointed at the wrong tool.** The agent-loop preamble's only line about planning was "for anything taking more than about three steps, call `update_plan` first with the whole plan" — a checklist for work already under way that needs nobody's agreement, sitting directly above the plan-mode snippet and competing with it. It reads as progress reporting now, and names `enter_plan_mode` for the case where the user wants to agree the work *before* it happens
- [x] **"Plan this first" had no deterministic effect.** A phrase detector on the incoming message appends a one-off reminder to that turn's request. A note in the message list rather than another snippet, because it varies per message and a volatile snippet at the front of the system prompt costs the prefix cache for the whole conversation behind it. It only ever reminds — the mode is still the model's to enter — so a false positive is one wasted sentence. Tested from the negative side as well, since this app's conversations are full of "read plan.md" and "the plan I approved yesterday"
- [x] Plan mode no longer claims to be for work that modifies something, which was the sentence telling a model writing a report not to plan. What makes a plan worth having is that the shape of the work should be agreed before the effort goes in, not whether it ends in a file write
- [x] **Fixed in the same change:** a perspective zone is one of several voices answering the same question, but plan mode is a property of the *chat* — so with the wider offer it could have taken the whole conversation, and every other participant's turn, into planning on everyone's behalf. It is not offered there, for the same reason `ask_user` is not

- [ ] Runtime-test the whole path: ask for something that needs research, confirm the model asks questions first, watch it search and draft step by step, read the written `.md`, edit a step in the card, approve, and confirm the executing turn is held to the detail and not just the headings
- [ ] Runtime-test the scrolling fix specifically: a plan of 20+ steps, the wheel over the card and over the task panel, and the composer still reachable throughout
- [ ] Runtime-test reachability across zones: ask "plan this out first" in a Quick chat, in a read-only zone and in a zone with file tools, and confirm all three enter plan mode without the tool being named. Then check the negative — "what does the release plan say about 0.13?" must not propose a plan

### 0.14.7 — Retrieval and spend

- [ ] Hybrid retrieval: BM25 over FTS5 fused with the existing cosine score at roughly equal weight, then a cross-encoder rerank of the top ~20 down to ~8. Embedding-only search misses exact-token queries — an error string, a config key, a function name — which is most of what a coding agent looks up. Same RRF shape `smart_search` already uses, applied to the local index
- [ ] A bundled, refreshable model price table; cost in currency per turn and per sub-agent, built on the existing cache-aware token accounting. The header chip currently shows billed tokens behind a dollar sign — this makes the glyph honest
- [ ] Eval harness: point a zone or team config at SWE-bench Verified instances and report pass rate. The premise of the whole panel is that it beats a single local model, and there is currently no way to know

---

## 0.15.x — Smaller lifts

*The rest of [BORROWABLES.md](BORROWABLES.md) — each independently useful, none load-bearing for 1.0.*

- [ ] Cross-chat full-text search over messages (FTS5 is already available). Subchats multiply the number of conversations by the size of the panel and there is currently no way to find one
- [ ] Command palette over zones, chats, settings and skills — everything reachable is a named thing behind a menu. Note `Ctrl/Cmd+K` is already bound to composer focus and would need rebinding
- [ ] Fork scope options: visible path / with branches / all, and standalone vs continuation context
- [ ] MCP `resources/list` as attachable context and `prompts/list` as slash commands — we call `tools/list` and `tools/call` only, so two protocol calls buy a whole surface
- [ ] Saved parameterised runs: prompt template + zone + parameters in one shareable file. Zone teams already encode who does the work; this encodes the task
- [ ] Quick assistant — a global-shortcut mini window over the base zone, the fast end of the fast-to-thorough spectrum the roadmap describes

---

## 1.0.0 — Hardening & Public Release

*How each open item below can actually be closed — including the three that a manual pass cannot honestly close at all — is worked through in [TEST_STRATEGY.md](TEST_STRATEGY.md). Summary: build the mock streaming provider first (it turns "no dropped tokens" from an unfalsifiable claim into a diff, and needs no provider, key or network), run `npm run build` and `cargo test --lib` on every change (37 files of Rust tests exist and nothing ran them; this is now a pair of git hooks rather than a CI job), and test the updater against a local two-build loop rather than the release pipeline, where a build is a publish.*

- [x] ~~Blocker: add `TAURI_SIGNING_PRIVATE_KEY` and its password to repo secrets~~ — **they are already there.** Recorded as an open blocker in error; the evidence is in the tree: [updater/latest.json](../updater/latest.json) carries a real 420-character signature per platform for v0.13.0, and its URLs are the token-authenticated asset endpoints, so both the signing step and `rewrite-updater-manifest.mjs` are working in production. Secrets are only readable by workflows, so a local clone never sees them and does not need to — a local `tauri build` produces unsigned bundles, which is correct for a build that will never be published
- [x] Every change is checked — `npm run build` (which runs `tsc -b` first), `npm test`, `cargo test --lib`. **Moved off GitHub and onto the development machine in 0.14.0** ([.githooks/](../.githooks/)): `npm run check` on commit, `npm run check:all` on push, which is where it belongs in a repo whose push *is* the publish. [ci.yml](../.github/workflows/ci.yml) keeps the same two jobs as a `workflow_dispatch`-only second opinion — the hosted Windows runner spent ~13 minutes in rustc per commit to re-prove what a warm local target directory proves in ~40 seconds. What that trades away is the clean-checkout property, and it is worth naming: both CI jobs failed on their first real run (v0.13.3) for exactly that reason — Node 20 could not expand `node --test`'s glob, and `tauri::generate_context!()` needed a `dist/` that had simply been sitting in this working tree since the first build. A hook cannot catch either. Dispatch ci.yml before a release if a change looks environment-sensitive
- [ ] Mock OpenAI-compatible streaming provider emitting a known token sequence, with the scenario set in [TEST_STRATEGY.md](TEST_STRATEGY.md#2--streaming-under-sustained-use) — dropped tokens become a named index rather than a judgement call
- [x] Fixture test for the updater manifest rewrite — the mapping is now a pure function ([rewrite-manifest-core.mjs](../scripts/rewrite-manifest-core.mjs)) with 7 tests, covering the percent-encoded filename case that would otherwise publish a manifest with unrewritten URLs and stop every install updating. `npm test`, no network
- [ ] Performance: measure and optimize startup time, first message render, large chat (500+ messages) scroll — fixed the main structural cause of wasted re-renders: `Sidebar`/`ChatPanel`/`MessageThread`/`ChatList`/`ZoneEditor`/`ProjectsPanel`/`SettingsModal` subscribed to the whole zustand store unfiltered, so *any* state change anywhere re-rendered all of them; converted to shallow/per-field selectors, and `UserMessage`/`BotTurnView` are now memoized (with a custom comparator for `BotTurnView` since `groupMessages` rebuilds turn objects each call) so a streaming token only re-renders the turn actually generating, not the whole history. Still open: no virtualization for very long (500+) message lists, and no measured before/after startup or first-paint numbers.
- [ ] Streaming: verify no dropped tokens or UI lag under sustained use — hardened `ChatPanel`'s Tauri event-listener effect to run once (refs instead of a dependency array) so the "stream" listener can never be torn down and re-attached mid-session, closing the only realistic drop window found. Sustained-use soak testing not yet done.
- [ ] Installer: Windows (NSIS or WiX), macOS (DMG), Linux (AppImage)
- [~] Auto-updater: Tauri updater plugin wired to GitHub releases — *built in 0.9.12*: plugin registered, signed `latest.json` published by CI alongside the installers, Settings → Data carries check / download-with-progress / install / restart. **The signing secrets are set** and the published manifest proves the whole CI half works: v0.13.0's entry is signed and its URLs are rewritten to the token-authenticated asset endpoints. What is still unverified is the *receiving* half — nobody has watched an installed build find an update, download it and restart into the new version. Several releases have now shipped (v0.12.6, v0.12.7, v0.13.0), so this needs no special setup: install the previous release, publish the next, and watch it. Local rehearsal without publishing anything is in [TEST_STRATEGY.md](TEST_STRATEGY.md#4--auto-updater-end-to-end)
- [ ] Cross-platform smoke tests on Windows 11, macOS, and Linux
- [x] Write REQUIREMENTS.md for contributor onboarding — full doc (personas, user stories, functional/non-functional requirements, out-of-scope) grounded in the roadmap principles and the 0.1–0.9 feature set ([REQUIREMENTS.md](REQUIREMENTS.md))
- [x] In-app keyboard shortcut reference — `?` (outside text fields) or the keyboard icon in the sidebar opens a shortcuts modal cataloguing every shortcut wired up in the app
- [x] App-wide keyboard control — a central handler ([useGlobalShortcuts.ts](../src/lib/useGlobalShortcuts.ts)) driven by a single shortcut definition list ([shortcuts.ts](../src/lib/shortcuts.ts), shared with the help modal so the reference can't drift). Ctrl/Cmd+N new chat, Ctrl/Cmd+, settings, Ctrl/Cmd+B toggle sidebar, Ctrl/Cmd+L zone library, Ctrl/Cmd+Shift+P projects, Ctrl/Cmd+K focus the composer, Alt+↑/↓ prev/next chat, Ctrl/Cmd+/ or `?` the reference. Modifier shortcuts fire even mid-typing; the plain `?` is suppressed in text fields. Sidebar open/closed moved into the store (same `ui.sidebarOpen` persistence key) so a shortcut can toggle it; composer focus signalled via a store nonce
- [ ] Clean uninstall: no orphaned files or registry entries
- [x] Formal pre-release test checklist — [TEST_CHECKLIST.md](TEST_CHECKLIST.md), covering build plumbing, first run, chat, zones/projects/tags, tools, knowledge, multizone, voice, export, updates, uninstall, cross-platform and performance

---

## 1.1.x — In-chat rendering & tools

*`render_graph` covers Mermaid and function plots. What it does not cover is data — the case where a model has numbers and wants to show them. AIRouterDesktop and Claude both make chart rendering an obvious in-chat capability; ours is a diagram tool that happens to plot functions.*

### 1.1.0 — Charts from data

- [ ] A charting renderer taking a data spec (series, labels, axes, chart type) rather than a diagram source: bar, line, area, scatter, pie, stacked variants
- [ ] Theme-aware and accessible by construction — the palette comes from the active app theme, works in light and dark, and does not rely on colour alone to distinguish series
- [ ] The model calls it with data it already has (a query result, a table it just read, numbers from a document) instead of hand-writing SVG or a Mermaid approximation
- [ ] Charts survive export: PDF and Markdown export render them rather than dropping to a placeholder
- [ ] A table in a model's markdown answer offers "chart this" — the common case is the model already produced the numbers and only the presentation is missing

### 1.1.1 — Richer in-chat artifacts

- [ ] Interactive tables: sort, filter, and copy from a rendered markdown table without leaving the chat
- [ ] Inline results are addressable — a chart or table can be referenced by a later turn rather than re-derived
- [ ] Audit what the existing renderers (Mermaid, mathplot, HTML report) cost during streaming, now that block-level parsing (0.9.16) has changed when they re-render

---

## 1.2.x — Signed-in connectors

*The "Connect Google" button, and the same again per provider. Deliberately after 1.0: 0.11.2's catalog and static-token headers already get a non-technical user most of the way — "Gmail: paste the token from here" is a different experience from "configure a stdio MCP server" and needs no OAuth at all. This release is what makes it one click, and it is mostly not MCP work.*

- [ ] OAuth client with a loopback redirect listener, token exchange and refresh
- [ ] Refresh tokens in the OS keychain rather than SQLite — a long-lived credential for someone's mailbox is not app data
- [ ] Per-scope consent UI: the user grants Calendar without granting Gmail, and can see and revoke what was granted
- [ ] Google first (Gmail, Calendar, Drive, Maps), then the pattern generalised
- [ ] **Sizing note, so this isn't picked up lightly:** Google requires a Cloud project and a *verified* consent screen for restricted scopes like Gmail. That verification is a review process measured in weeks, not a sprint, and it applies to us as the OAuth client — which is a distribution question for a local-first app, not only an engineering one. See [CONNECTIVITY.md](CONNECTIVITY.md#the-three-routes-to-google-honestly-sized)

---

## Backlog — unscheduled

- [ ] Code interface: chat window for local models working on codebases; uses RAG from 0.4.3; requires design session
- [ ] **File editing as an engine, not a tool.** Cursor and Antigravity handle multi-file editing categorically better than we do, and the gap is structural rather than a missing feature: they apply *edits* (search/replace or diff hunks, validated against the file as it currently is) where our `write_file` rewrites a whole file from whatever the model remembers of it. A real edit engine means a hunk format, fuzzy anchoring that survives a file having moved on, a syntax check before the write lands, and a failure that reports "the anchor no longer matches" instead of silently clobbering. This is the prerequisite for the code interface above and is scoped with it, not before it. 0.10.x's checkpoints and 0.10.2's diff review are the parts of this problem worth solving early, because they help every existing file tool immediately
- [ ] **Study mode.** A mode for learning a body of material rather than working on it. The user brings sources into a project — lecture notes, a spec, a textbook chapter, a stack of papers — and the app helps them *know* it. NotebookLM is the reference implementation and the citation-UX benchmark; it is also cloud-only and requires handing Google the sources, which is the whole argument for us having one.

  Per the "build components before modes" principle, this is a mode and belongs *after* its components. Most of them already exist:

  | Needs | State |
  | --- | --- |
  | Per-project source corpus | Built — the knowledge base, with a file watcher that re-indexes on save |
  | Inline citations back to the source | Built — `search_local_files` returns source, chunk and score; citations render and survive export |
  | Diagrams for a mind map | Built — `render_graph` draws Mermaid |
  | Spoken output for an audio overview | Built — TTS (0.8.1), including speech pipelining |
  | A document a study artifact can be produced into | Built — `present_file` and the HTML report renderer |
  | Reusable per-task instructions | Built — skills |
  | **Source-only grounding** | **Missing** — the mode's whole premise |
  | **Durable study state** | **Missing** — what has been asked, what was wrong, when it is due again |
  | **Retrieval good enough to trust** | **Partly** — see 0.14.4; embedding-only search is weakest on the exact-term lookups a learner makes ("what does it say about *X*") |

  **A second reference, for the teaching half** — Eero Alvar, [*How to optimise learning with AI*](https://www.youtube.com/watch?v=kzcI5F4tGiU). NotebookLM is the benchmark for handling *sources*; this is the benchmark for *instruction*, and they are not the same product. The argument: one teacher to many students is inefficient not because the teacher is bad but because the instruction cannot be aimed, and a learner who assembles their own understanding from four explanations pays the cognitive cost of four teaching styles on top of the material. An AI is one consistent teacher that can absorb the differing perspectives and present them through a single interface, so the learner's attention goes to the subject rather than to finding sources, reconciling them and checking them.

  The part worth taking is the three-phase loop, because it is a shape we can build almost entirely out of pieces that exist:

  | Phase | What it does | What it would be here |
  | --- | --- | --- |
  | **Probe** | Graded multiple-choice questions until the *edge* of the learner's knowledge is located — not a score, a boundary | `make_quiz` against the corpus, with the answers written to durable study state instead of discarded |
  | **Plan** | A curriculum, drawn as a graph. The drawing is the point: it forces the model to reason the teaching order through up front rather than deciding what comes next one message at a time | `render_graph` plus `update_plan`, both already built |
  | **Teach** | One reasoning step per message, with periodic quizzes before moving on | The mode itself — a chat state that paces the material against what the probe found |

  Two things in it are load-bearing for how this gets scheduled. The probe is worthless unless its result is *stored*, which is the **durable study state** row above — that row is the difference between a teacher and a generator of study material, and it is why the artifacts alone do not add up to this. And his own build is a Python harness with Obsidian as the UI, which is the same conclusion this document keeps reaching from the other direction: the chat panel is the wrong surface, and the shared mode workspace is the missing component.

  What the mode itself would add:

  - **Grounded answering.** Answers drawn only from the project's sources, with every claim carrying a citation, and an explicit *"the sources don't cover this"* when they don't. The refusal is the feature — a study tool that quietly fills gaps from the model's own knowledge is worse than no study tool, because the gap is invisible exactly where the user is least able to catch it. Mechanically this is close to plan mode: a chat state that withholds tools and constrains the system prompt, which is a shape we have already built once.
  - **Spaced repetition.** The genuinely new engineering: a schedule per card (SM-2 is a day's work and good enough), stored per project, surfaced as "12 cards due" rather than requiring the user to remember to revise. This is the part that makes it a study *tool* rather than a chat with a document.
  - **Progress**, per project: which sources have been covered, which are untouched, where the wrong answers cluster.

  **Study tools.** NotebookLM's Studio panel is a row of one-click generators, and that maps cleanly onto the architecture we already have: a tool the model calls, returning structured data, rendered by a block renderer and made exportable. The same pattern as `update_plan` → `PlanBlock` or `render_graph` → `MermaidBlock`. Each row below is one tool plus one renderer, not a feature:

  | Tool | Renderer | What exists already |
  | --- | --- | --- |
  | `make_mind_map` | Mermaid | **All of it** — `render_graph` draws this today; it needs a prompt and a source-grounded input, not code |
  | `make_report` (study guide / briefing / FAQ / timeline) | Markdown + `present_file` | **All of it.** Four artifacts that differ only by their skill |
  | `make_flashcards` | New — a card deck with flip and self-rating | Data model is trivial; the renderer is small; the *scheduling* behind it is the real work |
  | `make_quiz` | New — question list with answer checking | Grading must cite the passage, so it leans on the same retrieval as everything else |
  | `make_data_table` | New — but **1.1.1 already schedules interactive tables** (sort, filter, copy). Same renderer, different producer: here it extracts rows from unstructured sources | Converges with 1.1.x; build once |
  | `make_slide_deck` | New — HTML slides | `HtmlReportBlock` renders and presents arbitrary HTML today, so this is a template and a print stylesheet |
  | `make_infographic` | HTML report | Same renderer again. This is a *design* problem, not an engineering one — an infographic nobody would print is worse than the table it replaced |
  | `make_audio_overview` | Existing audio playback | TTS ships; the work is a two-voice script and turn-taking, not synthesis |

  **Video overview**, previously dismissed here as out of scope, deserves a more honest line: it is a slide deck plus an audio overview plus a recorder. If the first two land, the third is a capture step rather than a production pipeline. Still last, still lowest value, but no longer a category we refuse.

  **Its own interface.** Like the code interface, this wants a workspace rather than a chat panel: sources down one side, the conversation in the middle, generated artifacts collected somewhere they can be returned to. That is the second time this shape has come up in the backlog, which is the signal — **build one mode surface and let both use it**, rather than two bespoke shells that duplicate every affordance. The principle is the roadmap's own: components before modes, and "a workspace a mode can furnish" is a component. Whichever mode lands first should pay for it, and it should be scoped as its own item before either.

  Sizing note: the artifacts are cheap because the components exist. Grounding is a mode. Spaced repetition is new state with a scheduler. The interface is shared with the code interface and should be scoped separately. Do not schedule this as one release — the artifacts alone are worth shipping before any of the retention machinery, and they are also the honest test of whether anyone uses it.

- [ ] **Mobile as a remote for the desktop, not a second app.** A Tauri mobile target (iOS/Android) that is a *window onto the machine at home* rather than a copy of the app running on a phone. It shows the same chats, the same zones, the same projects; you send a message from the phone and the desktop runs it — its providers, its models, its files, its MCP servers, its tools. Nothing infers on the phone and nothing is stored there that the desktop does not already hold.

  This is the right shape for three reasons, and they are worth stating because "just port the app" is the tempting one. A phone cannot run a 30B local model, which is the entire premise of the product. Every tool that matters — `read_file`, shell, the knowledge index, an npx MCP server — is meaningless without the desktop's filesystem. And the alternative, syncing two independent stores, is the cloud-sync feature [REQUIREMENTS.md](REQUIREMENTS.md#out-of-scope) explicitly refuses; a remote client has no second copy to sync.

  **Most of it exists.** 0.11.0 turned the API into the whole app — 105 routes, generated route index, a drift test that fails the build when a new Tauri command has neither a route nor a stated GUI-only reason — and `/api/chats/:id/messages` already streams the agentic loop over SSE. The frontend has one seam: every backend call in the React app goes through [src/lib/tauri.ts](../src/lib/tauri.ts) (`invoke` + `listen`), with a handful of window-chrome exceptions. A transport that implements that module's surface against HTTP + SSE instead of `invoke` is the port. The UI itself should need close to nothing beyond touch targets and layout.

  What does *not* exist, and is the real work:

  - **Reachability.** The server binds `127.0.0.1` on purpose. A LAN bind is opt-in, separate from the existing on/off, and must be honest about what it means — the app is now on the network. Bind to the chosen interface, never `0.0.0.0` silently
  - **Pairing instead of a pasted token.** The desktop shows a short code (and the same thing as a QR: host, port, code). The phone sends it once and gets back a **per-device token** it keeps; the code is single-use and expires in minutes. A device registry — name, platform, first seen, last seen, token hash — with revoke per device, so a lost phone is one tap rather than a token rotation that logs out everything. Per-device tokens are what makes "it just works next time" and "revoke that one" the same feature
  - **Approvals on the phone.** A tool prompt currently blocks on a desktop dialog. From a phone that means a run stalls at a dialog nobody is standing in front of. The pending-approval queue needs to be readable and answerable over the API, and 0.14.2's per-category approval is what makes leaving a run unattended reasonable in the first place
  - **Discovery, so nobody types an IP.** mDNS/Bonjour advertisement of the desktop on the LAN, with manual host entry as the fallback that always works
  - **The desktop being asleep**, which is the honest failure mode of this design, and belongs in the UI as a stated reason rather than a spinner

  Deliberately *not* in scope: any access from outside the LAN (no relay, no tunnel, no account — that is cloud sync wearing a different hat), and any offline mode on the phone. If the desktop cannot be reached, the phone says so.

  Sized as: LAN bind + pairing + device registry on the desktop first — useful on its own, since it is also how a tablet, a second laptop or a script on the LAN reaches the app — then the transport shim, then the mobile shell. See [CONNECTIVITY.md](CONNECTIVITY.md#part-3--the-phone-as-a-second-window).
- [ ] Deep research mode: multi-step sourced research using subchats; requires design session before scheduling
- [ ] Zone snapshot/versioning: save zone config at chat creation time so editing a zone does not alter historical context
