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

- [ ] **State not saving — search provider** — the search provider selection (and most other settings field) doesn't persist; investigate the settings write path for that field
- [x] **Dropdowns not styled consistently** — *fixed in 0.7.0*: a shared `SettingSelect` (styled control + chevron) now backs Default provider, Quick chat base zone, Search provider, and MCP transport
- [x] **Branch only works from the primary response in perspective mode** — *fixed*: perspective `ParticipantCard`s now receive `branchFromMessageId={p.messageId}`, so the Branch action appears on every perspective card. The backend `branch_chat` already copies history by the pivot's timestamp, so branching from a perspective's message id forks the chat up to and including that round (no backend change needed)
- [ ] **Chat history mix-ups** — viewing subchats (and sometimes ordinary chats) occasionally shows mismatched prompt/content pairs, or an entire history rendered as if every chat is identical; clears on app restart but recurs. Likely a keying/identity bug in the message store or list virtualization — needs a reliable repro
- [ ] **Tool approvals inside subchats never reach the user** — subchats are read-only in the UI, so the approval banner isn't shown; a sub-agent tool call needing approval waits ~5 min and is auto-denied, silently stalling the sub-agent. Safe today only if sub-agent zones stick to auto-approved/safe tools. Fix: surface subchat approval prompts somewhere actionable (parent chat, or an observable approval UI in the subchat view). Introduced in 0.5.1 (spawn-subagent tools)
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

*A dedicated pass over the toolset, which has grown organically since 0.1.x. Three themes: **naming clarity** (tools that read plainly to a user and to a small local model), **completing the file tools** (rename/move/copy/delete + fast search, so file handling isn't write-only), and **self-authored skills** (a zone can write a skill from what it just learned). Every rename must keep the old machine name resolving — `ToolId::from_str` already accepts a legacy alias (`"present_file" | "save_output"`), which is the pattern to follow so existing zones' `tools_enabled` arrays and stored tool-call history don't break.*

### 0.9.0 — Tool naming & discoverability

*Status: built & typechecked (`cargo check` + `cargo test` (22 pass) + `npm run build` green); not yet runtime-tested in the app.*

*Naming was split in two rather than done as one sweep. **User-facing** names/descriptions ([types.ts](../src/lib/types.ts) `ALL_TOOLS`, now a typed `ToolInfo` with a `category`) were rewritten wholesale for a reader who doesn't know the jargon — "Read & write files", "Read a web page", "Run terminal commands". **Machine** names (what the model sees) were left alone except for the knowledge rename, because every machine-name change is a stored-data migration: a zone's `toolsEnabled`, the curated presets, and every historical tool call carry the raw id. The model reads the tool's `description`, not its id, so the plain-English work that actually improves a small local model's tool use is in the Rust definitions — which is where the effort went.*

- [x] **Human-facing tool metadata**: display name + plain-English description per tool, separate from the machine name sent to the model — the pre-existing `label`/`description` fields were rewritten and gained a `category`
- [x] **Rename the knowledge tool**: `search_knowledge` → `search_local_files`, with a description that says what it is (searching the user's own files, by meaning) and points at `search_file_text` for exact matches. Old name still dispatches; UI copy in Settings → Knowledge, the project editor, and the chat header updated
- [x] **Plain-English pass across the built-in set** — every user-facing label/description rewritten ("Read a web page", "Draw a chart or diagram", "Rename, move & delete files"); machine names deliberately unchanged apart from the knowledge tool (see status note)
- [x] Legacy alias map in `ToolId::from_str` + `tool_safety_by_name` + `dispatch`, so a renamed tool still resolves from an existing zone's `tools_enabled` and from stored tool-call history — *no id-rewriting migration needed, since aliases cover it and nothing was orphaned*
- [x] Tools grouped by category in the zone editor (Files · Web · Knowledge · Agents · System · MCP) rather than one flat list
- [x] **Enable/disable all tools** — tri-state master toggle (on / off / mixed) plus a per-category and per-MCP-server group toggle (`GroupToggle` in [ZoneForm.tsx](../src/components/Zones/ZoneForm.tsx)). Writes the full id set into `toolsEnabled` rather than a wildcard, so a zone's toolset stays explicit and a tool added in a later release is never silently granted to it
- [x] Curated zone presets updated (Code Companion gains file search/manage + plan; Deep Researcher and Response Leader gain plan); `safe_tool_ids` gains `plan`; curated library version bumped to 8

### 0.9.1 — File management & search tools

*Status: built & typechecked; 7 new unit tests cover the scoping guards and both search tools (`cargo test` 22 pass). Not yet runtime-tested in the app.*

*Shipped as two new zone-selectable groups rather than bolted onto `file_system`, so a zone can be given the ability to produce files without the ability to destroy them: **`file_manage`** (move/copy/delete/create_folder — group classed dangerous so it never lands in a default toolset) and **`file_search`** (find_files/search_file_text — read-only, gated like the other file reads). Per-call safety still comes from `tool_safety_by_name`, so move/copy/create_folder prompt as moderate while every `delete_file` prompts as dangerous. Two pure-Rust deps added — `globset` and `regex` — consistent with the no-native-deps stance.*

- [x] `move_file(from, to)` — move or rename a file/folder (rename = same parent, new final segment); moderate safety. Refuses an existing destination unless `overwrite: true`, and clears the destination first so a replace works on Windows
- [x] `copy_file(from, to)` — moderate safety; single files only
- [x] `delete_file(path)` — **dangerous** (always approved); refuses a directory unless `recursive: true`, and refuses to delete an allowed root itself
- [x] `create_folder(path)` — idempotent mkdir -p
- [x] `find_files(pattern)` — glob over paths, returning paths only (token-cheap); matches against both the relative path and the bare filename so `*.rs` works without a leading `**/`
- [x] `search_file_text(query, glob?)` — regex (or `literal`) content search returning file + line number + the matching line; skips binaries (NUL sniff), files over 2 MB, and noise directories (`node_modules`, `target`, `.git`, …); an invalid regex returns an error that tells the model to retry with `literal: true`
- [x] Both endpoints of every move/copy are scope-checked through one shared `checked_path`, so a move cannot be used to escape the allowed roots — covered by a test
- [~] Renames/moves/deletes inside a knowledge-indexed directory should trigger the existing auto re-index watcher (it watches the directory, so this ought to be free) — **not yet verified**

### 0.9.2 — Self-authored skills

*Memory (0.3.3) captures **facts**; skills (0.3.2) capture **procedures**. The gap today is that only the user can author a skill — a zone that works out a good procedure has no way to keep it. `create_skill` closes that loop, guarded so an agent can't silently rewrite its own instructions.*

*Status: built & typechecked (migration 023 adds `skills.authored_by_zone_id`); not yet runtime-tested. Both tools live under the existing `skills` ToolId, so any zone with Skills can already author them.*

- [x] `create_skill(name, description, instructions)` tool: the model writes a new skill into the global `skills` table, stamped with the authoring zone (`caller_zone_id`, already threaded through `dispatch`). The tool description tells it to frame `description` as the triggering use case and to prefer `save_memory` for one-off facts
- [x] Self-authored skills are created **disabled** and flagged with `authored_by_zone_id` — they enter no catalog until the user enables them in Settings → Skills. Safety stays 0 for `create_skill` precisely *because* a disabled skill changes nothing an agent can act on
- [x] `update_skill(name, instructions)` — moderate safety (approval), since revising an existing instruction set *does* change behaviour. Leaves the enabled state alone
- [x] Settings → Skills: self-authored entries carry a "written by <zone>" badge (with the date on hover), sort to the top of the list, and a banner counts how many are awaiting review
- [~] Notification when a skill is written mid-turn — the `create_skill` call is visible in the message thread like any tool call, and the review banner catches it in settings, but there's **no toast**; revisit if it proves easy to miss
- [x] Guardrails: duplicate-name detection (tells the model to call `update_skill` instead), and a cap of 20 unreviewed self-authored skills before `create_skill` starts refusing

### 0.9.3 — Other recommended agent tools

*Status: built & typechecked (`cargo test` 23 pass, `npm run build` green); not yet runtime-tested. All six candidates shipped — none were cut, and one (`ask_user` options) turned out to already exist.*

- [x] **`plan` tool** ([plan.rs](../src-tauri/src/tools/plan.rs), `update_plan`) — a checklist the model maintains across a long multi-step turn, rendered inline as a progress list ([PlanBlock.tsx](../src/components/Renderers/PlanBlock.tsx)) rather than raw JSON. Deliberately **stateless on the backend**: the plan lives in the conversation as tool calls/results, so it survives reload/branching/export with no new table and a sub-agent's plan can't collide with its leader's. Each call replaces the whole list, which also keeps the plan in the model's own context where it does the most good. Safe (level 0); added to Code Companion, Deep Researcher, and Response Leader
- [x] **`http_request`** ([http.rs](../src-tauri/src/tools/http.rs)) — a general HTTP call returning status/headers/raw-or-parsed body, so a zone can talk to an API; distinct from `extract_url`, which cleans a page into prose. **Kept despite the MCP overlap:** an MCP server is a per-endpoint setup step, and the common local-first case (hit a service on localhost, poke a JSON endpoint) shouldn't require standing one up. Dangerous-level — the approval prompt (method + URL + body visible) is the security boundary, deliberately with *no* host allowlist, since the most common use here is calling localhost, which any sensible blocklist would forbid. 100 KB body cap, 30s timeout
- [x] **Context compaction** ([compact.rs](../src-tauri/src/tools/compact.rs), `compact_context`; migration 024) — the model summarizes its own older turns, and from the next turn that summary *replaces* them in the history it is sent. Nothing is destroyed: the messages stay in the DB and on screen, only the request body changes. Re-compacting moves the cutoff forward, and the tool tells the model to fold any previous summary into the new one so nothing is lost across compactions. Moderate safety (it's a lossy rewrite of what the model can see, so the user approves it). A system-prompt nudge fires past ~12k tokens of history — but only for zones that actually have the tool, since otherwise it's noise they can't act on
- [x] **`ask_user` options** — *already existed*: `options`, `allow_free_text`, and a multi-question form were shipped earlier, and `AskUserCard` renders them as buttons. No work needed; the plan item was simply wrong
- [x] **User-editable tool descriptions** — per-zone overrides stored in `tool_config` as `{"tool_descriptions": {"<function name>": "…"}}` and applied in `build_tools_for_zone` (so they cover MCP tools too). Keyed by *function*, not group, since one group (`file_system`) exposes several. The editor reads the shipped defaults from a new `list_tool_functions` command rather than duplicating them in TypeScript, keeping Rust the single source of truth for what the model actually sees; an empty box falls back to the default rather than sending an empty description
- [x] **Tool usage stats** (migration 025) — per-zone call/error counters, shown against each enabled tool in the zone editor ("12× used · 2 failed", or a blunt "never used"), with a reset control. Aggregate counters rather than an event log — the question is *does this zone use this tool*, not *when exactly* — so it's one UPSERT per call instead of an unbounded table. Recording is best-effort and never fails a turn; a denied approval counts as an error

---

### 0.9.4 — Token accounting refinements

*A follow-up to the 0.3.1 token counters. Tool-call output is now counted as the output tokens it is, and a per-chat context meter surfaces the whole conversation's size. All estimates are chars→tokens (~4 chars/token) — no exact tokenizer exists for arbitrary local models — so they're a guide, not a billed count. Centralized in [tokens.ts](../src/lib/tokens.ts).*

- [x] **Tool-call output tokens** — the args a model streams to call a tool are real output tokens (they cost generation time), so they're now summed into the per-message `MessageStats` (`toolCallChars`, from the turn aggregate) and shown as their own "Tool call tokens (est.)" row in the stats popover. They already fed the live banner's token count; now they also count toward the saved total and tok/s. Perspective turns sum their pending tool args since they have no turn aggregate
- [x] **Context meter** ([ContextMeter.tsx](../src/components/Chat/ContextMeter.tsx)) — chat-header readout of the current context size, estimated from all persisted messages: input (user turns, uploaded file text, tool responses, images at a flat per-image estimate) vs output (assistant answers, thinking, tool calls). Click for the input/output split. Recomputed via `chatContextEstimate` as messages change

---

### 0.9.5 — Tool reliability & citation accuracy

*Not a planned release — a pass over things that were shipped-but-wrong, found by using the app. Three areas: web search told the model the wrong thing when throttled, the Linux escape hatch couldn't hold state, and inline citations put their markers in the wrong place.*

- [x] **DuckDuckGo by default; multi-engine fan-out removed** ([web_search.rs](../src-tauri/src/tools/web_search.rs)) — the provider list narrows to DuckDuckGo (no key), SearXNG (self-hosted), and the key-based APIs (Brave, Tavily, Serper). The DDG+Marginalia "multi" fan-out and the standalone Marginalia engine are gone, along with their interleave/dedupe helpers. Both retired values migrate to `duckduckgo` on load and defensively in the Rust dispatch, so a saved zone config still resolves
- [x] **DDG anti-bot challenge detected instead of reported as "no results"** — DDG answers a throttle with HTTP 202 carrying a challenge page, not 429. `is_success()` accepted it, the parser found zero hits, and the model was told "No results found." — a confident false negative that had zones asserting a well-covered topic has no information. Now returns an explicit rate-limit error, matched on status plus `anomaly` / `challenge-platform` markers and validated against captured blocked and healthy pages
- [x] **No inter-query rate gate** — a 2.5s proactive gate was added with the detection above and then reverted: measurement showed the challenge still trips on the *second* request of a shared client at that spacing, so it cost latency without preventing anything. The trigger is not simple request rate — an ordinary browser on the same IP is unaffected while `curl` and `reqwest` are challenged, and polling while blocked appears to sustain the block where ~10 minutes of silence clears it. The model-facing message says *do not retry*; a note in the source records the measurements so the gate isn't reintroduced
- [x] **`wsl_exec`** ([wsl.rs](../src-tauri/src/tools/wsl.rs)) — run Linux commands from Windows. One-shot `wsl.exe -e bash -c` resets cwd, exports and activated virtualenvs on every call, so multi-step work was inexpressible. Default stays one-shot (10s timeout, predictable, what most calls need); the model opts into `persist=true` per call for a long-lived shell scoped to the chat, where cwd/env/venvs/background jobs carry across steps (~250µs per command vs ~150ms for a fresh spawn). Sentinel protocol rather than a PTY, following the MCP stdio transport's long-lived-child pattern; sessions reaped after 30min idle and torn down with the chat. A command that kills its own shell (`exit`) transparently gets a fresh session with `session_restarted` reported, since the accumulated state is genuinely gone and the model must not assume otherwise. Safety tier 2, matching `shell_exec`
- [x] **Windows PATHEXT resolution for spawned programs** ([program.rs](../src-tauri/src/util/program.rs)) — `Command::new` bottoms out in `CreateProcess`, which does no PATHEXT lookup, so a bare name only ever matched `foo.exe` and `npx` failed with "program not found" on machines where only `npx.cmd` exists. This broke every Node-based MCP server. Now walks PATH × PATHEXT and routes batch shims through `cmd.exe`; used by the MCP stdio transport and `code_exec` (version-manager shims like pyenv-win are the same hazard)
- [x] **Citation markers stay on the claim** ([citations.ts](../src/lib/citations.ts), [remarkCitations.ts](../src/lib/remarkCitations.ts)) — a web source anchors on its host name, and when a model closes with a trailing link list ("Official site: ornith.online") that list was often the only verbatim occurrence, so markers drifted to the bottom of the answer and stacked when results shared a host (`ornith.online[2][8]`). Reference entries (short label plus a link) are now excluded from anchoring in both the search and the insertion pass, and a host must be unique across the candidate set to anchor at all
- [x] **A source can be cited more than once** — the auto-insert pass placed each source at most once per parse. Both paths now mark every occurrence: a repeated `[2]` the model wrote, or an anchor appearing in three different sentences
- [x] **Sources survive into later turns** — citations were collected from the current turn's blocks alone, so a follow-up answer leaning on a search that ran two turns back rendered with no sources at all. Earlier turns are scanned for tool results and fed in as extra candidates; a carried source is listed only if the answer actually cites it, so an old search doesn't drag stale URLs through every later turn
- [x] **Tool-call arguments stream on every provider** ([streaming.rs](../src-tauri/src/llm/streaming.rs)) — calls appeared to stream on some models and to materialise fully-formed on others. Not a setting: the chat path has always requested `stream: true`. `ToolCallStart` opens the UI block the argument deltas fill in, and it was only emitted once a delta carried a non-empty function name, while the frontend dropped any args delta for an index it hadn't seen a start for. Providers disagree about what the opening delta carries — some send `{id, function:{name}}` then args-only deltas, others open with args and name the function later — so for the second group no block opened and every delta was discarded. The block now opens on first sight of an index and is re-announced once the name is known; the store creates the block if missing rather than dropping the delta. Five tests replay the provider delta shapes. A provider that emits the whole call in one terminal chunk still has nothing to stream
- [x] **Title generation runs in parallel with the answer** — it fired on `done`, after the entire first response had streamed, so a chat sat as "New Chat" for the length of its opening turn. Now fires on `user_message_saved`: two concurrent requests to the same endpoint with the same model, and the title usually lands mid-stream. Guarded to the chat's first turn, which also skips branched chats
- [x] **Titles see the actual content** — the message was flattened to its text parts, so a turn that was a photo plus three words was titled from three words. The conversation goes in as real messages with images kept (low detail, capped at four, same vision-capability resolution an ordinary turn uses; non-vision models get "[image attachment]"). System prompt, memories, skills and tools stay out — a title needs the content, not the zone's operating context
- [x] **Forced regenerate re-reads the whole conversation** — it re-ran the same first-message-only prompt, so re-titling a chat that had wandered returned a title of its opening line. `generate_title` takes `whole_conversation`; assistant turns included with thinking stripped, tool traffic dropped, each message capped at 2000 chars

---

### 0.9.6 — Long tasks that finish

*Also not planned — found the same way. A turn that involved real multi-step work kept ending before the work did: a wall of tool steps and then nothing, or a progress note the model never followed up on. Three separate causes, all in the agentic loop.*

- [x] **The step budget is a setting, and its last steps are spent finishing** ([messages.rs](../src-tauri/src/commands/messages.rs), [continuity.rs](../src-tauri/src/llm/continuity.rs)) — the loop ran a hard-coded 8 iterations and then fell out of the `for`, ending the turn on whatever the last tool returned. Since a step can carry several parallel tool calls, a research turn burned the budget in a handful of model messages and the user got 67 retrieved sources and no answer. Now `maxToolSteps` (Settings → Chat, default 30, clamped 4–200), and the budget ends deliberately: one step before the end the model is told how many it has left, and on the final step the request goes out with `tools: None` so it has no option but prose. A turn that runs out of room now says what it did and what is left instead of trailing off
- [x] **A stalled turn is retried instead of ended** — the loop treated "no tool calls" as "finished", which it usually is and sometimes is not. Two stalls are now told apart from a real answer and re-prompted (up to 3 times per turn): the *empty* step, where a model returns nothing at all after a long run of tool results, and the *announced* step, where it narrates its next action — "All tabs closed. Now opening the six opportunities." — without taking it. Classification is in `llm::continuity` behind unit tests, and is deliberately conservative: hand-offs ("let me know if you want…"), long answers, findings that merely mention an action ("running the suite takes four minutes"), and any intent stated before a tool has run this turn all count as finished. A false positive costs one extra model message; a false negative leaves the task half-done
- [x] **Empty assistant messages are no longer written to the chat** — a step that produced no content, no reasoning, and no tool calls was persisted anyway, which is where the blank bubble at the end of a long tool run came from. It is now dropped from both the chat and the replayed history — an assistant message with neither content nor tool calls is also rejected outright by some OpenAI-compatible providers
- [x] **Zones with tools are told how the loop works** — a model that doesn't know it will be called again after a tool result has every reason to stop and wait for the user. A short preamble in the system prompt says so, and states the rules the stalls above violate: never announce an action without taking it, never reply with an empty message, finish with a written answer rather than tool output. Added only for zones that have tools, and it points at `update_plan` only when the zone actually has it

---

## 1.0.0 — Hardening & Public Release

- [ ] Performance: measure and optimize startup time, first message render, large chat (500+ messages) scroll — fixed the main structural cause of wasted re-renders: `Sidebar`/`ChatPanel`/`MessageThread`/`ChatList`/`ZoneEditor`/`ProjectsPanel`/`SettingsModal` subscribed to the whole zustand store unfiltered, so *any* state change anywhere re-rendered all of them; converted to shallow/per-field selectors, and `UserMessage`/`BotTurnView` are now memoized (with a custom comparator for `BotTurnView` since `groupMessages` rebuilds turn objects each call) so a streaming token only re-renders the turn actually generating, not the whole history. Still open: no virtualization for very long (500+) message lists, and no measured before/after startup or first-paint numbers.
- [ ] Streaming: verify no dropped tokens or UI lag under sustained use — hardened `ChatPanel`'s Tauri event-listener effect to run once (refs instead of a dependency array) so the "stream" listener can never be torn down and re-attached mid-session, closing the only realistic drop window found. Sustained-use soak testing not yet done.
- [ ] Installer: Windows (NSIS or WiX), macOS (DMG), Linux (AppImage)
- [ ] Auto-updater: Tauri updater plugin wired to GitHub releases
- [ ] Cross-platform smoke tests on Windows 11, macOS, and Linux
- [x] Write REQUIREMENTS.md for contributor onboarding — full doc (personas, user stories, functional/non-functional requirements, out-of-scope) grounded in the roadmap principles and the 0.1–0.9 feature set ([REQUIREMENTS.md](REQUIREMENTS.md))
- [x] In-app keyboard shortcut reference — `?` (outside text fields) or the keyboard icon in the sidebar opens a shortcuts modal cataloguing every shortcut wired up in the app
- [x] App-wide keyboard control — a central handler ([useGlobalShortcuts.ts](../src/lib/useGlobalShortcuts.ts)) driven by a single shortcut definition list ([shortcuts.ts](../src/lib/shortcuts.ts), shared with the help modal so the reference can't drift). Ctrl/Cmd+N new chat, Ctrl/Cmd+, settings, Ctrl/Cmd+B toggle sidebar, Ctrl/Cmd+L zone library, Ctrl/Cmd+Shift+P projects, Ctrl/Cmd+K focus the composer, Alt+↑/↓ prev/next chat, Ctrl/Cmd+/ or `?` the reference. Modifier shortcuts fire even mid-typing; the plain `?` is suppressed in text fields. Sidebar open/closed moved into the store (same `ui.sidebarOpen` persistence key) so a shortcut can toggle it; composer focus signalled via a store nonce
- [ ] Clean uninstall: no orphaned files or registry entries

---

## Backlog — unscheduled

- [ ] Code interface: chat window for local models working on codebases; uses RAG from 0.4.3; requires design session
- [ ] Mobile: Tauri mobile target (iOS/Android)
- [ ] Deep research mode: multi-step sourced research using subchats; requires design session before scheduling
- [ ] Zone snapshot/versioning: save zone config at chat creation time so editing a zone does not alter historical context
