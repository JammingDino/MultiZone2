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

- [ ] Tags tab in ProjectsPanel: create, edit, delete tags (name, color, context snippet)
- [ ] Tag chips on chat items in sidebar
- [ ] Assign tags to a chat from the chat header (tag picker)
- [ ] `manage_tags` tool: verify it creates tags and assigns them correctly; confirm it is available in relevant default zone configurations
- [ ] Per-tag context toggle in chat header (enable/disable each tag's snippet independently)
- [ ] Filter sidebar by tag: clicking a tag filters the chat list
- [ ] Multiple active tags inject all their snippets independently

### 0.2.3 — Zone library

- [ ] Zone library panel: browsable list of curated and user-saved zones
- [ ] "Save to library" button on any zone — saves a snapshot of current config
- [ ] "Install from library" — creates a new zone from a library entry; duplicate detection by name
- [ ] Curated default zones presented here rather than seeded invisibly on first run
- [ ] Base zone for Quick Chat is selected from the library or the user's zones (Settings → Chat)
- [ ] Export zone as JSON file; import zone from JSON file
- [ ] Library zone card shows: icon, accent color, system prompt preview, enabled tools

---

## 0.3.x — Context & Knowledge

### 0.3.0 — Skills

- [ ] Skills data model: `skills` table (id, name, description, content, created_at)
- [ ] Skills panel: create, edit, delete skills — content is freeform markdown
- [ ] Assign skills to a zone in the zone editor (multi-select list)
- [ ] Skill content prepended to system prompt (before the zone's own system prompt) when that zone is active
- [ ] Skills can be toggled per-chat (enable/disable individual skills for a specific conversation)
- [ ] Import skill from a text or markdown file
- [ ] Built-in skill templates: frontend design guide, markdown formatting, JSON output format

### 0.3.1 — Memory

- [ ] Memory data model: `memories` table (id, scope: global/project/chat, scope_id, content, created_at, updated_at)
- [ ] `save_memory` tool: model writes a memory entry, safety level 0 (safe)
- [ ] `read_memory` tool: model reads its own memories filtered by current scope, safety level 0
- [ ] Memory injected into system prompt each turn: global first, then project, then chat-level
- [ ] Memory viewer in settings: browse, edit, and delete entries across all scopes
- [ ] Soft size limit per scope — oldest entries trimmed when exceeded (limit configurable in settings)

### 0.3.2 — Conversation branching

- [ ] "Branch from here" button on any user or assistant message
- [ ] Branching creates a new chat with history up to (and including) that message
- [ ] New branched chat linked to parent in DB (`parent_chat_id`, `branched_from_message_id`)
- [ ] Sidebar: branched chats appear as a collapsible sub-list under the parent
- [ ] Branched chat inherits zone, project, and tag assignments from the parent

### 0.3.3 — Chat interaction polish

- [ ] Live tokens/second counter: displayed in the message footer while the model is generating; shows current throughput as a running figure
- [ ] Fix token counter and elapsed timer for complex tasks: correctly accumulates counts and time across multi-step reasoning and back-to-back tool calls; does not reset or stall between tool invocations
- [ ] Copy response as markdown: copy button on each assistant message; copies raw markdown source (not rendered HTML) to clipboard
- [ ] Edit AI responses: click-to-edit mode on any assistant message; changes saved to DB; an "edited" marker is shown on the message; branching from an edited message uses the edited content

---

## 0.4.x — Research & Sources

### 0.4.0 — MCP (Model Context Protocol)

*MCP is a first-class settings section, distinct from the existing tool config JSON in the zone editor.*

- [ ] Settings → MCP: add, edit, remove MCP server connections (name, transport type: stdio/SSE, URL or command)
- [ ] On connecting a server: fetch tool list and display name, description, input schema for each tool
- [ ] User sets a danger level (safe / moderate / dangerous) per MCP tool
- [ ] MCP tools appear in the zone editor's tools list alongside built-in tools, with their danger badge
- [ ] Per-zone MCP tool enablement: each zone independently enables/disables specific MCP tools
- [ ] MCP tool calls route through the same approval/execution pipeline as built-in tools
- [ ] Server connection status shown in settings (connected / error / disconnected)

### 0.4.1 — OCR & automatic model detection

- [ ] Automatic text-only model detection: identify vision-incapable models by model name or provider capability flags
- [ ] When a vision-incapable model receives an image attachment: run OCR (Tesseract via Rust binding) and send extracted text
- [ ] PDF fallback: if model is vision-incapable and PDF mode is "images", switch to text extraction automatically
- [ ] User-visible indicator when OCR fallback is active in the input bar / message header
- [ ] OCR language hint setting in Settings

### 0.4.2 — Inline citations

- [ ] Web search tool results tag each used snippet with its source URL
- [ ] Assistant messages with web search results render inline citation markers linked to source URLs
- [ ] Citation list at the bottom of the message (collapsible)
- [ ] File attachment references generate citations by filename and page number

### 0.4.3 — RAG / local document knowledge

*Prerequisite for the code interface (post-1.0 backlog).*

- [ ] Embedding provider config in settings: local model (ONNX or Ollama) or API-based (OpenAI embeddings)
- [ ] Document ingestion: add files or folders to a knowledge base; documents chunked and embedded into local vector store (SQLite-vec or similar)
- [ ] Knowledge bases scoped to a project or globally available
- [ ] Zone config: enable a knowledge base for that zone; relevant chunks retrieved and injected before each turn
- [ ] Knowledge base viewer: list ingested documents, chunk count, last updated; re-index or remove
- [ ] Injected RAG chunks shown as a collapsible section in the chat header (transparent retrieval)

---

## 0.5.x — Subchats & Orchestration Infrastructure

### 0.5.0 — Subchat data model & API

- [ ] `parent_chat_id` and `initiated_by_zone_id` columns on `Chat`
- [ ] Sidebar: subchats shown as a collapsible sub-list under their parent chat
- [ ] Local HTTP API: `POST /chats/:id/messages` accepts a `zone_id` as sender (not user)
- [ ] Subchat turns render with the initiating zone's avatar instead of the user avatar
- [ ] Subchats are read-only from the user's perspective (observable but not interactive)

### 0.5.1 — Spawn-subagent tool

- [ ] `spawn_subagent(zone_id, initial_message, context_mode)` tool: creates a subchat, assigns the zone, sends the first message, returns subchat ID
- [ ] `context_mode` options: `full` (whole conversation), `task_only` (just the initial message), `summary` (caller provides a brief)
- [ ] `send_subchat_message(subchat_id, message)` tool: sends a message to an existing subchat and returns the response
- [ ] `read_subchat(subchat_id)` tool: returns the full transcript of a subchat
- [ ] Safety levels: spawn/send = moderate; read = safe
- [ ] Subchat depth limit (default 3, configurable in settings) prevents infinite loops

### 0.5.2 — File presentation

- [ ] HTML output agent zone template: pre-configured to format structured data as clean HTML reports
- [ ] `save_output_file(filename, content, format)` tool: writes output to the chat's working directory
- [ ] Rendered HTML shown inline in the chat as a preview with an "open in browser" button
- [ ] Local file links in HTML output open via Tauri shell open

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
- [ ] Voice I/O: STT input, TTS output
- [ ] Mobile: Tauri mobile target (iOS/Android)
- [ ] Deep research mode: multi-step sourced research using subchats; requires design session before scheduling
- [ ] Zone snapshot/versioning: save zone config at chat creation time so editing a zone does not alter historical context
