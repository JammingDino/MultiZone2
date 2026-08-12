# Pre-release Test Checklist — MultiZone

The manual pass run before flipping `releaseBuild` to `true`. Grouped by area, in
roughly the order a person would actually exercise the app.

**How to use it.** Copy the file (or the relevant sections) into the release PR
and tick as you go. A box is only ticked when the behaviour was *observed*, not
when the code looks right — most of what has broken here compiled cleanly first.
Anything that fails gets an entry in [RELEASE_PLAN.md](RELEASE_PLAN.md) rather
than a note in the margin.

**Scope markers**
- 🔁 **Regression** — a bug that has actually happened. Never skip these.
- ⚙️ **Setup-dependent** — needs a provider, key, or model that not every machine has.
- 🖥️ **Fresh-install only** — meaningless on a dev machine with existing data.

---

## 0. Build & release plumbing

- [ ] `npm run build` completes with no TypeScript errors
- [ ] `cargo test --lib` passes
- [ ] `cargo build --release` completes
- [ ] Version matches across `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`
- [ ] 🔁 Version is *ahead* of the newest git tag (v0.9.9 shipped while the stamps still read 0.9.9)
- [ ] `releaseBuild` is `true` only in the commit intended to publish

## 1. First run 🖥️

Test on a machine (or VM/fresh user profile) that has never run MultiZone.

- [ ] Installer completes without a SmartScreen dead-end (note what warning appears)
- [ ] App launches without a terminal
- [ ] Curated zones pre-install; the zone library shows curated + team sections
- [ ] Built-in skills seed, including `about-this-app`
- [ ] Default file directory resolves to the OS Downloads folder
- [ ] With no provider configured, the app explains what to do rather than erroring
- [ ] Adding one provider is enough to send a first message

## 2. Chat basics

- [ ] Send a message, get a streamed answer
- [ ] Stop mid-stream — generation actually halts
- [ ] Regenerate produces a fresh answer over the whole conversation
- [ ] Edit a user message; edit an assistant message; both persist across reload
- [ ] Copy-as-markdown yields source, not rendered HTML
- [ ] Branch from a message — history up to that point is copied
- [ ] Branch from a *perspective* card, not just the primary
- [ ] Auto-title fires while the answer streams and produces a noun phrase
- [ ] 🔁 **Chat crossover**: two chats each with ≥1 answer, neither streaming — switch A→B→A repeatedly. Each chat shows *its own* answer text every time. (Was: B rendered A's answer; the prompt updated but the body did not.)
- [ ] 🔁 Switching chats does not carry over scroll position, expanded step rails, or an open edit box
- [ ] Long model names truncate in the top bar instead of pushing it around

## 3. Zones, projects, tags

- [ ] Create / edit / delete a zone; save closes the editor
- [ ] Install a zone from the library; install a whole team in one action
- [ ] An installed curated zone that has drifted shows the amber **Update** badge, and updating keeps its id/name/provider/model
- [ ] Export a zone to JSON and re-import it
- [ ] Create a project, assign a directory, move a chat into it
- [ ] Project context injects when enabled and is visible in the header disclosure
- [ ] Tags: create, assign, filter the sidebar by one, toggle a tag's context independently

## 4. Tools

- [ ] Tool list in the zone editor is grouped by category; master and per-category toggles work
- [ ] Approval prompt appears for a dangerous tool and both Approve and Deny are honoured
- [ ] File tools: read, create, edit, move, copy, delete (delete prompts), create folder
- [ ] `find_files` and `search_file_text` return correct paths and line numbers
- [ ] 🔁 **Search consolidation**: the zone editor's Web category lists *only* `smart_search`, `smart_fetch`, `smart_crawl`, `http_request` — no "legacy" search entry, no separate "Read a web page"
- [ ] 🔁 A zone saved before the change (one whose `tools_enabled` still contains `web_search` or `extract`) still has working search and page-reading after upgrade
- [ ] 🔁 Settings → Search shows no provider dropdown, endpoint, or API key field
- [ ] `smart_search` returns results; blocking one engine does not produce a false empty
- [ ] `smart_fetch` reads an HTML page and a PDF; a JS-only page reports *why* rather than returning blank
- [ ] Terminals: start a long-running process, write to it, read incrementally, stop it — and confirm what it *spawned* also dies
- [ ] `update_plan` renders as a checklist; only the newest plan of a run is lifted out of the rail

## 5. Knowledge (RAG) ⚙️

Needs an embedding provider (OpenAI, or Ollama serving `nomic-embed-text`).

- [ ] Index a project directory; document list shows chunk counts
- [ ] Auto re-index picks up an edited file
- [ ] 🔁 **The model actually reaches for it**: in a chat with knowledge enabled, ask a conceptual question the indexed docs answer ("what did we decide about X"). It calls `search_local_files` rather than `list_directory` + `read_file`. (Was: the tool was offered with no prompt-level mention, so it went unused.)
- [ ] The system prompt carries a `# Knowledge` block — check the context meter shows a "Knowledge index" row
- [ ] An exact-string question routes to `search_file_text` instead
- [ ] Retrieved passages produce inline `[n]` markers and a Sources list

## 6. Multizone / sub-agents

- [ ] Start a session with a leader and ≥2 sub-agents
- [ ] Leader fans out in one message (sub-agents run concurrently, not queued)
- [ ] Stack trace renders the call tree; expanding a node loads that transcript
- [ ] Stack trace survives a reload
- [ ] A subchat is enterable and accepts a message directly
- [ ] Cancelling the parent cancels the background sub-agents
- [ ] 🔁 **Sub-agent approval reaches the user**: give a sub-agent a tool needing approval, stay in the leader chat. An amber banner names the waiting chat with a Review button, and the sidebar row shows the shield marker. (Was: invisible until it timed out and auto-denied ~5 min later.)
- [ ] Teamwork: two sub-agents on one tree, `claim_files` blocks the conflicting write

## 7. Voice ⚙️

- [ ] Dictation: push-to-talk and toggle modes both commit a transcript
- [ ] Read-aloud plays, pauses, resumes, stops
- [ ] Hands-free mode loops; speaking interrupts playback (barge-in)

## 8. Export & data

- [ ] Markdown export: frontmatter correct, sub-agent conversations nested
- [ ] PDF export: theme matches, one continuous page, tool calls and diagrams present
- [ ] Markdown mirror on: a chat writes a `.md`; an external edit to that file flows back
- [ ] Settings export → import on a second profile reproduces zones, skills, MCP servers
- [ ] Database stats load; vacuum runs

## 9. Updates 🖥️

Needs two builds: install version N, then publish N+1.

- [ ] Settings → Data → Updates shows the running version
- [ ] "Check for updates" reports up-to-date when it is
- [ ] With a newer release published, the update is detected and its notes shown
- [ ] Download shows progress and completes
- [ ] Restart lands on the new version
- [ ] 🔁 The published release actually contains `latest.json` (missing signing secrets produce installers but no manifest — the failure is silent and only visible to already-installed users)
- [ ] Settings, chats, zones, and skills all survive the update

## 10. Uninstall 🖥️

- [ ] Uninstaller removes the program directory
- [ ] No orphaned registry entries under the app identifier
- [ ] User data left behind is documented (it is deliberately kept — confirm *where*)

## 11. Cross-platform

- [ ] Windows 11 — full pass
- [ ] macOS — launch, send a message, use file tools
- [ ] Linux (AppImage) — launch, send a message, use file tools

## 11b. Planning & task control (0.12.x)

- [ ] Turning "Plan first" on in the new-chat menu opens a chat already in plan mode
- [ ] In plan mode, a request that would write refuses to write: the model reads and asks instead, and the tool list it is offered contains no mutating tool
- [ ] A model asked to do something large calls `enter_plan_mode` itself, and says why
- [ ] `exit_plan_mode` ends the turn and shows the plan card — the model does not also ask "is this plan ok?" in prose
- [ ] The plan card reorders, edits, strikes and adds steps; "Approve my version" runs the edited steps and the model does not reinstate what was removed
- [ ] "Keep planning" leaves the chat in plan mode and the next message revises the plan
- [ ] The approved plan renders as a live checklist and ticks off as the turn works
- [ ] A step that fails is marked with its reason and the run continues or stops deliberately — not silently
- [ ] Striking a step mid-run is honoured at the model's next step
- [ ] "Stop after this step" finishes the step in flight and reports, rather than cancelling it
- [ ] Closing and reopening the chat still shows the plan and its state
- [ ] In a Multizone run, the leader's plan and each sub-agent's render in one tree
- [ ] Replay shows the turn's tool calls, any declined approval, any failure, and the plan decisions, in order
- [ ] Exported Markdown and PDF both carry the Session log

## 12. Performance

- [ ] Cold start time recorded: ______
- [ ] Time to first token recorded: ______
- [ ] A 500+ message chat scrolls without stutter *(known gap: no virtualization yet)*
- [ ] A long sustained stream drops no tokens
- [ ] Memory footprint after an hour of use is stable

---

## Sign-off

| | |
| --- | --- |
| Version | |
| Date | |
| Tester | |
| Platforms covered | |
| Known issues accepted | |
