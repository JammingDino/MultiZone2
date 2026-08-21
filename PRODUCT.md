# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three layered audiences, all technical, all on Windows desktops, all reached by the same page:

1. **Developers who already juggle several models.** They pay for two or three frontier
   subscriptions, keep a local model on their own GPU, and lose time tab-switching between
   them to see who answers a question best. Job: ask once, compare honestly.
2. **Agent and orchestration builders.** They want more than a chat window — a panel of
   models briefed against each other, a leader that synthesizes, sub-agents that can edit one
   codebase in parallel without trampling each other. Job: get a team of models to do real work
   on a real repo.
3. **Local-first and privacy-driven users.** They will not put their work in a hosted chat
   product. Job: run frontier and local models from one interface with nothing in the middle.

The page must land for all three in one scroll: perspective mode opens it, the Response Leader
and code teams escalate it, privacy anchors the close.

## Product Purpose

MultiZone is a desktop LLM client (Tauri + React + Rust, Windows) where a **zone** is one named
configuration: provider, model, system prompt, temperature, toolset, permissions. Send one
message to many zones at once and read their answers side by side (**perspective mode**), or let
a **Response Leader** zone brief a panel of sub-agents on deliberately opposing angles,
cross-examine them, and resolve the panel into one synthesized answer (**multizone mode**).

Success is a user who stops paying the tab-switching tax and starts using disagreement between
models as a working method.

## Positioning

The mechanism a neighboring product cannot truthfully copy: **models are configured as
independent participants in one conversation, and can be pointed at each other.**

- Perspective mode fans one prompt to N zones in one shared thread — no fixed limit.
- Multizone mode's Response Leader does not answer from its own knowledge. It spawns sub-agent
  zones, briefs each on an *opposing* angle rather than forwarding the user's message,
  cross-examines them, then writes one answer.
- The **teamwork** tool group lets sub-agents edit the *same codebase at the same time*:
  `claim_files` is an advisory lock the tools themselves enforce (an unclaimed write auto-claims,
  a write to another agent's file is refused), and `post_note` / `team_status` are a shared board
  so decisions travel with parallel edits.
- The shipped **Code Team** is seven zones on one model at seven temperatures. The value comes
  from independent attempts and adversarial review, not from a bigger model.
- Everything is local: no MultiZone account, no server in the middle.

## Operating Context

Windows 10/11 desktop, installed via MSI/NSIS. Users configure providers as OpenAI-compatible
endpoints (frontier APIs, self-hosted servers, LM Studio / local GPU). Work happens against a
project directory on disk; chats carry projects, tags, attachments, checkpoints. Long agent runs
need approvals pre-decided (per-kind policies, allow lists, path boundaries) because a sub-agent
cannot show a prompt.

## Capabilities and Constraints

Confirmed, from the repository README at v0.15.7:

- **Zones** — named provider + model + system prompt + toolset. Curated zone library; **Teams**
  section installs a leader plus its specialists in one action.
- **Perspective mode** — one message fans out to every perspective zone in parallel, one thread.
- **Multizone mode / Response Leader** — `spawn_subagent`, `send_subchat_message`,
  `collect_subagents`, `list_subchats`; `background: true` runs sub-agents concurrently.
  Sub-agents' `ask_user` is suppressed while a leader drives them. Full call tree inspectable in
  the stack tracer; subchats openable and directly conversable; nested in Markdown and PDF export.
- **Teamwork** — `claim_files`, `post_note`, `team_status`. Reads never blocked. Claims expire and
  release at turn end. Single-zone chats never touch it.
- **Code Team** — Code Team Lead, Code Scout, Code Implementer (Careful, 0.15), Code Implementer
  (Inventive, 0.85), Code Test Author, Code Reviewer, Code Verifier. Parallel file-disjoint slices,
  or compete mode on a hard bug (both implementers attack independently, leader picks on test
  evidence).
- **Web tools, keyless** — `smart_search` fans out to seven engines (DuckDuckGo, Bing, Brave,
  Yandex, Ecosia, Yahoo, Wikipedia) merged with Reciprocal Rank Fusion; `smart_fetch` reads pages
  and PDFs as clean markdown; `smart_crawl` follows links within a site. Real Chrome TLS/HTTP-2
  fingerprint, no headless browser — JS-only pages are reported as such, not returned blank.
  Legacy key-based `web_search` providers still available (SearXNG, Brave, Tavily, Serper).
- **Terminals** — `terminal_start/write/read/list/stop` keep a process alive between calls, with
  `delay_ms`, `wait_for` + `timeout_ms`, `wait_ms`. Pipes, not a PTY: servers, build tools and
  REPLs work; full-screen TUIs and interactive `ssh` do not.
- **Replay** — the run as it happened, including declined approvals, failed tools, mid-turn zone
  switches, rewritten plans, plus every tool call's arguments, output and duration.
- **Voice** — dictation via any OpenAI-compatible `/audio/transcriptions` endpoint; dictation
  replaces a selection like typing does. Audio file uploads (MP3, WAV, M4A, MP4, FLAC, OGG, WebM)
  are transcribed to text, so *any* zone can take a meeting recording, including text-only models.
  No speaker diarization — the endpoint does not do it and a guess presented as data is worse.
- **Appearance** — palette, fonts, bloom, shadows, custom CSS, and 13 cursor-reactive animated
  backgrounds: Particles, Orbs, Aurora, Grid, Stars/Shooting stars, Waves, Fireflies, Boids,
  Matrix, Topography, Puzzle, Mountains, Fish. Four sliders: Speed, Density, Opacity, Hue
  variation. Restored before first paint.
- **Connectors (MCP)** — catalog with Gmail, GitHub, Context7, Tavily, filesystem, Playwright;
  import more from a URL; enabled servers self-start at launch; **Diagnose** reports the first
  failing check in order rather than "failed to connect".
- **HTTP API** — `127.0.0.1` only, bearer token, self-describing via `/api/routes` and
  `/api/health`. Covers chats, messages, zones, providers, projects, tags, perspectives,
  sub-agents, skills, memory, MCP, knowledge indexes, checkpoints, usage, settings. SSE streaming
  or `?wait=true`. `app_read` / `app_control` give the assistant the same surface, with every
  write behind an approval prompt.
- **Privacy** — no account, telemetry, analytics, crash reporting or cloud sync. One local SQLite
  file. Two things stated rather than buried: an update check ~2.5s after launch (a plain GET,
  no identifier, disable-able) and **provider API keys stored in plain text** in that database.
- **Platform constraint:** Windows only today (MSI/NSIS installers; WebView2 ships with Win 10/11).
- **License:** Apache 2.0. Free. There is no paid tier and no pricing to state.

## Brand Commitments

- Name: **MultiZone**, one word, capital M and Z.
- Mark: rounded-square app icon, `promo/source.png` — a two-tone geometric **M** where the two
  strokes are different blues and overlap brighter where they cross. The overlap is the idea:
  two zones, one answer.
- App accent: `#4f9cf9` (dark) / `#2f80ed` (light). App ground: `#0b0d10`, panels `#14171c`,
  borders `#2d333d`, text `#e4e6eb`, muted `#8b929e`. The product itself is dark-first.
- Voice, taken from the README: precise, unhedged, technically specific, willing to state its own
  limits in the same breath as its capabilities ("no speaker labels", "keys are stored in plain
  text", "full-screen TUIs do not work"). Never hype. The honesty *is* the pitch.

## Evidence on Hand

Real, in `promo/`:

- `Screenshot 2026-07-29 184437.png` / `promo/build/shot-dark.png` — genuine perspective-mode
  capture, four zones (Ornith 35B-A3B local, Ling 3, DeepSeek-V4-Flash, DeepSeek Pro) answering
  "Who are you?" side by side in one thread.
- `promo/build/shot-light.png` — the same app in light mode.
- `promo/source.png`, `promo/build/icon.png` — the app mark.
- `01-hero.png`, `02-perspectives.png`, `04-features.png`, `05-response-leader.png` — previously
  rendered promo cards (composed graphics, not app captures).

Absences future work must not fabricate: **no user counts, no testimonials, no press, no
benchmark results, no pricing, no company.** The SWE-Bench comparison the panel is aimed at is a
goal, not a measured result — it must not appear as a number. Current version is 0.15.7, pre-1.0.

## Product Principles

1. **Disagreement is the feature.** Other clients pick a model for you; MultiZone shows you the
   spread and, when you want, resolves it. Never present this as "chat with AI".
2. **State the limits alongside the capability.** The README's credibility comes from saying what
   does not work. Marketing that drops that half loses the thing that makes it trustworthy.
3. **Local by construction, not by policy.** There is no server to send anything to — that is an
   architectural fact, not a promise.
4. **Show the mechanism, don't name it.** "Response Leader" means nothing until you watch a leader
   brief four sub-agents on opposing angles and resolve them. Demonstrate; don't define.
5. **Pre-1.0 and honest about it.** Windows-only, version 0.15.7, keys in plain text. Say so.

## Accessibility & Inclusion

No product-specific standard established. The page inherits the ordinary web floor: keyboard
reachable, visible focus, AA contrast, `prefers-reduced-motion` honored across the animated work.
