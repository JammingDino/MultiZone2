# Release Plan — MultiZone

Detailed work items grouped by release. Direction in [ROADMAP.md](ROADMAP.md). Releases before 0.17.x are in [RELEASE_HISTORY.md](RELEASE_HISTORY.md).
`[x]` done · `[ ]` to do · `[~]` partial/built but untested. Items are movable between releases.

---

## Carried over from shipped releases

Open items from 0.1.x–0.16.x, whose full entries are in [RELEASE_HISTORY.md](RELEASE_HISTORY.md). Mostly runtime tests of features that shipped with their automated tests passing.

- [ ] **0.2.4** — Right-click actions on the chat sidebar's zone references — *follow-up if wanted*
- [ ] **0.9.16** — Measure it: frame timings for one stream and for four, before and after, on a long answer — the fix is reasoned from where the cost is, not yet from a profile
- [ ] **0.10.1** — Runtime-test the whole path: a real turn that edits a file, then revert it from the transcript
- [ ] **0.12.0** — Runtime-test the whole path: ask for something large, watch the mutating tools disappear, edit the plan, approve it, and confirm the executing turn is held to the edited steps
- [ ] **0.12.1** — Runtime-test: run a plan of several steps, strike one mid-run, add one, and stop after a step
- [ ] **0.12.1** — Runtime-test: ask for a plan in prose with no button to press, and confirm the model enters plan mode via `enter_plan_mode`
- [ ] **0.12.2** — Runtime-test: run an agentic turn with an approval declined and a tool failure, then replay it
- [ ] **0.12.3** — Runtime-test: launch in light mode with a 22px interface size and a custom font, then replay a turn that ran tools
- [ ] **0.13.4** — **Runtime-test:** send an image with no text to a vision model — the title names what is in the picture, not "Image Attachment"
- [ ] **0.13.4** — **Runtime-test:** off by default on an existing install, and the toggle changes the exported document
- [ ] **0.14.0** — **Runtime-test:** launch with two servers configured and one deliberately broken — the good one shows connected before the first message, the broken one shows its error in Settings rather than during a run
- [ ] **0.14.1** — **Runtime-test:** a model told to read the same file until it succeeds is stopped and explains itself; a background sub-agent doing it marks its node in the tracer
- [ ] **0.14.1** — **Runtime-test:** a zone pointed at a dead provider with a fallback configured answers from the fallback, and the transcript says which zone answered
- [ ] **0.14.2** — *Deferred to 0.14.3, with the project-root work:* "edit inside the project root" as a **path** constraint. The category answers whether editing is auto-approved, not where — and a path policy wants the same treatment as the shell lists rather than a boolean bolted onto a category
- [ ] **0.14.5** — **Runtime-test:** a zone with `{project}` in its edit-allow list writes inside the project without prompting, is asked before writing to the desktop, and is refused outright inside `.git`
- [ ] **0.14.5** — **Runtime-test:** a repository carrying an `AGENTS.md` has it in the context meter's breakdown before the first message, and a rule in `src/generated/AGENTS.md` arrives only once the model reads a file there
- [ ] **0.14.5** — **Runtime-test:** a project with `npm run typecheck` configured, given a task that breaks the build, sees the error and fixes it before answering — and the same turn reports a pass when it does not
- [ ] **0.14.6** — Runtime-test the whole path: ask for something that needs research, confirm the model asks questions first, watch it search and draft step by step, read the written `.md`, edit a step in the card, approve, and confirm the executing turn is held to the detail and not just the headings
- [ ] **0.14.6** — Runtime-test the scrolling fix specifically: a plan of 20+ steps, the wheel over the card and over the task panel, and the composer still reachable throughout
- [ ] **0.14.6** — Runtime-test reachability across zones: ask "plan this out first" in a Quick chat, in a read-only zone and in a zone with file tools, and confirm all three enter plan mode without the tool being named. Then check the negative — "what does the release plan say about 0.13?" must not propose a plan
- [ ] **0.15.0** — Runtime-test against a real history: search a word that appears in a sub-agent's chat, confirm the result names the conversation it lives under, and confirm the jump lands and flashes
- [ ] **0.15.0** — Runtime-test the backfill on an existing database — the migration indexes what is already there, and that path never runs in a fresh test DB
- [ ] **0.15.1** — Runtime-test: ⌘K from a chat, from the home screen and with Settings already open; confirm Escape closes only the palette, and that ⌘J still reaches the composer
- [ ] **0.15.2** — Runtime-test: fork a chat that has two sub-agent runs and an earlier branch at each scope, and confirm the tree that arrives matches what was asked for
- [ ] **0.15.3** — Runtime-test against a server that offers both — the renderers are tested against the shapes the spec allows, but nothing here has met a real server yet
- [ ] **0.15.4** — **The editor.** Writing a run in the app — name, template, parameter rows, zone — plus export and import as one file, which is the "shareable" half of the item and the reason parameters exist rather than a saved prompt
- [ ] **0.15.4** — Runtime-test: save a run with two parameters, run it from the palette, confirm the staged prompt is filled and the chat opened in the right zone
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
- [ ] Seen on Windows: hide, restore from the icon, quit from the menu, relaunch while hidden
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
- [ ] Watched on a long agentic run: does the model mark what it verified, and does it stop re-running the same tests

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
- [ ] Seen against OpenCode Go: which shape its models accept, and whether it refuses or silently ignores the others

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
- [ ] Seen in the app: four chats tiled, two of them streaming, resized and closed without a lost token

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
- [ ] Seen in the app: a study project refusing a question its sources don't cover, and citing one they do
- [ ] Seen in the app: a review session through a deck, with "Again" cards coming back
- [ ] Seen in the app: a cheat sheet edited by hand, then revised by the model

**Projects the model sets up**
- [x] "New project" and "New study project" from the composer: the model names the project and picks its icon and colour from the opening message, and it gets a folder under the save directory before the first turn runs
- [x] Optionally the model draws an SVG icon (sanitised), kept under "Generated" in the icon picker for any project or zone (migration 050)
- [x] Sources added from the same flow are copied into the folder and indexed
- [ ] Seen in the app: a study project started from the composer with a few PDFs, usable on its first message

**A lighter app**
- [x] The webview is told when the window is hidden to the tray or minimised (`background.rs`): it stops rendering and is asked to keep memory low. Every way back — tray, second launch, taskbar, focus — marks it visible again
- [x] Background effects paced: at most 60 fps (a 144 Hz screen drew them 144 times a second), 20 fps behind another window, none while hidden. Measured in a harness: 61 / 20 / 0, and 60 again when shown
- [x] Topography no longer allocates a Path2D per level and a closure per contour cell every frame; the grid stops re-rendering once its parallax has caught up
- [x] The approval queue polled every 2 s for the life of the app; now only while a turn runs or something is waiting. Staged edits are polled only during a turn
- [x] Startup script ~5.9 MB → ~2.3 MB: mermaid (2.9 MB, now split per diagram type), pdf.js and every Prism grammar load the first time they are needed
- [x] The diagram cache keeps the last 64 rather than every diagram of the session
- [x] Settings → Dictation can delete the GPU engine (670 MB)
- [ ] Seen in the app: Task Manager with the window in the tray for ten minutes — WebView2 CPU and GPU near zero — then restored from the tray, the taskbar and a second launch, never to a blank window
- [ ] Startup and first paint measured before and after with `perf.ts` (1.0's open performance item)

### 0.19.x — Still to come

From the backlog entry; each one a tool plus a renderer unless said otherwise.
- [ ] Mind map and study guide / briefing / FAQ / timeline as study tools — `render_graph` and Markdown already draw them; they need source-grounded prompts
- [ ] Probe → Plan → Teach: a quiz that locates the edge of what the learner knows, a curriculum drawn as a graph, then paced teaching against it
- [ ] Source coverage in progress: which sources have been studied and which have not
- [ ] Hybrid retrieval for the knowledge base — keyword search beside embeddings, for "what does it say about *X*"; message search has FTS5, sources do not
- [ ] The scratchpad (backlog) as study mode's drawing surface

---

## 1.0.0 — Hardening & Public Release

*How each open item below can actually be closed — including the three that a manual pass cannot honestly close at all — is worked through in [TEST_STRATEGY.md](TEST_STRATEGY.md). Summary: build the mock streaming provider first (it turns "no dropped tokens" from an unfalsifiable claim into a diff, and needs no provider, key or network), run `npm run build` and `cargo test --lib` on every change (37 files of Rust tests exist and nothing ran them; this is now a pair of git hooks rather than a CI job), and test the updater against a local two-build loop rather than the release pipeline, where a build is a publish.*

- [x] ~~Blocker: add `TAURI_SIGNING_PRIVATE_KEY` and its password to repo secrets~~ — **they are already there.** Recorded as an open blocker in error; the evidence is in the tree: [updater/latest.json](../updater/latest.json) carries a real 420-character signature per platform for v0.13.0, and its URLs are the token-authenticated asset endpoints, so both the signing step and `rewrite-updater-manifest.mjs` are working in production. Secrets are only readable by workflows, so a local clone never sees them and does not need to — a local `tauri build` produces unsigned bundles, which is correct for a build that will never be published
- [x] Every change is checked — `npm run build` (which runs `tsc -b` first), `npm test`, `cargo test --lib`. **Moved off GitHub and onto the development machine in 0.14.0** ([.githooks/](../.githooks/)): `npm run check` on commit, `npm run check:all` on push, which is where it belongs in a repo whose push *is* the publish. [ci.yml](../.github/workflows/ci.yml) keeps the same two jobs as a `workflow_dispatch`-only second opinion — the hosted Windows runner spent ~13 minutes in rustc per commit to re-prove what a warm local target directory proves in ~40 seconds. What that trades away is the clean-checkout property, and it is worth naming: both CI jobs failed on their first real run (v0.13.3) for exactly that reason — Node 20 could not expand `node --test`'s glob, and `tauri::generate_context!()` needed a `dist/` that had simply been sitting in this working tree since the first build. A hook cannot catch either. Dispatch ci.yml before a release if a change looks environment-sensitive
- [x] Mock OpenAI-compatible streaming provider emitting a known token sequence — [mock-provider.mjs](../scripts/mock-provider.mjs) streams `0001 0002 …` one SSE frame per token with the knobs in the prompt (`tokens=`, `delay=`, `pause=`, `fail=`, `tool=`, `mix=`), and [token-sequence.mjs](../scripts/token-sequence.mjs) diffs what was stored against what was sent, naming the first missing index and telling a drop apart from a reorder. 16 offline tests, in `npm test`; the ones that matter are the negative controls, because a checker that always passes would close this item and prove nothing. [stream-soak.mjs](../scripts/stream-soak.mjs) runs the whole scenario set against a live app over the HTTP API — quick, sustained (100k), a mid-stream stall, seven concurrent, and a truncated stream as the control — and exits non-zero on a gap
- [x] Fixture test for the updater manifest rewrite — the mapping is now a pure function ([rewrite-manifest-core.mjs](../scripts/rewrite-manifest-core.mjs)) with 7 tests, covering the percent-encoded filename case that would otherwise publish a manifest with unrewritten URLs and stop every install updating. `npm test`, no network
- [~] Performance: measure and optimize startup time, first message render, large chat (500+ messages) scroll — **the instrument now exists and has to be pointed at something**: [perf.ts](../src/lib/perf.ts) adds launch marks and a scroll sampler (median/p95/worst frame time), inert unless `localStorage.mzPerf = "1"`, and [seed-chat.mjs](../scripts/seed-chat.mjs) builds a 500- or 2000-message chat with a stated, seeded content mix so two runs measure the same thing. Deliberately not Playwright — a browser download and a second runner to approximate a webview already on the machine. Procedure and thresholds in [RELEASE_TESTS.md](RELEASE_TESTS.md#2--performance--the-numbers-that-have-never-been-taken). **The decision it informs:** the message list is still not virtualised, and whether that matters at 500 or only at 2000 is now answerable rather than arguable — do not virtualise on suspicion, it interacts with scroll anchoring, streaming autoscroll, find-in-page and export. Previously: fixed the main structural cause of wasted re-renders: `Sidebar`/`ChatPanel`/`MessageThread`/`ChatList`/`ZoneEditor`/`ProjectsPanel`/`SettingsModal` subscribed to the whole zustand store unfiltered, so *any* state change anywhere re-rendered all of them; converted to shallow/per-field selectors, and `UserMessage`/`BotTurnView` are now memoized (with a custom comparator for `BotTurnView` since `groupMessages` rebuilds turn objects each call) so a streaming token only re-renders the turn actually generating, not the whole history. Still open: no virtualization for very long (500+) message lists, and no measured before/after startup or first-paint numbers.
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
