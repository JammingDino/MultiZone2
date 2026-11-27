# Release Plan — MultiZone

Detailed work items grouped by release. Direction in [ROADMAP.md](ROADMAP.md). Releases before 0.17.x are in [RELEASE_HISTORY.md](RELEASE_HISTORY.md).
`[x]` done · `[ ]` to do · `[~]` partial/built but untested. Items are movable between releases.

---

## Carried over from shipped releases

Open items from 0.1.x–0.16.x, whose full entries are in [RELEASE_HISTORY.md](RELEASE_HISTORY.md). Mostly runtime tests of features that shipped with their automated tests passing.

- [ ] **0.2.4** — Right-click actions on the chat sidebar's zone references — *follow-up if wanted*
- [x] **0.9.16** — Measure it: frame timings for one stream and for four, before and after, on a long answer — the fix is reasoned from where the cost is, not yet from a profile — *measured 2026-11-28, after only (a pre-0.9.16 build was not rebuilt for the "before"): ~2,000-word synthetic answers (prose, code, tables, Mermaid) streamed a word per 5 ms by the mock (`mix=<n> tokens=2000 delay=5`), rAF gaps recorded in headless Chromium on the Mac mini. Idle 60 fps, p95 17.8 ms. One stream: 60 fps, p95 17.4 ms, p99 18.4 ms, worst 19–34 ms, no long animation frames. Four zones streaming together (~9.8k chars each): 59.8–59.9 fps, p95 17.5–17.6 ms, worst 34–50 ms, at most one long frame (1 ms blocking). Not measured in the Tauri WKWebView itself*
- [x] **0.10.1** — Runtime-test the whole path: a real turn that edits a file, then revert it from the transcript — passed 2026-11-28 after two fixes: the primary answer's checkpoint never linked to its message, so no Revert block showed at all, and after a revert the file read as "edited since"
- [x] **0.12.0** — Runtime-test the whole path: ask for something large, watch the mutating tools disappear, edit the plan, approve it, and confirm the executing turn is held to the edited steps — passed 2026-11-28 after a fix: the tools offered dropped write/edit/delete/move/spawn in plan mode, but the approved plan never reached the executing turn's prompt (filed under the zone, looked up under none); now it does, edits included. Approving over the API needs the follow-up system turn the UI sends, which the route does not say
- [x] **0.12.1** — Runtime-test: run a plan of several steps, strike one mid-run, add one, and stop after a step — passed 2026-11-28 after two fixes: stop-after-step never found the primary answer's plan, and a mid-run edit never reached the running model (now passed on as a note at the next step)
- [ ] **0.12.1** — Runtime-test: ask for a plan in prose with no button to press, and confirm the model enters plan mode via `enter_plan_mode` — 2026-11-28: needs a real model's judgement, so not run (only mock providers on the Mac mini); `enter_plan_mode` is offered and its entry approval follows the plan-entry setting
- [x] **0.12.2** — Runtime-test: run an agentic turn with an approval declined and a tool failure, then replay it — passed 2026-11-28 (scripted mock, declined over the API): the replay shows the decline, the failure and the end of the turn in order; the chat's step strip counts the declined step as failed ("2/2 steps failed"), noted for review
- [x] **0.12.3** — Runtime-test: launch in light mode with a 22px interface size and a custom font, then replay a turn that ran tools — passed 2026-11-28 in the browser window (Lora, 22px root): chat and replay both legible; the native window not checked
- [ ] **0.13.4** — **Runtime-test:** send an image with no text to a vision model — the title names what is in the picture, not "Image Attachment"
- [x] **0.13.4** — **Runtime-test:** off by default on an existing install, and the toggle changes the exported document — *passed 2026-11-28: stored as `false` on this install; a PDF export from the sidebar's Export… → PDF ends at the conversation with it off, and with it on (set over `PATCH /api/settings/app_settings`) carries the Session log table timed from the first event*
- [x] **0.14.0** — **Runtime-test:** launch with two servers configured and one deliberately broken — the good one shows connected before the first message, the broken one shows its error in Settings rather than during a run — passed 2026-11-28 with a good and a broken stdio server; the broken one's error now shows in its row, not only on hover
- [x] **0.14.1** — **Runtime-test:** a model told to read the same file until it succeeds is stopped and explains itself; a background sub-agent doing it marks its node in the tracer — passed 2026-11-28 (scripted mock): stopped after 3 identical `read` failures and said why; a background sub-agent doing it is stopped too, and its node in the stack trace carries the loop mark. The explanation is live-only — reopening the chat shows only "3/3 steps failed" (the replay keeps the stop line)
- [ ] **0.14.1** — **Runtime-test:** a zone pointed at a dead provider with a fallback configured answers from the fallback, and the transcript says which zone answered — 2026-11-28: answers from the fallback, and the replay names it; the main thread does not say a fallback zone answered, and failover from a refused localhost port took ~13 s
- [ ] **0.14.2** — *Deferred to 0.14.3, with the project-root work:* "edit inside the project root" as a **path** constraint. The category answers whether editing is auto-approved, not where — and a path policy wants the same treatment as the shell lists rather than a boolean bolted onto a category
- [x] **0.14.5** — **Runtime-test:** a zone with `{project}` in its edit-allow list writes inside the project without prompting, is asked before writing to the desktop, and is refused outright inside `.git` — *passed 2026-11-28 with a mock zone (`editAllow: ["{project}"]`, `editDeny: ["{project}/.git"]`, autoApproveLevel `all`) and `~/mz-outside` standing in for the desktop (to avoid the macOS folder-access prompt): inside written silently, outside asked and then written, `.git/config` refused untouched. The deny needs `{project}/.git` in the list — nothing denies `.git` by default. Found and fixed on the way: with the outside folder not granted, an approved absolute path was re-read under the project and written to `<project>/Users/ai/…`*
- [x] **0.14.5** — **Runtime-test:** a repository carrying an `AGENTS.md` has it in the context meter's breakdown before the first message, and a rule in `src/generated/AGENTS.md` arrives only once the model reads a file there — *passed 2026-11-28 (mock provider, requests dumped): a fresh chat's `GET /api/chats/:id/usage` lists "Project instructions" (113 tokens) before any message, and it goes when the file is moved away; the root rule is in every request, and the nested rule is absent until the model reads `src/generated/gen.ts`, then arrives as a "Directory instructions" message*
- [ ] **0.14.5** — **Runtime-test:** a project with `npm run typecheck` configured, given a task that breaks the build, sees the error and fixes it before answering — and the same turn reports a pass when it does not — 2026-11-28: the app's half passes with a scripted mock (project `lintCommand: npm run -s typecheck`): an edit that breaks it gets a "Project checks … did not pass" note in the same turn carrying the compiler line, and a further step to repair; a clean edit gets "They passed … exit 0". Whether a real model then fixes it is left for a real-model run
- [ ] **0.14.6** — Runtime-test the whole path: ask for something that needs research, confirm the model asks questions first, watch it search and draft step by step, read the written `.md`, edit a step in the card, approve, and confirm the executing turn is held to the detail and not just the headings
- [x] **0.14.6** — Runtime-test the scrolling fix specifically: a plan of 20+ steps, the wheel over the card and over the task panel, and the composer still reachable throughout — *passed 2026-11-28 with a 22-step mock plan: the wheel over the pending card scrolls its overview list; after approval the Plan tab's step list (at a 560px-tall window) scrolls to its end; the composer stays on screen in both.*
- [ ] **0.14.6** — Runtime-test reachability across zones: ask "plan this out first" in a Quick chat, in a read-only zone and in a zone with file tools, and confirm all three enter plan mode without the tool being named. Then check the negative — "what does the release plan say about 0.13?" must not propose a plan
- [x] **0.15.0** — Runtime-test against a real history: search a word that appears in a sub-agent's chat, confirm the result names the conversation it lives under, and confirm the jump lands and flashes — passed 2026-11-28; the jump missed when another chat was open in a tab, and in long chats, both fixed
- [x] **0.15.0** — Runtime-test the backfill on an existing database — the migration indexes what is already there, and that path never runs in a fresh test DB — passed 2026-11-28 on a copy of a real database: 2525 rows, none differing from the trigger-built index
- [ ] **0.15.1** — Runtime-test: ⌘K from a chat, from the home screen and with Settings already open; confirm Escape closes only the palette, and that ⌘J still reaches the composer — 2026-11-28: passes from a chat, from home and with Settings as a tab (scripted browser); over the Settings *dialog* ⌘K is blocked on purpose since 0.21 (a dialog owns the keyboard) — open question whether the palette should be the exception
- [x] **0.15.2** — Runtime-test: fork a chat that has two sub-agent runs and an earlier branch at each scope, and confirm the tree that arrives matches what was asked for — *passed 2026-11-28 after two fixes, over the API with a mock zone: three turns, a sub-agent run in turns one and three, a branch at turn one and one at turn three, forked at turn two. This thread → turns 1–2 alone; with branches → turns 1–2, the turn-one branch and the turn-one run; everything → all of it. Fixed on the way: "with branches" also carried the run turn three spawned, and a continuation (nested) fork with branches or everything copied itself into itself until the stack overflowed and the app aborted*
- [x] **0.15.3** — Runtime-test against a server that offers both — the renderers are tested against the shapes the spec allows, but nothing here has met a real server yet — *passed 2026-11-28 against a local stdio server written to the spec's shapes (two resources, one text and one PNG; one prompt with a required and an optional argument): all four API routes answer, the binary is named rather than inlined, a server that cannot answer lists nothing, and in the composer `/style` and `/release` list the resource and the prompt and picking each fills the composer. Gaps: picking a prompt never asks for its arguments, so a required `version` reaches the server empty; reading a missing resource is an HTTP 500 rather than a 4xx; a skill whose description mentions the query ranks above an MCP entry whose name matches it*
- [ ] **0.15.4** — **The editor.** Writing a run in the app — name, template, parameter rows, zone — plus export and import as one file, which is the "shareable" half of the item and the reason parameters exist rather than a saved prompt
- [x] **0.15.4** — Runtime-test: save a run with two parameters, run it from the palette, confirm the staged prompt is filled and the chat opened in the right zone — *passed 2026-11-28: a run saved over the API with two defaulted parameters and a pinned zone opens a new chat in that zone with the filled prompt staged, not sent. The palette always takes the defaults — there is no form to change them before running; that belongs with the editor item below*
- [ ] **0.15.4** — Quick assistant — a global-shortcut mini window over the base zone, the fast end of the fast-to-thorough spectrum the roadmap describes

---

## 0.17.x — The phone as a second window

Notes and design in [CONNECTIVITY.md](CONNECTIVITY.md#part-3--the-phone-as-a-second-window), including a build note on what the design got right and the four things it did not anticipate.

### 0.17.0 — Reachable, and only by devices you named

- [x] LAN bind as its own switch, separate from `apiEnabled` — putting the app on the network is a different decision from switching the API on
- [x] Bind one chosen interface, never `0.0.0.0`; a vanished interface is a named bind error, not a quiet fall back to loopback
- [x] `BindState` carries the address, so "switched on" and "on the network" stop being the same claim
- [x] Pairing: a six-digit code, single-use, expiring in three minutes, burned after five wrong guesses, and only while the desktop has the dialog open
- [x] Per-device tokens; the registry keeps a SHA-256, never the token
- [x] Revoke per device; forget refuses a device that is still live
- [x] Every pairing attempt logged — it is the only unauthenticated write on the surface
- [x] mDNS advertisement, never fatal (a blocked multicast must not lock out a phone that knows the address)
- [x] The pending-approval queue is readable and answerable over the API, with a countdown
- [x] Settings → API → Remote access: the switch, the interface picker, the code, the QR, the device list
- [~] The token lives in the WebView's `localStorage`, not the platform keystore

### 0.17.1 — The transport

- [x] `GET /api/events` — every event a window would receive, bridged from the same `app.listen`, with an explicit forwarded list
- [x] `src/lib/remote/transport.ts` implements `invoke` and `listen` over HTTP + SSE; `src/lib/tauri.ts` changed by two import lines
- [x] The command → route map is generated from `COVERAGE`, with `--check` in `npm test`
- [x] Argument placement is a rule with two stated exceptions, in pure functions with tests
- [x] A sweep over every real call site, which found the greedy `:id` match before a user did
- [x] `POST /api/chats/:id/messages` honours `overrideZoneId` / `overrideModel` — it accepted and discarded them
- [x] The Rust drift test reads every `module::command`, not only `commands::`

### 0.17.2 — The shell

- [x] The pairing screen: address plus code, or paste the QR's link and both fill in
- [x] "Can't reach your computer" as a stated reason rather than a spinner
- [x] The approval queue above everything, since the call that is waiting is often not in the chat you are looking at
- [x] Touch targets and safe areas in CSS, scoped to `pointer: coarse` — no component renders differently on a phone
- [x] Every module `#[cfg(desktop)]`; the mobile binary is a WebView with no `invoke_handler`, so there is no second store to go wrong
- [x] Cargo dependencies split by target — an Android build does not compile BoringSSL and an OCR engine
- [x] Android target: network security config for LAN cleartext, `multizone://pair` deep link, per-platform capabilities
- [x] Verified end to end: APK built, installed, launched, pairing screen renders
- [ ] iOS target (the crate is split for it; nothing has been built or tested)
- [ ] Wake-on-LAN, deliberately deferred — the obvious follow-on to "your computer is asleep"

### 0.17.3 — What a real handset showed

Found by installing the APK and using it, not by reading the code.

- [x] The 0.17.2 touch CSS put `min-height` on every `button`, which stretched the Toggle's track and left its knob at the top edge — every switch in Settings rendered as a tall thin capsule. Targets are grown by name now, and the Toggle grows as a whole control
- [x] `coarse:` and `narrow:` Tailwind variants — a touchscreen laptop wants bigger targets at any width, a half-width desktop window wants the layout without them
- [x] Sidebar overlays the chat on a narrow window instead of sitting beside it
- [x] Settings is full-bleed on a phone; its 176px tab rail becomes a scrolling strip
- [x] MCP server cards wrap instead of running off the edge
- [x] Remote access is its own Settings tab, above API — it shipped inside the API panel because that is where it was built, not where anyone looks for it
- [x] The app's own launcher icon, adaptive icon included, with a `--check` in the test suite so a re-init cannot quietly restore Android's template
- [x] An APK in every release, built on Linux (Windows refuses the jniLibs symlink without Developer Mode); signing opt-in via secrets so a missing keystore cannot take the Windows release down with it

### 0.17.4 — Pairing that asks, and a phone that remembers

- [x] The desktop is *armed* first; the code exists only once a named device asks for it, and appears with "<name> at <address> wants to connect" beside it
- [x] `POST /api/pair/request` — unauthenticated, and unable to produce a code on its own. An unarmed desktop refuses; a desktop already showing a code for someone else refuses too, so a second device cannot cancel the first one's pairing by asking
- [x] Discovery from the phone: a /24 sweep of the unauthenticated health check, in the mobile shell's one command. Not mDNS — Android needs a MulticastLock and consumer Wi-Fi blocks client multicast on exactly the networks people use
- [x] Saved computers, with switching, and forgetting that says it is local-only
- [x] Retry and Switch on the offline banner — nothing re-entered
- [x] Dictation from the phone: the WebView captures, the desktop transcribes. `POST /api/transcribe`
- [x] `mergeAppSettings` drops `undefined` — `{ x: cond ? true : undefined }` was erasing `x`, which clobbered `apiEnabled` and `apiToken` and would have stopped the API starting at the next launch
- [ ] Live partial transcripts while dictating from a phone (would re-upload the whole recording every tick)
- [ ] Speech playback of answers on the phone

### 0.17.5 — The envelope that erased your settings

*The 0.17.4 handset feedback, second round. Three of these are one bug wearing different clothes: something that was silently the wrong shape, with no test positioned to notice.*

- [x] **Data loss, fixed and disclosed.** `GET /api/settings/:key` answers `{"key":…,"value":…}` where the command returns the value. The transport handed the envelope to `JSON.parse`, every settings read from a phone threw, the store fell back to `DEFAULT_APP_SETTINGS` — and the next write merged against *those* and persisted them over the desktop's real settings. Appearance, the dictation provider and endpoint, the base zone, the approval allow-lists: all replaced by defaults, from a device that had never successfully read them
- [x] `Coverage::Route` gains a `-> field` suffix; the generator carries it into the route map and the transport unwraps it. Seven routes declare one
- [x] **A drift test that reads the handlers**: any handler answering a JSON object literal, wired to a route a command claims, must declare which key holds the value. Removing an annotation fails the build
- [x] **The store refuses to write state it could not read.** Both `app_settings` and `theme` are whole-object writes, so one made blind is an erase, not a lost preference. `appSettingsLoaded` / `themeLoaded` are set on success only — never in a `finally` — and Settings shows a banner saying changes will not stick. This rule alone would have contained the bug above
- [x] **Android back.** The shell's handler is `webView.canGoBack()`, which in an SPA that never touches history is always false — so back closed the app from everywhere. `useBackDismiss` pushes a history entry per layer: modals, the command palette, the sidebar drawer and the pairing wizard step backwards, and only the root exits
- [x] **A way back to the connection screen.** Pairing was a one-way door. Settings → Phone & remote names the computer this device is paired with and offers *Switch computer*, keeping every token
- [x] **Reconnecting no longer sits there.** `retryNow()` was clearing the listener registrations, so a reconnect that *succeeded* left the app deaf to it for good — the retry button broke the thing it was meant to fix. Plus an 8s connect deadline instead of Android's 60s+ TCP timeout, a 10s backoff cap, and an immediate retry when the app is foregrounded or the network returns
- [x] **The computer prepares the audio, it does not relay it.** Dictation from the phone sent `audio/webm;codecs=opus` straight through, while the desktop's own capture path has always produced 16 kHz mono WAV — which is what a local whisper or MLX server decodes. `transcode.rs` converts uploads with ffmpeg before they reach the provider, in-memory, never touching disk. Optional: without ffmpeg the bytes pass through and the error names what is missing
- [x] `100vw` is not the drawable width. The app root was `h-screen w-screen` inside a body padded by the safe-area insets, so in landscape everything was shifted by the cutout and the right edge of every full-width row fell off the screen. `h-full w-full`
- [x] Checkboxes and radios grow their *tap target*, not their box — they were in the same `min-height` rule the Toggle regression came from, and stretched into capsules with the tick pinned to the top
- [ ] Bundling ffmpeg (~80 MB per installer for one feature); using the system one instead

---

## 0.18.x — Runs nobody is watching

The point of a long agentic run is not to sit watching it, and five things
still assumed someone was: closing the window ended the run, nothing could
start a run on its own, a long run either overflowed or paid a model to
summarize itself, and Stop did nothing until the model had spoken.

### 0.18.0 — Running in the background, on a clock, in a context that stays small

**Close to tray**
- [x] The close button (and Alt+F4) hides the window; `CloseRequested` is handled in Rust, so every close path agrees
- [x] Tray icon: left-click shows the window, menu has Show and Quit
- [x] Only hides when the tray icon actually exists — a platform without one still quits
- [x] `closeToTray` setting, on by default (Settings → Chat → Closing the window)
- [x] Single-instance plugin: a second launch shows the running copy instead of opening the database twice
- [x] Seen on Windows: hide, restore from the icon, quit from the menu, relaunch while hidden
- [ ] macOS / Linux tray behaviour (unbuilt here)

**Stop, straight away**
- [x] The request, every stream read and the Smart-routing call are raced against the cancel flag — Stop works during prefill and before any response
- [x] The window settles the turn locally (`stopChat`) instead of waiting for the backend's `cancelled`
- [x] The queue is dropped at the moment of the stop (`cancel_chat`), so a message sent while the old turn unwinds is delivered, not discarded
- [x] The HTTP API's cancel goes through the same function — it used to only flip the flag, leaving approvals and background sub-agents running
- [x] Seen against a slow local prefill: Stop, type, send, and the new message runs once the old turn has let go

**Smart compaction**
- [x] Rule-based rewrite before `smart_compact_through`: superseded results dropped, tool output trimmed head+tail, long tool inputs hidden, old thinking stripped
- [x] Deterministic and request-only, so the prefix cache survives and nothing on screen changes
- [x] `smart_compact` tool in the compact group (safe); the compact button under the composer offers it and a summary
- [x] Auto-compaction trims first and summarizes only if still over the window; an overflow retries trimmed, then summarized
- [x] A compaction mid-turn is picked up at the next step
- [x] The meter subtracts what the rewrite removes (`trimmedTokens`)
- [x] Knobs in Settings → Chat → Smart compaction
- [x] Measured on a real long coding chat: tokens before/after, and whether the model re-reads what was trimmed

**Rolling context**
- [x] Per-chat limit (`rolling_context_tokens`, inheriting `rollingContextTokens`); past it the cutoff jumps to 70% of the limit, on a unit boundary
- [x] The latest user message is never forgotten
- [x] `mark_important` / `forget_important`, offered automatically while a chat rolls; notes shown at the top of the kept history, and a pinned tool result that was forgotten comes back as text
- [x] A standing system-prompt section against re-verifying finished work
- [x] Rebuilt mid-turn when a long turn outgrows the limit
- [x] Per-chat control and the notes list in the compact popover; global default in Settings → Chat
- [x] Watched on a long agentic run: does the model mark what it verified, and does it stop re-running the same tests

**Dictation on this computer**
- [x] Settings → Dictation: pick a model, *Download and use*; whisper.cpp's server (pinned v1.9.2) and a ggml model (pinned repo commit), both SHA-256-verified, cancellable, with progress
- [x] Started on the first transcription through the existing `stt_config` (sentinel provider `__local__`) with an OpenAI-shaped inference path, so mic, live partials and uploads all work unchanged; stopped after ten idle minutes and on quit; starts serialized
- [x] Windows x64 and Linux prebuilt; a `whisper-server` on PATH elsewhere
- [x] Verified end to end against the real binary (opt-in test: `MULTIZONE_WHISPER_TEST_DIR=… cargo test --lib local_stt -- --include-ignored`)
- [x] Seen in the app: download, dictate, idle stop, dictate again
- [x] GPU on Windows + NVIDIA: the CUDA 12.4 package (670 MB, bundles cuBLAS and the runtime — only a driver needed), offered when `nvcuda.dll` is present, toggle `sttLocalGpu`. Runs on the CPU with `-ng` or when CUDA cannot start, so one download covers both. Measured: Large v3 Turbo, 11 s clip, ~16 s CPU → ~0.13 s GPU (RTX 4070 Ti SUPER)
- [x] The CUDA 11.8 package was tried and rejected: it does not bundle cuBLAS, so its GPU backend fails to load silently without a CUDA toolkit
- [ ] AMD / Intel GPUs (whisper.cpp publishes no Vulkan build) and Linux GPUs
- [x] Deleting the GPU engine from the UI to get the 670 MB back — built in 0.19.0: Settings → Dictation, two clicks; every `<release>-cuda` folder goes, models and the CPU engine stay, and the GPU switch turns off
- [ ] A child process is not reaped if the app crashes rather than quits (a Windows job object would)

**Scheduled runs**
- [x] `scheduled_runs` table: once / every N minutes / daily / weekdays; new chat or append to a chat; optional chat to report on
- [x] A 20-second scheduler; rescheduled before firing; a run missed while closed fires once
- [x] Fires through `run_send_entry`, with a hidden note saying it came from a schedule
- [x] Settings → Schedules: create, edit, enable, run now, delete, last run and last error
- [x] `schedule` tool group — `schedule_run` dangerous (always asks), defaults to once in this chat; list (safe) and cancel (moderate)
- [x] API: `/api/schedules`, `/api/schedules/:id`, `/api/schedules/:id/run`
- [x] Seen firing from the tray with the window hidden
- [x] A notification when a scheduled run finishes — 0.18.1, *Run finished*

### 0.18.1 — Visual coherence: nothing breaks the flow

A pass over everything a person sees between sending a message and reading
the answer. The bar: clean, minimal, one visual language, and no identifier
on screen that only the computer can read. Version is already 0.18.1 (CI
bumped it after the 0.18.0 release).

**1. Notify on every blocking moment**

Runs now continue with the window closed, so "the agent is waiting for you"
has more than two causes. A run that has finished, failed or been stopped by
a guard is blocked on the user as surely as an approval is.
- [x] Settings → Chat → Notifications: *Needs my input* (approvals, questions, and now plans) and *Run finished* (final answer, error, loop guard, spend limit) as two toggles, both on by default
- [x] The finished notification carries the chat title and the first line of the answer
- [x] Sub-agents and perspectives never notify on their own finish — only the run the user started
- [x] A Stop the user pressed never notifies; a question is announced once, not again as "finished" (`scripts/notify.test.mjs`)
- [x] Tool names in notifications read as labels, not ids
- [x] Seen from the tray: a scheduled run finishing with the window hidden raises one toast

**2. Sidebar**
- [x] One row style (h-8, text-sm) for projects and chats, and one trailing chevron that rotates
- [x] Chats lose their per-row icon; branches and sub-agents hang off a split bar, coloured by the driving zone for a sub-agent; tag dots sit inline
- [x] Projects show their five most recent chats, then *Show N more*
- [x] New chat and Search are the same height and outline; New project moves to the Projects heading
- [x] Tags filter from a popover beside Search listing every tag
- [x] Zones and Settings live in a footer in both states; the collapsed rail keeps New chat and Search where the open sidebar has them

**3. Settings and Configure Zones**
- [x] Configure Zones uses the Settings rail (`common/NavRail.tsx`): Library and New zone are rail items, installed zones are rail rows, team names are group labels
- [x] Every help paragraph cut to a short line, or removed where the title says it — Settings, the zone editor and the project editor (~14k characters)
- [x] Chat split in three: Chat keeps the chat basics; Runs (task length, rolling context, compaction, spend limit, repository map, sub-agents) and Approvals move under a new Agents group with Schedules
- [x] ~~A shared `SettingSection` component~~ — dropped: the tabs already share the same heading and spacing classes, and a wrapper would only rename them
- [x] Configure Zones is a Settings page: its library, New zone and installed zones nest under "Zones" in the one rail, and every way of opening it (sidebar, Ctrl+L, zone picker, "edit this zone") lands there
- [x] Settings pages have bottom padding, so the last section is not flush with the panel's edge

**4. Composer and in-chat chrome**
- [x] Two rows: the prompt spans the box and grows to 40% of the window; past a few lines an expand button opens a 70% editor for reviewing it
- [x] Attach, options and conversation mode sit in a quiet row under the prompt, mic and send on the right
- [x] Compaction moves into the Context panel under the window meter (`Workspace/CompactControls.tsx`); the composer keeps nothing it does not need
- [x] No rule above the composer: it ran across the window a couple of dozen pixels off the sidebar footer's; the composer's bottom inset now matches the footer's
- [x] Both sidebars animate open *and* closed — the chat sidebar snapped shut, and the workspace panel had no animation either way

**5. Audio and video as input**
- [x] Audio and video go to the model as `input_audio` / `video_url` parts when the model takes them
- [x] Capability by name heuristic (omni, audio, voxtral, gemini, *-vl…), mirrored in `ocr.rs` and `lib/media.ts`, with Audio input / Video input overrides beside Image input
- [x] Audio falls back to transcription for a model that can't hear; video is refused with a reason, or transcribed when its container is also audio (mp4, webm)
- [x] A part the chat's current model can't take becomes a line of text in the request, so switching zones never poisons the history
- [x] The user turn shows a player; edits carry the file; token estimates count the parts
- [x] Chat exports (Markdown/PDF) mention the recording
- [ ] Seen against a real Qwen-Omni / Gemini endpoint: a song, and a short clip

**6. Graph tools (`plot_function`, `render_graph`)**
- [x] `plot_function`: expressions tokenised and normalised in the tool (`**`, `Math.`/`np.`, `ln`, `pi`, `e`, `2x`, `y = …`); y range optional (fitted to the 2nd–98th percentile); parametric, polar and implicit curves
- [x] An unknown name or unbalanced bracket comes back as a tool error the model can fix (`plot_tests` in `render_graph.rs`)
- [x] Chart palette, a legend, the column's width, smooth lines, equal scales for geometric plots, and no wheel-zoom capturing the chat's scroll
- [x] The group reads as "Charts & graphs"

**7. Context panel and MCP legibility**
- [x] System prompt and tool schemas are rows that open into their parts, and a tool group opens into its tools (the backend now reports each function under its group)
- [x] Groups use their settings label; MCP groups use the server's name
- [x] MCP tool calls show the tool and the server's name in the step header, running line and approval card; the qualified id stays on hover. Servers load at startup, not only once Settings → MCP is opened

**8. Thinking that works through a gateway**

On a router like OpenCode Go the app guessed one parameter, the gateway
refused it, and thinking was dropped for good with nothing to configure.
- [x] Thinking is on by default: new zones, library installs, imports that do not say, and Quick chat
- [x] Four hosted shapes — `reasoning_effort`, `reasoning: {effort}`, `thinking: {type}`, top-level `enable_thinking` — and a refused guess falls through to the next, remembered per gateway and model
- [x] The models.dev catalogue's `reasoning` flag settles a model the name heuristic does not know
- [x] Zone editor → Reasoning → Parameter: pick the shape by hand, stored per model; a chosen shape is sent as chosen and never swapped
- [x] Seen against OpenCode Go: which shape its models accept, and whether it refuses or silently ignores the others

Verified in a browser harness (sidebar both states, settings and the Zones page, the zone editor, composer, plots in both themes, context panel, media staging); `tsc -b`, script tests, `cargo test --lib` (438) and `vite build` pass. Not yet run in the Tauri shell — the unchecked "Seen …" items above are that pass.

---

### 0.18.2 — Several chats at once

Shipped without an entry here; recorded from the commits.

- [x] Tabs: several chats open at once, tiling the main column — drag to split into rows and columns, resize the panes
- [x] Drag a chat from the sidebar straight into the tiles
- [x] The thread runs under the composer to the window's edge; side panels have no fixed maximum width
- [x] Settings → Notifications is its own page, and settings pages lose their boxes and use the full width
- [x] Appearance: choose how streamed text arrives, with bursty tokens smoothed; bloom removed
- [x] An MCP tool's image reaches the model as an image, not as base64 text
- [x] The file tree reloads when you switch chats
- [x] v0.18.1's updater manifest points at its installer again, and a released version is never rebuilt
- [x] Seen in the app: four chats tiled, two of them streaming, resized and closed without a lost token

After 0.18.2, CI bumped the version to 0.18.3, which was never released. The work that followed is study mode, a minor release of its own, so the next release is **0.19.0**.

---

## 0.19.x — Study mode, and a lighter app

The first slices of the [study mode backlog entry](#backlog--unscheduled): a project you learn from rather than work in, with answers held to its sources and the material turned into something you can drill. And a pass on what the app costs while nobody is using it, prompted by WebView2 climbing in Task Manager with the window in the tray.

### 0.19.0 — Grounded study, and nothing drawn for nobody

**Study mode**
- [x] A project can be marked for study (migration 049); its chats answer only from the project's sources, cite every claim, and say when the sources don't cover something. Web tools are withheld from the request and refused at dispatch; knowledge search is offered whether or not the chat opted in
- [x] `make_flashcards` — decks with an SM-2 schedule per card (four grades, "Again" back in 10 minutes)
- [x] `make_quiz` — every answer kept; explanation and source shown, restored on reload
- [x] `make_cheatsheet` — one dense Markdown page per topic, editable by the learner and revisable in place by the model (migration 051)
- [x] `study_progress` — due cards, quiz scores, and what the learner keeps getting wrong
- [x] Study tab in the workspace panel: due count, keyboard review session, every deck, quiz and sheet
- [x] A deck, quiz or sheet pops out of the chat into its own tab, as does a project's review session; the chat it came from stays active
- [x] Maths in study sets survives JSON: LaTeX commands eaten by string escapes (`\frac` arriving as a form feed) are put back, and bare LaTeX in short fields is wrapped
- [x] Exports draw decks and quizzes; six routes under `/api/projects/:id/study` and `/api/study/*`, and `study-changed` forwarded to remotes
- [x] Seen in the app: a study project refusing a question its sources don't cover, and citing one they do
- [ ] Seen in the app: a review session through a deck, with "Again" cards coming back
- [x] Seen in the app: a cheat sheet edited by hand, then revised by the model

**Projects the model sets up**
- [x] "New project" and "New study project" from the composer: the model names the project and picks its icon and colour from the opening message, and it gets a folder under the save directory before the first turn runs
- [x] Optionally the model draws an SVG icon (sanitised), kept under "Generated" in the icon picker for any project or zone (migration 050)
- [x] Sources added from the same flow are copied into the folder and indexed
- [x] Seen in the app: a study project started from the composer with a few PDFs, usable on its first message

**A lighter app**
- [x] The webview is told when the window is hidden to the tray or minimised (`background.rs`): it stops rendering and is asked to keep memory low. Every way back — tray, second launch, taskbar, focus — marks it visible again
- [x] Background effects paced: at most 60 fps (a 144 Hz screen drew them 144 times a second), 20 fps behind another window, none while hidden. Measured in a harness: 61 / 20 / 0, and 60 again when shown
- [x] Topography no longer allocates a Path2D per level and a closure per contour cell every frame; the grid stops re-rendering once its parallax has caught up
- [x] The approval queue polled every 2 s for the life of the app; now only while a turn runs or something is waiting. Staged edits are polled only during a turn
- [x] Startup script ~5.9 MB → ~2.3 MB: mermaid (2.9 MB, now split per diagram type), pdf.js and every Prism grammar load the first time they are needed
- [x] The diagram cache keeps the last 64 rather than every diagram of the session
- [x] Settings → Dictation can delete the GPU engine (670 MB)
- [x] Seen in the app: Task Manager with the window in the tray for ten minutes — WebView2 CPU and GPU near zero — then restored from the tray, the taskbar and a second launch, never to a blank window
- [ ] Startup and first paint measured before and after with `perf.ts` (1.0's open performance item)

### 0.19.1 — A subscription as a provider

Claude Code and Codex, already installed and signed in, as providers: no key, billed to the user's Claude or ChatGPT plan. Two presets in Settings → Providers, base URLs `cli://claude` and `cli://codex`.
- [x] `llm/cli.rs`: each request spawns the CLI in print mode, sends the conversation on stdin, and turns its JSON events into the OpenAI chunks the stream consumer already reads, so chat, panels, compaction and titles need no change. Stop kills the process
- [x] Claude Code runs as a model, not an agent: no built-in tools, no MCP, no user settings or hooks, the app's own system prompt (via a temp file — system prompts outgrow Windows' command line), a scratch working directory. A one-word reply costs ~900 prompt tokens, not ~82K
- [x] Codex runs `exec --json`, read-only sandbox, `model_reasoning_effort` from the zone's thinking level
- [x] Token counts, cache hits included, come from the CLI's own usage report
- [x] Tested against the real `claude` CLI through `consume_stream` (`cargo test --lib live_claude -- --ignored`)
- [ ] Seen against a real `codex` install — built from the documented `exec --json` events, not yet run
- [x] The app's tools reach the CLI over MCP but are run by the app. A loopback MCP server lives for each request and only lists the step's tools. When the model calls one, the call comes back as an ordinary tool call and the CLI is stopped at the end of that message, so approvals, tool visuals, checkpoints and the runaway guards all apply exactly as they do with an HTTP provider. Tested live: Claude called an app tool and then answered from its result (`live_claude_tool_call`)
- [ ] Seen in the app: a Claude Code zone through a multi-step tool turn, with an approval prompt in the middle

### 0.19.2 — A subscription that lasts

**Found in 0.19.1:** one agentic chat on a Claude Code zone (Opus) used a whole five-hour window. `chat_usage` said why: 44 requests, 3.35M input tokens, 16% of them cached. Every tool step started a fresh CLI and wrote the whole transcript into one new user message, and the prompt cache matches whole blocks, so every step paid for the conversation again — at the cache-write rate. Used directly, the same CLI keeps one process and caches nearly everything.
- [x] The CLI process belongs to the chat. A tool call waits inside it on the MCP bridge while the app runs the tool (approvals included); the next request delivers the result to the same process, which carries on with its cache intact. Claude Code also stays alive between turns (`--input-format stream-json`), so the next user message goes to the same conversation
- [x] Continued only when the request provably follows on: the same user messages, and after the call only its results (and the step-budget notes, which ride on the last result). An edited or regenerated message, compaction, a steer mid-turn or a different tool set starts a fresh run — always correct, only dearer. Four parked runs at most; an idle one is ended after 30 minutes
- [x] Claude Code is told to allow the bridge's tools (`--allowedTools=mcp__multizone`): the app asks for approval itself, and print mode would otherwise refuse every call
- [x] A failure inside a stream arrives as an `{"error": …}` frame and is shown in its own words. The two "connection dropped — error decoding response body" failures in that chat were the CLI reporting an error the stream could not carry; any OpenAI-compatible server that reports errors this way benefits too
- [x] Live test: one process across a tool call, its result and the next user turn; 2,038 of 2,805 prompt tokens cached on the continued step, 1,451 of 1,513 on the next turn (`live_claude_tool_call`)
- [ ] Seen in the app: the same kind of long agentic chat, with `chat_usage` showing most input cached
- [ ] A system prompt that changes between turns (memory, skills) reaches a parked Claude run only when a fresh run starts

### 0.19.3 — Folders you hand a chat

A folder dropped on a chat, a path pasted into it, one picked with "Add folder", or one the app was opened on from Explorer becomes something the chat's agents — and their sub-agents — can read and edit, without making a project. A path inside a known project opens in that project instead. Planned as 0.19.1; that number and 0.19.2 went to the subscription providers.

**Getting a path out of a drop**
- [x] `dropbridge.rs`: the page hands the dropped DOM objects to the host with `chrome.webview.postMessageWithAdditionalObjects`, and the host reads each path off `ICoreWebView2File`, then `ICoreWebView2FileSystemHandle`. HTML5 drag-and-drop stays on (`dragDropEnabled: false`) — Tauri's native handler would have cost the composer, zone library and settings-import drops (tauri#15138). Built on the `webview2-com` already in the tree; no plugin
- [x] `dropPaths.ts` splits a drop: folders' zero-byte `File` stand-ins are no longer attached, files attach as before. Times out to no paths after 1.5 s, so a runtime without the API never hangs a drop
- [x] Seen in the app: one file, one folder and a mixed drop of three, each with the right path and kind. **Open: whether a folder's path arrives on its `File` or only on its `FileSystemHandle` has not been observed** — both are posted; if neither carries it, folder drops say "Couldn't read that folder's location — paste its path or use Add folder"
- [x] Seen in the app: the zone-library drop and the settings-import drop still work

**Grants**
- [x] `chat_paths` (migration 053) and `grants.rs`: stored canonical, refused for a whole drive or anything under Windows, inherited by sub-agents and branches from their parent chats rather than copied, so a revoke reaches every agent under it
- [x] Enforced through the per-turn tool config (`file_system.granted_roots`, read once per turn and on a zone switch), not through fifteen file-tool signatures. A chat with no project works in its first granted folder — its `AGENTS.md`, repo map and Files tree with it
- [x] `<env>` names the extra paths (`Also granted: …`); the scope error lists them among the allowed roots
- [x] Tests: refused before, readable after, refused after revoking; a sub-agent inherits; a projectless chat's working directory; cascade on delete; a drive refused; a granted file readable and its sibling not
- [x] Five routes (`/api/chats/:id/paths`, `/api/fs/stat`, `/api/fs/context`) and `chat-paths-changed` forwarded to remotes
- [ ] Edit approval rules: an allow list of `{project}` still asks about edits in a granted folder outside it — kept as the safer reading; see the `{granted}` backlog item

**Handing one over**
- [x] Drop a folder on a chat: granted at once, shown on an **Access** strip above the composer (✕ takes it back) and under Files → **Granted** (re-root the tree on it, show it in Explorer, revoke; stale ones marked, inherited ones locked)
- [x] Paste a path (Explorer's *Copy as path* quotes included): it stays text, and a **Give access** chip appears once the desktop confirms it exists. `pathText.ts`, 7 tests
- [x] **Add folder…** beside the attach button: the native picker, which works whatever a drop manages
- [x] On the Home screen, paths wait for the chat being started and are granted before its first message goes
- [x] Seen in the app: each of the four, with the next turn reaching the path and a revoke refusing it again
- Deviation: no folder count in the chat header — the Access strip above the composer does the same job where it is read

**Smart project detection**
- [x] `path_context`: the deepest project whose directory is or contains the path, compared by component and case-insensitively on Windows (`D:\dev2` is not inside `D:\dev`); and whether an unregistered folder looks like a project (`.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `AGENTS.md`, `CLAUDE.md` at its top). Tests for each case
- [x] Home screen: a known project's folder defaults to **→ in *Project*** (picker follows; "Just this folder" reverts); a project-looking folder offers **Make it a project**
- [x] In a chat: a folder already inside its project is not granted again; one in another project is granted and **Move chat to *X*** offered, never done
- [x] Seen in the app: a folder inside an existing project dropped on the Home screen, and the chat that results listed under that project

**Opening on a path**
- [x] `launch.rs`: `multizone.exe <path>` (relative to the launch directory, so `multizone .` works) and `--open-cwd`. A bare launch opens nothing, whatever its cwd. Cold start and second launch both park the path and the window pulls it, so one fired before the listener exists is not lost. 6 tests
- [x] `useLaunchPath`: a chat in the path's project, or a chat with the path granted; nothing is sent. Mid-turn it opens in a tab rather than taking the running chat's place
- [x] Seen in the app: with the app closed; with it in the tray; `multizone .` from a terminal in a project directory

**Explorer**
- [x] Installer hooks (HKCU): App Paths entry, and **Open in MultiZone** on a folder and on a folder's background. Removed on uninstall; `uninstall-audit.ps1` now scans those keys
- [x] Seen on a fresh install: both right-click verbs (Windows 11: under *Show more options*), Win+R `multizone`, and after uninstall none of the keys left
- [ ] **Unverified: whether Explorer's address bar starts `multizone .` in the folder on screen.** If it does not, the address bar is documented as unsupported and the right-click verbs are the way in
- Cut for now: a Settings toggle that removes the verbs without uninstalling

### 0.19.x — Still to come (parked)

Parked when 0.20 started: these wait for the study backlog, not for a 0.19 patch. From the backlog entry; each one a tool plus a renderer unless said otherwise.
- [ ] Mind map and study guide / briefing / FAQ / timeline as study tools — `render_graph` and Markdown already draw them; they need source-grounded prompts
- [ ] Probe → Plan → Teach: a quiz that locates the edge of what the learner knows, a curriculum drawn as a graph, then paced teaching against it
- [ ] Source coverage in progress: which sources have been studied and which have not
- [ ] Hybrid retrieval for the knowledge base — keyword search beside embeddings, for "what does it say about *X*"; message search has FTS5, sources do not
- [ ] The scratchpad (backlog) as study mode's drawing surface

---

## 0.20.x — Nothing to set up

Adding a provider in Claude Code is one step and then you work. Here it was the start of an afternoon: a zone stores a provider, a model and a tool list, the starter zones were copied onto whichever provider existed at onboarding, so a second provider meant a second set of zones and a second round of tool checkboxes. And everything already set up for Claude Code on the same machine — skills, agents, MCP servers — had to be pointed at by hand or set up again. This release makes a zone a *role* (what it is for, what it may touch) and lets the model follow the chat.

### 0.20.0 — Zones are roles, and Claude Code's setup is already here

- [x] Skill packs under the home folder's harness folders (`~/.claude/skills`, `~/.agents/skills`, …) are found without adding a folder in Settings — on this machine, 24 packs and ~2K tokens of catalog for a zone with `load_skill`; each still switchable off
- [ ] The chat's project folder as a skill root — needs the catalog built per chat rather than once for the app, or one project's skills reach every chat
- [x] A zone can leave its model unset and follow the chat: the base zone's provider and model, else the first provider's default (`resolve_zone_model`, mirrored by `resolveZoneRun`). New zones and library installs are created that way, so a new provider needs no new zones; the editor's provider list starts with *Follow the chat* and shows what it resolves to. A zone whose provider was deleted now follows the chat instead of failing
- [x] Existing zones still pin their provider, so Settings → Providers offers *Make them follow the chat* once there are two providers — every pinned zone but the base zone, confirmed with a second click
- [x] Tool presets in the zone editor — *Read-only*, *Research*, *Code*, *Everything* (`tools/presets.rs`, served by `list_tool_presets`). MCP tools stay a checklist; a preset never touches them, and a leader keeps its delegation tools. *Read-only* is a `read_only` flag on the tool config: plan mode's allowlist plus drawing, withheld from the request and refused in the executor
- [x] `spawn_subagent` takes `agent: {name, preset | tools, instructions?, model?}` instead of a zone. The subchat keeps its caller's zone row and the spec (migration 054) is laid over it wherever the chat's zone resolves; tools are narrowed to the caller's, and a read-only caller only makes read-only helpers
- [x] Import from Claude Code (Zone Library → *From Claude Code*, and Settings → MCP): `~/.claude/agents/*.md` become zones with mapped tools, and user- and project-scope MCP servers from `~/.claude.json` become MCP entries, shown and ticked before anything is written; env and header values are imported but only their keys shown
- [ ] A project's own `.mcp.json` and `.claude/agents/` — the scan reads the home folder only
- [ ] Seen in the app: add a second provider and use an existing installed zone on it with no edits; pick *Read-only* and watch a write get refused; a leader spawning a read-only helper; the import on this machine (4 user MCP servers, no agents)

### 0.20.1 — Commands anywhere in a prompt

Claude Code runs a slash command only as the whole message. Here a command is a word in the prompt: `/review the parser, then /commit` is one message.
- [x] `/` opens the menu anywhere a word starts (`slashAt`), not only in the first column — skills and skill packs first, then MCP prompts and resources, filtered as you type. A `/word` with a second slash is a path, not a command
- [~] Saved runs in the same menu (they are in the palette today) — listed after the skills; picking one fills its template with the defaults at the caret, like an MCP prompt. Not yet seen in the app
- [x] A chosen command has a look of its own in the composer — `PromptHighlight`, an overlay behind the textarea in the same font and box that adds colour, background and glow only, so no glyph moves; the textarea's own text goes transparent only while there is a token to draw
- [x] On send, each `/skill` hands the model its `load_skill` result as a hidden part (`invoke_skill`); the word stays in the transcript. MCP prompts and resources still expand when picked, at the caret, so what they add is visible before sending
- [x] A folder granted while the composer is open — dropped, picked, pasted — is inserted at the caret and glows amber there, as well as on the Access strip
- [x] The sent message draws its `/commands` and path-shaped words the same way
- [x] The Home screen's composer does the same (`usePromptTokens`, shared with the chat composer): menu anywhere, overlay, a folder added there glows in the prompt, skills load with the first message
- [x] A message queued behind a running turn goes as text only, so a `/skill` in it is a plain word — queued entries carry hidden parts now (`pending::as_parts`); a send held behind a running turn also stops folding a skill's hidden text into the visible message
- [ ] Seen in the app: the overlay lined up with the caret through wrapping, scrolling and a 22px interface size; `/a then /b` loading both; a folder drop landing in the prompt

### 0.20.2 — The first request is yours (soon)

Raised while 0.20 was being planned. Watching the requests arrive at a local server (unsloth, LM Studio) shows a first request longer than it should be, with no say in what goes into it.
- [ ] Every section of the system prompt named and sized (preamble, env, AGENTS.md, skills index, memory, tool notes, tool schemas), each one switchable off per zone, with app-wide defaults
- [ ] The exact first request — system prompt and tool list as sent — viewable and copyable before anything is sent
- [ ] A lean preset for small local models: the shortest prompt that still works with tools
- [ ] Plan mode: find what makes it frustrating in use and fix that — *to be specified with the user*

## 0.21.x — Everything is a panel

The main column already tiles (0.18.2), on a layout tree of our own that stops at the column's edge: the sidebar, the workspace panel and the terminal are fixed. [Trellis](https://github.com/DanFessler/trellis) is that tree done properly — views that stay mounted while they are docked, floated, hidden or zoomed, and one JSON document for the whole layout.

**License:** Trellis is free for non-commercial use only (`LicenseRef-Danfessler-NonCommercial-1.0`); commercial use needs a GitHub-Sponsors tier. Accepted while MultiZone is open-source and non-commercial; revisit before that changes. It is also young (0.3.0, 2026-09).

**Shipped early, in 0.20.0** (2026-11-26), together with 0.20.0 and 0.20.1 above: one release for the whole of `feat/0.20`. Unticked items carry over to 0.20.1+.

### 0.21.0 — The workspace is a Trellis layout

- [~] `@danfessler/trellis` + `@danfessler/trellis-react` — **the main column is Trellis** ([Tiles.tsx](../src/components/Chat/Tiles.tsx)): chats, files, study sets and the new-chat screen are views that drag between panels, split onto edges, maximize, and float out as windows and dock back; the layout persists, windows included. `tabLayout.ts` was *kept* rather than retired: its navigate/open/close rules and their tests are what every caller uses, so it stays the model and [trellisLayout.ts](../src/lib/trellisLayout.ts) converts both ways (round-trip tested), and TabTiles went instead. Hide is off the menu (no tray to restore from). Verified in the running app over CDP: open, Ctrl+click, float, dock, close, reload. **Then the rest of the window:** the sidebar and each workspace section (Files, Plan, This chat, Terminals, Context, Study) are views too — docked left and right by default, movable, stackable and floatable like any tab; `sidebarOpen`/`workspaceOpen` are read from the layout so every toggle still works; the title bar has sidebar/workspace toggles and a reset-to-edges button. A phone-width window keeps them as drawers. **Left:** the title bar and the approval banner stay fixed; the phone layout is untested since the change
- [x] Sub-agents as live tiles — `spawn_subagent` takes `show: beside | window`, and the chat opens the moment it is created, so the user watches it work; beside only next to the chat that started it if that is on screen, and the user's chat keeps focus either way. The "zoom out to watch the panel" half (Trellis's free navigation) is not on
- [x] **Something that needs you, brought to you.** `present_file` takes `show: tab | beside | window`; a window floats over whatever is on screen, from any chat, including one running in the background. Questions and approvals still arrive in their chat, not as a window
- [x] The layout is readable and writable over the API — `GET`/`PUT /api/layout` and `POST /api/layout/show {tab, show}`, so `app_read`/`app_control` can see and rearrange the window. The window reports its layout and checks any it is sent

**Also in 0.20.0, raised while testing it:**
- [x] Keyboard: Ctrl+Arrow between panes, Ctrl+Shift+Arrow moves one, Ctrl+Enter zooms; Ctrl+= / Ctrl+- / Ctrl+0 size panes; Ctrl+Tab, Ctrl+PgUp/PgDn, Ctrl+1–9 and Ctrl+W for tabs; F6 between panes; menus and the sidebar list usable by keyboard
- [x] One header row per pane (its tabs): the chat's controls sit in its tab bar, the rest in pane menus; the title bar's layout buttons are one Layout menu; a closed workspace tab comes back from the pane menu or the palette
- [x] Appearance for everyone: built-in themes, background gradients, glass that is one blurred layer per pane, blur and see-through sliders, an opt-in see-through window (Acrylic/Mica), title bar Shown / Auto-hide / Hidden, Advanced folded away. All of it settable by agents through `PATCH /api/theme`
- [x] Your messages as Bubble or Editorial, and a `/skill` you send shown as a run (drawer or timeline step) with its status and files; the skill's hidden text no longer reads as a failed command
- [x] Plan mode: `/plan` toggles it, a switch in the Plan panel, Settings → Runs → Plan mode (Automatic / Ask first, the default / Only when I ask), and plans asked for as 3–7 short steps
- [x] The Files tree follows the disk (watcher + re-read on focus); the chat follows a streaming reply only until you scroll away
- [x] Agents set up projects: `PATCH /api/projects/:id`, `/api/projects/schema`, project approvals and a token limit (migration 055)
- [x] Lock a chat behind the app password or its own (PBKDF2, enforced in Rust and the API; agents may lock, never unlock; migration 056); one Export… item
- [ ] Left for 0.20.1+: pane keys still act behind open dialogs; idle auto-relock; unlocking from the phone; a keyboard pass over Settings and the model pickers; the phone layout since the pane rewrite; the sidebar text blur the user saw (not reproduced)

### 0.21.0 — Unstuck, and the first request (released 2026-11-27)

Raised after using 0.20.0, plus the first-request work that was 0.20.2. Planned as 0.21.1; released as 0.21.0, since the pane work that held that number shipped inside 0.20.0.
- [x] A startup that fails because the data is newer than the app offers *Update now* from the latest GitHub release, instead of a manual reinstall (dev builds write newer data than the installed app reads)
- [x] A `/command` looks like one while it is typed: an in-progress look for a prefix of a known command, the full look the moment it is complete (not only when picked from the menu)
- [x] Clicking a chat opens it in a new tab by default; *Replaces the current tab* stays as a setting
- [x] Browser mode (opt-in): the app starts without a window and opens the same interface in the default browser, over a loopback-only listener with a one-time login, reusing the phone's HTTP transport
- [x] The first request is yours: system-prompt sections named and sized, switchable per zone with app-wide defaults; the exact first request viewable and copyable before sending; a Lean preset for small local models
- [x] Carried from 0.20.0: pane keys no longer act behind open dialogs; idle auto-relock (default 15 min); unlocking from the phone and a browser tab, per device; a keyboard pass over Settings and the model pickers; the phone layout since the pane rewrite; the sidebar text blur (a will-change layer left soft after a pane zoom)
- [x] Fuzzy search over every setting, in Settings and in Ctrl+K
- [x] Settings as a dockable tab (*Settings opens*: dialog or tab)
- [x] The launch splash drawn on the user's theme (gradient, glass, accent glow)
- [ ] Left for later: screen-lock detection for relock; F6/Ctrl+Shift+Enter inside a docked Settings tab while a model list is open; Settings' Ctrl+F behind a dialog over it; the APK keyboard inset untested on a device
- [x] PBKDF2 off the async runtime (`hash_blocking`/`verify_blocking`); ZoneLibrary's Save/Add menus on the Escape stack

---

## 1.0.0 — Hardening & Public Release

*How each open item below can actually be closed — including the three that a manual pass cannot honestly close at all — is worked through in [TEST_STRATEGY.md](TEST_STRATEGY.md). Summary: build the mock streaming provider first (it turns "no dropped tokens" from an unfalsifiable claim into a diff, and needs no provider, key or network), run `npm run build` and `cargo test --lib` on every change (37 files of Rust tests exist and nothing ran them; this is now a pair of git hooks rather than a CI job), and test the updater against a local two-build loop rather than the release pipeline, where a build is a publish.*

- [x] ~~Blocker: add `TAURI_SIGNING_PRIVATE_KEY` and its password to repo secrets~~ — **they are already there.** Recorded as an open blocker in error; the evidence is in the tree: [updater/latest.json](../updater/latest.json) carries a real 420-character signature per platform for v0.13.0, and its URLs are the token-authenticated asset endpoints, so both the signing step and `rewrite-updater-manifest.mjs` are working in production. Secrets are only readable by workflows, so a local clone never sees them and does not need to — a local `tauri build` produces unsigned bundles, which is correct for a build that will never be published
- [x] Every change is checked — `npm run build` (which runs `tsc -b` first), `npm test`, `cargo test --lib`. **Moved off GitHub and onto the development machine in 0.14.0** ([.githooks/](../.githooks/)): `npm run check` on commit, `npm run check:all` on push, which is where it belongs in a repo whose push *is* the publish. [ci.yml](../.github/workflows/ci.yml) keeps the same two jobs as a `workflow_dispatch`-only second opinion — the hosted Windows runner spent ~13 minutes in rustc per commit to re-prove what a warm local target directory proves in ~40 seconds. What that trades away is the clean-checkout property, and it is worth naming: both CI jobs failed on their first real run (v0.13.3) for exactly that reason — Node 20 could not expand `node --test`'s glob, and `tauri::generate_context!()` needed a `dist/` that had simply been sitting in this working tree since the first build. A hook cannot catch either. Dispatch ci.yml before a release if a change looks environment-sensitive
- [x] Mock OpenAI-compatible streaming provider emitting a known token sequence — [mock-provider.mjs](../scripts/mock-provider.mjs) streams `0001 0002 …` one SSE frame per token with the knobs in the prompt (`tokens=`, `delay=`, `pause=`, `fail=`, `tool=`, `mix=`), and [token-sequence.mjs](../scripts/token-sequence.mjs) diffs what was stored against what was sent, naming the first missing index and telling a drop apart from a reorder. 16 offline tests, in `npm test`; the ones that matter are the negative controls, because a checker that always passes would close this item and prove nothing. [stream-soak.mjs](../scripts/stream-soak.mjs) runs the whole scenario set against a live app over the HTTP API — quick, sustained (100k), a mid-stream stall, seven concurrent, and a truncated stream as the control — and exits non-zero on a gap
- [x] Fixture test for the updater manifest rewrite — the mapping is now a pure function ([rewrite-manifest-core.mjs](../scripts/rewrite-manifest-core.mjs)) with 7 tests, covering the percent-encoded filename case that would otherwise publish a manifest with unrewritten URLs and stop every install updating. `npm test`, no network
- [~] Performance: measure and optimize startup time, first message render, large chat (500+ messages) scroll — **the instrument now exists and has to be pointed at something**: [perf.ts](../src/lib/perf.ts) adds launch marks and a scroll sampler (median/p95/worst frame time), inert unless `localStorage.mzPerf = "1"`, and [seed-chat.mjs](../scripts/seed-chat.mjs) builds a 500- or 2000-message chat with a stated, seeded content mix so two runs measure the same thing. Deliberately not Playwright — a browser download and a second runner to approximate a webview already on the machine. Procedure and thresholds in [RELEASE_TESTS.md](RELEASE_TESTS.md#2--performance--the-numbers-that-have-never-been-taken). **The decision it informs:** the message list is still not virtualised, and whether that matters at 500 or only at 2000 is now answerable rather than arguable — do not virtualise on suspicion, it interacts with scroll anchoring, streaming autoscroll, find-in-page and export. Previously: fixed the main structural cause of wasted re-renders: `Sidebar`/`ChatPanel`/`MessageThread`/`ChatList`/`ZoneEditor`/`ProjectsPanel`/`SettingsModal` subscribed to the whole zustand store unfiltered, so *any* state change anywhere re-rendered all of them; converted to shallow/per-field selectors, and `UserMessage`/`BotTurnView` are now memoized (with a custom comparator for `BotTurnView` since `groupMessages` rebuilds turn objects each call) so a streaming token only re-renders the turn actually generating, not the whole history. Still open: no virtualization for very long (500+) message lists, and no measured before/after startup or first-paint numbers. **Measured 2026-11-28 on the Mac mini (M-series, warm disk, browser window, median of 6):** release build spawn → API answering 184 ms, page document → interactive 67 ms, spawn → interactive 274 ms (debug 311 ms); the binary's first-ever run took 705 ms to answer. Well inside the 2.5 s target; the native window's own time to show was not measured. In a 2000-message chat a DOM insert cost ~106 ms of style recalc from a loose `:has()` rule (each Mermaid diagram ~1.5 s); after 143352b, scroll p95 ~18 ms and worst frame 64 ms, so virtualisation is still not needed at 2000.
- [x] Streaming: verify no dropped tokens or UI lag under sustained use — **run, on Windows 11 against 0.15.4, 2026-08-20: twelve scenarios, no dropped tokens.** 100k tokens in a single stream arrived complete and in order at ~33k tok/s; seven concurrent 20k streams each arrived complete (~37k tok/s aggregate, so concurrency is not contending for a shared buffer); a 1.5s mid-stream stall was not mistaken for the end of a turn; and the truncated control correctly refused to report a cut stream as complete. Memory held 128→137 MB with handles and threads flat across the run. What is *not* yet done is the 30-minute soak and the by-hand UI matrix in [RELEASE_TESTS.md](RELEASE_TESTS.md#1--no-dropped-tokens-under-sustained-use) — chat-switch mid-stream and stop mid-stream are the two the API path cannot see. Previously: **the check now exists and has to be run**: `node scripts/stream-soak.mjs` against the mock above, plus the by-hand UI matrix in [RELEASE_TESTS.md](RELEASE_TESTS.md#1--no-dropped-tokens-under-sustained-use) for the half an API driver cannot see. Previously: hardened `ChatPanel`'s Tauri event-listener effect to run once (refs instead of a dependency array) so the "stream" listener can never be torn down and re-attached mid-session, closing the only realistic drop window found. Sustained-use soak testing not yet done.
- [x] Installer: **Windows only for 1.0, and said so rather than left open** — NSIS ships today and is what every release has been built from. macOS and Linux are a distribution project, not a testing gap: an unsigned, un-notarised DMG gets a Gatekeeper block most people read as "broken", and notarisation needs an Apple Developer account at $99/year plus a signing identity in CI, which is a decision about who owns an account rather than an engineering task. Option 1 of the three in [TEST_STRATEGY.md](TEST_STRATEGY.md#3--installers-for-macos-and-linux) — ship Windows, size the signing work properly, and move both to 1.1
- [x] Auto-updater: Tauri updater plugin wired to GitHub releases — **the receiving half is confirmed, 2026-08-20**: an installed 0.15.5 found v0.15.6, downloaded it and restarted into it, which is the half three releases had never had anyone watch. Still worth doing once, separately: corrupt a character of a signature and confirm the manifest is *refused* — an updater that accepts a bad manifest is worse than one that never runs, and that path remains unexercised. Previously *built in 0.9.12*: plugin registered, signed `latest.json` published by CI alongside the installers, Settings → Data carries check / download-with-progress / install / restart. **The signing secrets are set** and the published manifest proves the whole CI half works: v0.13.0's entry is signed and its URLs are rewritten to the token-authenticated asset endpoints. What is still unverified is the *receiving* half — nobody has watched an installed build find an update, download it and restart into the new version. Several releases have now shipped (v0.12.6, v0.12.7, v0.13.0), so this needs no special setup: install the previous release, publish the next, and watch it. Local rehearsal without publishing anything is in [TEST_STRATEGY.md](TEST_STRATEGY.md#4--auto-updater-end-to-end)
- [~] Cross-platform smoke tests — **Windows 11 only, following the installer decision above.** There is nothing to smoke-test on the other two until there is something to install; the manual pass is [TEST_CHECKLIST.md](TEST_CHECKLIST.md) and its 🖥️ items need a genuinely fresh machine
- [x] Write REQUIREMENTS.md for contributor onboarding — full doc (personas, user stories, functional/non-functional requirements, out-of-scope) grounded in the roadmap principles and the 0.1–0.9 feature set ([REQUIREMENTS.md](REQUIREMENTS.md))
- [x] In-app keyboard shortcut reference — `?` (outside text fields) or the keyboard icon in the sidebar opens a shortcuts modal cataloguing every shortcut wired up in the app
- [x] App-wide keyboard control — a central handler ([useGlobalShortcuts.ts](../src/lib/useGlobalShortcuts.ts)) driven by a single shortcut definition list ([shortcuts.ts](../src/lib/shortcuts.ts), shared with the help modal so the reference can't drift). Ctrl/Cmd+N new chat, Ctrl/Cmd+, settings, Ctrl/Cmd+B toggle sidebar, Ctrl/Cmd+L zone library, Ctrl/Cmd+Shift+P projects, Ctrl/Cmd+K focus the composer, Alt+↑/↓ prev/next chat, Ctrl/Cmd+/ or `?` the reference. Modifier shortcuts fire even mid-typing; the plain `?` is suppressed in text fields. Sidebar open/closed moved into the store (same `ui.sidebarOpen` persistence key) so a shortcut can toggle it; composer focus signalled via a store nonce
- [x] **A dropped connection loses the partial answer; pressing stop keeps it.** — **fixed and verified**: `StreamAggregate` gained `error` as a sibling of `cancelled` and the failure arm breaks rather than returning, so the flush still runs and the partial reaches the caller; the call site persists it before failing the turn. The soak's truncated scenario stored 0 tokens before and stores 354 of the ~399 delivered now, and that assertion is part of the gate rather than a one-off. Original finding: Found by the truncated soak scenario: the mock delivered 399 of 5000 tokens and hung up, and the app stored *no assistant message at all* — not a partial, not an empty row. The engine is explicit that partial output should survive ([messages.rs](../src-tauri/src/commands/messages/mod.rs), "Persist whatever the model produced before cancellation", with `skip_persist` firing only when content, reasoning and tool calls are all empty), so this is not a missing intention — a transport error propagates out before reaching that block. The result is an asymmetry the user cannot see the logic of: press stop and your half-answer is kept; have the provider drop and it is gone, after you watched it arrive. Against a local model on a flaky socket, or a hosted provider closing an idle connection, the dropped case is the *more* common one. The fix is to treat a stream error like a cancellation for persistence purposes and mark the turn failed, which is also what makes 0.9.x's "no tool reports a failure as an ordinary empty result" true of turns as well as tools. **Verified over the API path only** — the GUI streams through the same engine but nobody has watched a drop in the window, so it is worth confirming the frontend is not holding something the database is not
- [x] **A downgrade says what happened, in a sentence someone can act on.** — **fixed**: a guard runs before the migrator and reports cause, remedy and the fact that no data was touched, in place of sqlx's `VersionMissing` wording. Two tests, including one that it does not fire on an ordinary or fresh database. Original finding: Found by running a 0.12.7 binary against a database 0.15.4 had migrated: the app shows "MultiZone could not start", exits 1, and the reason is `migration error: migration 37 was previously applied but is missing in the resolved migrations`. Refusing to start is *right* — an old binary writing a newer schema is how a database gets corrupted, and there are 43 migrations to get wrong — but the sentence is written for whoever wrote sqlx, not for whoever is holding the machine. This matters at 1.0 specifically because 1.0 is the release that turns the updater on: a rollback, a second machine restored from a backup, or someone opening an older build they still had are all now reachable states, and each of them currently produces an error message whose only actionable content is a log path. Detect the case (applied migrations present that this build does not know) and say so — "This copy of MultiZone is older than the data on this machine. Install 0.15.4 or newer to open it." No data is at risk either way; this is entirely about the sentence
- [~] Clean uninstall: no orphaned files or registry entries — **the audit now exists and has to be run on a VM**: [uninstall-audit.ps1](../scripts/uninstall-audit.ps1) snapshots files and registry before install, after install and after uninstall, and prints what survived with our name on it. Every survivor is then a decision rather than a discovery — the database and the checkpoint blob store arguably should survive and NSIS should be asking; registry keys, the WebView2 user-data folder and anything under Program Files must not. Procedure in [RELEASE_TESTS.md](RELEASE_TESTS.md#4--clean-uninstall)
- [x] **A privacy statement, written from the source rather than from the principle** — [PRIVACY.md](PRIVACY.md). A public release makes "local-first" a claim someone can hold us to, and the honest version of it turned out to have two exceptions the roadmap had never written down. Both are in the statement, and both need a decision here rather than a sentence there:
- [x] **The launch update check becomes opt-out.** [UpdatePrompt.tsx](../src/components/UpdatePrompt.tsx) fetches the updater manifest from `raw.githubusercontent.com` ~2.5s after every launch. It sends no identifier and stays silent on failure, which is why it has never felt like egress — but it is the one request the app makes that the user did not initiate, and "nothing leaves the machine unless you choose" is not true while it cannot be switched off. A toggle in Settings → Data, defaulted on, next to the existing check-now control
- [x] **State the position on API-key storage** — stated, not moved. Keys remain in `multizone.db` in plain text; the app says so under the key input as it is typed, in Settings → Data, in the README and in the statement. The keychain move stays with 1.2.x, which builds that machinery for OAuth refresh tokens anyway, and doing it in the week before a first release would mean writing a migration for the one table nobody can afford to lose. Original wording: Provider keys sit in `multizone.db` in plain text — no encryption, no keyring dependency in the tree. That is defensible for a single-user local app and indefensible if nobody is told, so 1.0 either moves them to the OS keychain (which 1.2.x builds the machinery for anyway) or says plainly in the app, at the point of entry, that the database is as sensitive as the key. Saying it is the cheap half and ships regardless
- [x] **Surface it where it is read, not where it is filed** — the statement is bundled into the binary and rendered in-app from the same file, so it reads with no network and cannot drift from `docs/`. Settings → Data, first-run setup, and the README. Original wording: The statement is worth nothing in `docs/` alone: link it from the README, from Settings → Data, and from first-run setup — the three places someone forms a view about what this app does with their data
- [x] Formal pre-release test checklist — [TEST_CHECKLIST.md](TEST_CHECKLIST.md), covering build plumbing, first run, chat, zones/projects/tags, tools, knowledge, multizone, voice, export, updates, uninstall, cross-platform and performance

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

- [ ] **A `/command` whose name has spaces never gets the command look** — in the composer and in the sent message it reads as plain text. Raised 2026-11-28; not a priority
- [ ] **From 0.19.3, folders handed to a chat.** Each small, each built on `chat_paths`:
  - Reference a large dropped file by path instead of inlining it — a 40 MB log does not need to be in context once the agent can open it
  - Files panel right-click: copy path, reveal in Explorer, grant to another chat
  - A `{granted}` placeholder for edit approval rules beside `{project}`, so editing a granted folder can be made as quiet as editing the project
  - Recent folders on the Home screen
  - Windows 11's compact right-click menu: an `IExplorerCommand` handler, which needs a packaged (sparse MSIX) identity — a distribution question as much as an engineering one
  - A Settings toggle for the Explorer verbs

- [ ] **Retrieval and spend** — *scheduled as 0.14.7, unscheduled before it started.* Each of the three is a real improvement and none of them is what this app is for: a local-first interface whose corpus is one person's projects, not a cloud index or a benchmark harness.
  - Hybrid retrieval: BM25 over FTS5 fused with the existing cosine score at roughly equal weight, then a cross-encoder rerank of the top ~20 down to ~8. Embedding-only search misses exact-token queries — an error string, a config key, a function name — which is most of what a coding agent looks up. Same RRF shape `smart_search` already uses, applied to the local index. The honest case for deferring: at one project's scale the embedding-only miss is a second query, not a dead end
  - A bundled, refreshable model price table; cost in currency per turn and per sub-agent, built on the existing cache-aware token accounting. The header chip currently shows billed tokens behind a dollar sign — this makes the glyph honest. A bundled table also goes stale on someone else's schedule, and local models cost nothing to run
  - Eval harness: point a zone or team config at SWE-bench Verified instances and report pass rate. The premise of the whole panel is that it beats a single local model, and there is currently no way to know — but SWE-bench measures a coding agent, not a multi-zone chat interface, so a pass rate would answer a question nobody using this is asking
- [ ] Code interface: chat window for local models working on codebases; uses RAG from 0.4.3; requires design session
- [ ] **File editing as an engine, not a tool.** Cursor and Antigravity handle multi-file editing categorically better than we do, and the gap is structural rather than a missing feature: they apply *edits* (search/replace or diff hunks, validated against the file as it currently is) where our `write_file` rewrites a whole file from whatever the model remembers of it. A real edit engine means a hunk format, fuzzy anchoring that survives a file having moved on, a syntax check before the write lands, and a failure that reports "the anchor no longer matches" instead of silently clobbering. This is the prerequisite for the code interface above and is scoped with it, not before it. 0.10.x's checkpoints and 0.10.2's diff review are the parts of this problem worth solving early, because they help every existing file tool immediately
- [~] **Study mode.** *First slices shipped in 0.19.0 (grounding, flashcards, quizzes, cheat sheets, spaced review); what remains is under [0.19.x — Still to come](#019x--still-to-come).* A mode for learning a body of material rather than working on it. The user brings sources into a project — lecture notes, a spec, a textbook chapter, a stack of papers — and the app helps them *know* it. NotebookLM is the reference implementation and the citation-UX benchmark; it is also cloud-only and requires handing Google the sources, which is the whole argument for us having one.

  Per the "build components before modes" principle, this is a mode and belongs *after* its components. Most of them already exist:

  | Needs | State |
  | --- | --- |
  | Per-project source corpus | Built — the knowledge base, with a file watcher that re-indexes on save |
  | Inline citations back to the source | Built — `search_local_files` returns source, chunk and score; citations render and survive export |
  | Diagrams for a mind map | Built — `render_graph` draws Mermaid |
  | Spoken output for an audio overview | Built — TTS (0.8.1), including speech pipelining |
  | A document a study artifact can be produced into | Built — `present_file` and the HTML report renderer |
  | Reusable per-task instructions | Built — skills |
  | **Source-only grounding** | **Built in 0.19.0** — the mode's whole premise |
  | **Durable study state** | **Built in 0.19.0** — study sets, cards on an SM-2 schedule, every quiz answer |
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
  | `make_data_table` | New — but **0.16.1 already schedules interactive tables** (sort, filter, copy). Same renderer, different producer: here it extracts rows from unstructured sources | Converges with 0.16.x; build once |
  | `make_slide_deck` | New — HTML slides | `HtmlReportBlock` renders and presents arbitrary HTML today, so this is a template and a print stylesheet |
  | `make_infographic` | HTML report | Same renderer again. This is a *design* problem, not an engineering one — an infographic nobody would print is worse than the table it replaced |
  | `make_audio_overview` | Existing audio playback | TTS ships; the work is a two-voice script and turn-taking, not synthesis |

  **Video overview**, previously dismissed here as out of scope, deserves a more honest line: it is a slide deck plus an audio overview plus a recorder. If the first two land, the third is a capture step rather than a production pipeline. Still last, still lowest value, but no longer a category we refuse.

  **Its own interface.** Like the code interface, this wants a workspace rather than a chat panel: sources down one side, the conversation in the middle, generated artifacts collected somewhere they can be returned to. That is the second time this shape has come up in the backlog, which is the signal — **build one mode surface and let both use it**, rather than two bespoke shells that duplicate every affordance. The principle is the roadmap's own: components before modes, and "a workspace a mode can furnish" is a component. Whichever mode lands first should pay for it, and it should be scoped as its own item before either.

  Sizing note: the artifacts are cheap because the components exist. Grounding is a mode. Spaced repetition is new state with a scheduler. The interface is shared with the code interface and should be scoped separately. Do not schedule this as one release — the artifacts alone are worth shipping before any of the retention machinery, and they are also the honest test of whether anyone uses it.

- [ ] **Scratchpad — Draw · Plan · Order inside the app, with the AI on both sides of it.** An endless canvas for pen, keyboard and decision trees, already built as its own project (`Draw Plan Order`, ~6.4k lines of plain JS, no build step, its own Tauri shell and `.dpo` board files). It runs in WebView2 today, so pen pressure, coalesced pointer events and the Surface Pen eraser behave the same inside MultiZone as they do there. The question is not whether it fits but how much of it to own.

  **What it already has that matters here:** freehand ink with shape recognition, text boxes, sticky notes, flow-chart nodes with connectors that re-route themselves, Tab/Enter decision-tree building with automatic placement, PDFs laid out as pages to write on, pasted images stored once at full resolution, and PNG export of the canvas. Items are a small typed set (`stroke`, `shape`, `text`, `note`, `node`, `edge`, `image`, `pdfpage`), which is exactly the vocabulary a model needs to write to it.

  **The AI half, each one a tool or a button rather than a feature:**

  | Piece | What it is | What exists already |
  | --- | --- | --- |
  | Send to AI | Snapshot the board, the viewport or a lasso selection as PNG and attach it to the chat, with the text of every note and node in the selection alongside — a vision model gets the picture, a text-only one still gets the words | DPO's PNG export; MultiZone attachments; `ocr.rs` for handwriting when the model cannot see |
  | Screenshot to scratchpad | Paste a screen grab onto the board, annotate it, send it | DPO's image paste; the send above |
  | `scratchpad_write` | The model adds notes, text, nodes and edges at a position or "in free space", and can group what it added so one undo removes it | DPO's free-space placement from the decision-tree code |
  | Mermaid on the board | A flowchart or mind map arrives as **native nodes and connectors** — editable, draggable, re-routing — not a picture. Diagram types DPO has no shape for (sequence, gantt) fall back to an SVG image item | `MermaidBlock` parses and renders; DPO's node/edge model and auto-routing |
  | Maths | KaTeX rendered to an image item, source kept on the item so it can be edited and re-rendered | KaTeX is already in the app |
  | `scratchpad_read` | The board as structured text: items, their text, what connects to what, what is near what | Scene model is already JSON |

  **Study mode is the obvious first home.** The model draws the mind map or the worked solution onto the board; the learner annotates it, crosses things out, adds their own working; "check my working" sends the lasso back. That is the Probe → Plan → Teach loop above with a surface the learner can write on, and it answers the "artifacts collected somewhere they can be returned to" half of the mode surface for one artifact type. Boards stored as `.dpo` files in the project folder also make them sources the knowledge index can read.

  **How to bring it in — embed first, port later.** DPO assumes it owns the page: modules hang off a `window.DPO` global, and the app and UI layers look elements up by id. So:

  1. **Embed** the existing build in a sandboxed iframe in a workspace tab, with a `postMessage` bridge (`snapshot`, `readScene`, `addItems`, `onChange`). Days, not weeks, and DPO keeps shipping on its own. Theme and keyboard shortcuts are the two things that need care — a Tab in the canvas must not reach the chat
  2. **Write** the AI tools against that bridge. Everything above works through it
  3. **Port** `scene`, `render`, `freehand`, `recognize` and `tools` into a module the React side hosts directly — only if the iframe seam turns out to be what limits it

  **Caution worth noting now:** a canvas this size must not repaint while nothing changes. DPO already redraws on demand; whatever hosts it must not add an always-on loop (see the background effect, which runs every frame whether the window is visible or not).

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
- [ ] **The app as a moddable surface — `.zone` packages.** A zone that can already repaint the app, write a skill and register an MCP server cannot add the one thing users keep asking for: a *tool that does not exist yet*, rendered the way that tool wants to be rendered. The ask is a mod system in the Minecraft sense, with the difference that matters here — you do not download the mod, you talk it into existence with the zone that will run it, and you can talk it into being different afterwards.

  **Most of the parts exist, which is the reason to take it seriously.** The gap is narrower than "make the app dynamic" suggests:

  | Needs | State |
  | --- | --- |
  | The agent driving app state | Built — `app_control`/`app_read` forward to the in-process axum router, so the model's reach is the API's ~109 routes by construction |
  | Runtime-registered backend tools | Built — MCP, with per-zone enablement and per-tool danger levels. A zone that wants a new tool can *write an MCP server* and register it; it does not need a new execution runtime |
  | Arbitrary appearance | Built — `customCss` + `customCssEnabled`, validated in [theme.rs](../src-tauri/src/theme.rs) with per-field doc strings |
  | Folder-backed packages discovered on disk | Built — [skillpacks.rs](../src-tauri/src/skillpacks.rs), read-only, capped, served through a tool |
  | Model-authored UI in the transcript | Built — `HtmlReportBlock` renders model-written HTML in an iframe, deliberately script-free |
  | A seam for an unknown tool's card | **0.13.0** — the shaped fallback for MCP tools is exactly where a mod-supplied renderer plugs in. Hard prerequisite |
  | **An extension-point registry the agent can read** | **Missing** — the whole feature rests on it |
  | **A renderer contract, and somewhere safe to run one** | **Missing** — the only genuinely new engineering |

  **Three tiers of "dynamic", because they are not one feature and do not cost the same.** Nearly everything asked for lands in the first two:

  1. **Configuration** — settings values, custom CSS, layout presets, background effects. *Already possible today.* The gap is that the model does not know which knobs exist or what the selectors are called, which is a registry problem, not a capability one
  2. **Composition** — a new settings page, a panel arrangement, a split chat-and-file-tree view. A declarative manifest, schema-validated, rendered by components that already exist. High perceived power, no sandbox, no new runtime
  3. **Code** — a custom renderer with behaviour. Needs a sandbox, and is the only tier that does

  **Trust model — decided: packages are shareable, and arrive off.** A `.zone` is an artifact someone else can install, which means the security question is real rather than notional and cannot be answered with "the user watched it get written". Installing a package is inert: it lands disabled, its manifest is shown as *what it wants* rather than as a summary, and nothing in it executes, renders or registers until the user enables it. Enabling is per package and reversible, and a package that has been enabled can be disabled without being deleted — the same shape as `customCssEnabled`, for the same reason. Self-authored packages take the identical path: the zone that wrote it does not get to enable it, which keeps the "user stays in control" line intact at exactly the point where it would otherwise quietly break.

  **Capability floor — both tiers get specced; only the first gets built.** The line is whether a package can *add* reach or only *compose* reach the app already gates:

  | | **Tier A — compose** | **Tier B — extend** |
  | --- | --- | --- |
  | What a package may do | Call tools that already exist, through the existing approval and danger-level path; declare UI; declare settings; supply renderers | Open a socket, read a path outside the project, spawn a process, hold a credential |
  | Permission surface | The tools it names, approved once at enable time. No new categories | A full permission manifest, per-capability consent, and a revocation story |
  | Sandbox | The declarative tier needs none; the renderer tier needs the iframe below | The same, plus a broker for every reach it declares |
  | Honest sizing | Covers, as far as we can currently tell, everything actually asked for | Where mod systems stop being a feature and become a security product |

  Tier A ships as the whole feature. Tier B is written down now so the manifest has room for it — a `capabilities` block that initially accepts nothing but tool names — and is picked up only if real packages turn out to need it. If they never do, this stays a two-tier spec with one tier built, which is the good outcome rather than the incomplete one.

  **The sandbox, since it is the one part with teeth.** [tauri.conf.json](../src-tauri/tauri.conf.json) sets `"csp": null`, so *any* script in the main webview has the full Tauri IPC surface — every file tool, every shell tool, every route. Mod code therefore never runs in the main webview, at any tier. The renderer tier extends the existing `HtmlReportBlock` iframe with `allow-scripts` and, critically, **without** `allow-same-origin`: those two flags together are a documented sandbox escape, and the current block sidesteps the question only by allowing no scripts at all. The frame gets a `postMessage` RPC channel whose callables are exactly what the package's manifest declared and the user approved — not `invoke`, not `fetch`. Setting a real CSP is worth doing regardless of this item and is arguably 1.0 work.

  **Package format: a directory to work in, an archive to share.** `skillpacks.rs` already made this call. A zip is opaque to `git diff`, to 0.10.x checkpoints and to 0.7.x's markdown-on-disk mode, and cannot be hand-fixed when the agent gets it wrong — which is the constant case while you are talking a package into shape. So the working format is a directory, and `.zone` is a zip of it for distribution only, which is also what the Post-1.0 marketplace item would need.

  **Documentation of override points is generated, not written.** The failure mode of every mod system is documentation that goes stale and agents writing against an app version that no longer exists. Two precedents in the tree already solve this: `theme.rs` declares fields with `doc:` strings that produce both the validator and the description, and `/api/routes` is a generated catalog with a drift test that fails the build when a command ships without one. Extension points get the same treatment — one Rust table generating the runtime validator, the manifest schema, and the document an agent requests before it writes anything, with a drift test. An extension point added without a doc string fails the build.

  **Version breakage is where these die, and we have an unusual answer.** A package written against 0.16's DOM breaks on 0.17. The ordinary mitigations apply: a declared API version in the manifest, a compatibility check at load, and *disabled-with-a-stated-reason* rather than a white screen. The unusual one is that the agent that wrote the package can be handed the breakage and repair it — worth designing for deliberately rather than hoping for, and it means keeping a package linked to the conversation that authored it.

  **Modes and project onboarding are a related ask, and belong to the mode surface item rather than this one.** The proposal — the app asks what a project is *for* (study, code, writing) and furnishes itself accordingly, with packages able to define new kinds — is right as a destination and wrong as a starting point, by this document's own principle. Designing an extension contract for modes before a single hand-built mode exists means fitting an API to zero examples. Ship the mode surface with study mode, then extract the contract from what it actually needed. Worth separating from that: "onboarding picks a project type" is a wizard over settings that already exist, and could ship at any time more or less independently of all of this.

  **Sequencing, none of it pre-1.0:**

  1. Extension-point registry + generated manifest schema + drift test — small, unblocks everything, reuses the routes pattern outright
  2. Declarative renderer contract — after 0.13.0's fallback seam lands
  3. Sandboxed renderer tier — iframe with `allow-scripts` and no `allow-same-origin`, plus the capability-scoped RPC
  4. `.zone` packaging, the install/enable/disable lifecycle, and the compatibility gate
  5. Tier B, only if real packages demand it

  Steps 1 and 2 are genuinely near-term and useful with no mod system attached at all — step 1 makes every existing `app_control` interaction better, and step 2 is 0.13.0 finishing its own job. Do not schedule this as one release.


- [ ] Deep research mode: multi-step sourced research using subchats; requires design session before scheduling
- [ ] Zone snapshot/versioning: save zone config at chat creation time so editing a zone does not alter historical context
