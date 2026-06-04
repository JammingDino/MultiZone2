# MultiZone – Feature Roadmap

Features discussed in design sessions, ordered roughly by recommended build sequence.

---

## Done

- **Configure Zones panel** – two-pane management modal (list + editor) opened from sidebar button
- **Default zone for new chats** – star any zone; new chats open with it pre-selected (persisted via backend settings)
- **Zone icons** – 87 curated Lucide icons across 8 categories, searchable picker with live preview
- **Zone accent colors** – per-zone hex color with 12 presets + custom picker; color shown in zone avatars, ZonePicker button, and bot message avatar

---

## Next Up

### 1. Projects – Folder model

Chats grouped into named folders. Each project carries a default zone and optional shared context.

**Data model additions:**
- `projects` table: `id, name, icon, accent_color, default_zone_id, created_at`
- `chat.project_id` FK column (nullable; no project = ungrouped)

**UI:**
- Sidebar: project folders collapse/expand above the flat chat list
- "New project" button alongside "New chat"
- Clicking a project shows its chats; clicking a chat outside a folder shows all ungrouped chats
- Project context panel: system prompt addition, attached files that inject into every chat in the project

**Context rules:**
- Project context is **off by default** per chat – user explicitly enables it per conversation
- A toggle in the chat header: "Include project context" (on/off, persists per chat)

---

### 2. Project Tags

Cross-cutting labels that carry their own context snippets. A chat can have multiple tags.

**Data model additions:**
- `tags` table: `id, name, color, context_snippet`
- `chat_tags` join table: `chat_id, tag_id, context_enabled` (enabled = false by default)

**UI:**
- Tag chips on chat items; tag manager accessible from project panel
- Chat header shows active tags; toggle context inclusion per tag individually

**Context injection:**
- When a tag's context is enabled for a chat, its `context_snippet` is prepended to the system prompt

---

### 3. Multi-zone Chats – Perspective Mode

Send the same message to multiple zones simultaneously. Useful for comparing model answers or getting different angles on a question.

**UX design:**
- Chat header gains a "Zones" panel button showing active participants
- Each zone responds independently; responses rendered as a tabbed or side-by-side layout below the user message
- One zone is marked as "primary" (its response anchors the conversation history)
- Other zone responses are "perspectives" – read-only, not fed back into context unless explicitly promoted

**Data model additions:**
- `chat_zones` table: `chat_id, zone_id, role` (role = `primary` | `perspective`)
- Messages gain a `zone_id` column (which zone produced this assistant turn)

**Key decision already made:** primary zone response = the canonical next message; perspective responses are collapsible panels beneath it

---

### 4. Multi-zone Chats – Delegation Mode (Leader + Subzones)

The leader zone can autonomously dispatch tasks to subzone agents and incorporate their results.

**Architecture:**
- Delegation is modelled as a **tool call** the leader emits: `delegate_to_zone(zone_id, task, context_mode)`
- `context_mode` options: `full` (whole conversation), `task_only` (just the task prompt), `summary` (leader-authored brief)
- Backend intercepts the delegation tool call, runs the subzone in its own loop, injects the result back as a tool result into the leader's context
- Leader gets one final pass to synthesise before responding to the user

**UI rendering:**
- Delegation trace shown collapsed by default, styled like the existing thinking/reasoning block
- Expand to see the full multi-turn subzone conversation (thread-within-thread)
- Each subzone message shows the subzone's avatar and accent color for immediate identification
- Users can explore and scroll multi-turn subzone conversations inline

**Key decision already made:** delegation visibility = collapsible like thinking, NOT hidden behind a separate view; zone colors make multi-agent threads readable at a glance

---

## Later / Backlog

### Zone versioning / snapshots
Save a snapshot of a zone's config at the time of a conversation so editing a zone later doesn't alter historical context interpretation.

### Shared zone library
Export/import zones as JSON files; eventually a shareable link format.

### Project-level memory
A persistent "memory" document per project that is always injected (or summarised) into new chats in that project.

### Delegation loop controls
- Max delegation depth (prevent infinite loops)
- Per-zone turn budget for subzone calls
- "Human in the loop" pause points where the leader asks the user before delegating

### Search across chats
Full-text search over message content, scoped to a project or tag.
