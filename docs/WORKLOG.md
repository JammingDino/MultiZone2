# Worklog

Dated entries: what changed, what was verified, and what was deliberately left
alone. Newest first. Detail belongs in the linked docs; this is the thread.

---

## 2026-08-16 (0.13.4) — The session log becomes opt-in

The PDF export always appended the session log. It is now a setting,
`pdfExportSessionLog`, sitting with the other Chat export controls in
Settings → Appearance, **off by default**.

The reasoning for off: the log is the run as *recorded* rather than as read —
every turn started and finished, every tool run, every approval declined. That
is evidence, and it is what you want for a bug report or an audit. It is not
what you want appended to a document being handed to someone who asked for the
conversation, where a long run means page after page of table.

Scoped to the PDF, as asked. The Markdown export keeps its log section
unconditionally: a markdown file is far more often the machine-readable copy,
and the reason to suppress the log — pages of table in a document a person
reads — does not apply to it. Said so in the setting's own description rather
than leaving it to be discovered.

Existing installs get the default: `loadAppSettings` merges per key over
`DEFAULT_APP_SETTINGS`, so a stored blob without the key picks up `false`.

`npx tsc --noEmit` clean · `npm run build` green · `npm test` 7 passed. Version
0.13.4, `releaseBuild` still true.

---

## 2026-08-16 (backlog) — Study mode

Docs only. Added a study mode to the Post-1.0 backlog, with NotebookLM as the
reference — grounded answering over a project's own sources, plus the artifacts
a reader actually uses: study guide, briefing, FAQ, timeline, mind map,
flashcards, quizzes, audio overview.

The useful part of writing it up was the audit of what already exists. The
corpus (knowledge base with a re-indexing watcher), the citations, the diagram
renderer, TTS and the HTML report renderer are all built, so most of the
artifacts are a skill plus an existing renderer. Two things are genuinely
missing and they are the ones that make it a study tool rather than a chat with
a document:

- **Source-only grounding**, where the refusal is the feature. A study tool that
  quietly fills a gap from the model's own knowledge is worse than none, because
  the gap is invisible exactly where the user is least able to catch it.
  Mechanically it is close to plan mode — a chat state that withholds tools and
  constrains the prompt — which is a shape already built once.
- **Spaced repetition**, which is new state, a scheduler and a UI of its own.

Also corrected COMPETITORS.md, which had dismissed NotebookLM's multimedia as
"out of scope; listed for completeness". Video is fairly out of scope; audio was
undersold — an audio overview is TTS over a corpus we already index, and we
already ship TTS. The larger miss was that the analysis never named the study
tooling at all, which is the thing NotebookLM is actually used for, and the
clearest case where local-first is the product argument rather than a principle:
using NotebookLM means uploading the material, which rules it out for anything
under NDA, unpublished, or personal.

Noted in the entry that this must not be scheduled as one release. The artifacts
are cheap and shippable on their own, and they are the honest test of whether
anyone wants the retention machinery at all.

**Second pass, after seeing NotebookLM's Studio panel.** Its nine generators —
audio overview, slide deck, video overview, mind map, reports, flashcards, quiz,
infographic, data table — are not nine features. Each is a tool that returns
structured data plus a renderer that draws it, which is exactly the
`update_plan` → `PlanBlock` and `render_graph` → `MermaidBlock` pattern already
running in the app. Written up as a table of tool → renderer → what exists, so
the entry sizes them honestly rather than as a wall of new work: the mind map
and the four report types are prompts over renderers we ship today, the slide
deck and infographic are templates over `HtmlReportBlock`, and the audio
overview is a script problem rather than a synthesis one.

Two things fell out of that pass worth recording:

- **The data table converges with 1.1.1**, which already schedules interactive
  tables. Same renderer, different producer — study extracts rows from
  unstructured sources, 1.1.x sorts and filters them. Build once.
- **Video overview** was dismissed in the first pass as a production pipeline.
  That was lazy: it is a slide deck plus an audio overview plus a recorder. If
  the first two land it is a capture step. Still last and still lowest value, but
  no longer refused as a category.

**A "mode surface" is now its own backlog item.** Study mode wants a workspace —
sources on one side, conversation in the middle, generated artifacts collected
somewhere returnable — and so does the code interface. Two modes asking for the
same shell is the signal to build the shell once. That is the roadmap's own
principle applied to itself: components before modes, and a workspace a mode can
furnish is a component. Whichever mode lands first pays for it.

---

## 2026-08-16 (updater) — Correction: the signing secrets were never missing

Docs only, no code.

I recorded "the signing secrets are not in the repo" as the highest-consequence
open item in the 1.0 list. It was wrong, and it was wrong in a way I could have
checked from the tree at the time.

**The evidence is `updater/latest.json`**, which is committed. Every platform
entry for v0.13.0 carries a real 420-character signature — something only a
build holding the private key can produce — and every URL is already the
token-authenticated API asset endpoint, which means `rewrite-updater-manifest.mjs`
is working in production too. The whole CI half of the update path is proven by
an artifact that was sitting in the repository.

What misled me: a local clone genuinely cannot see the secrets, and the compile
prints `MULTIZONE_UPDATER_TOKEN not set — this build cannot check for updates`
on every local build. That warning is about the *local* binary and is expected;
GitHub exposes secrets only to workflows, so a local build produces unsigned
bundles, which is correct for a build that will never be published.

Corrected in RELEASE_PLAN.md (both the 1.0.0 blocker line and the 0.9.12
auto-updater entry), TEST_STRATEGY.md §4, PRE_1.0_PASS.md's "action required"
block, and the earlier worklog entry.

**What is still genuinely unverified** is the receiving half: nobody has watched
an installed build find an update, download it and restart into the new version.
Three releases have shipped, so it needs no special setup — install the previous
one, publish the next, watch it.

The checklist item is now ticked with a command that re-checks it from the tree,
so the next person confirms this in seconds instead of inferring it:

```
node -e "const m=require('./updater/latest.json'); console.log(Object.entries(m.platforms).map(([k,v])=>k+' '+v.signature.length))"
```

---

## 2026-08-16 (0.13.3) — The bug that hid all of it, then the rest

Version 0.13.3, **`releaseBuild` set to `true`** — the next push publishes.

### The bug

The visuals rendered in Replay and nowhere else. The activity rail passes
`hideVisual` on *every* step, and the tab strip read that as "this card already
shows a visual", so it suppressed the family card for every tool in the rail —
and the rail is the whole chat. Replay bypasses it, which is exactly why it was
the one place that worked.

`hideVisual` only ever meant "the lifted visual is on screen elsewhere", and
lifting only applies to the `existing` family (plans, diagrams, plots, saved
files) — which `ToolVisual` returns nothing for anyway. The flag had no business
in that condition. Removed, and the landing tab is now unambiguously Visual
wherever one exists.

Worth recording as a lesson: the feature typechecked, built, and was verified in
the one surface that didn't exercise the real code path.

### Built (0.13.3)

- **Web and page cards.** `smart_search` gets the **engine strip** — which
  engines contributed, which failed. The tool has always returned this and
  nobody could see it, so a result merged from six engines looked identical to
  one from the single engine that happened to answer. `smart_fetch` and
  `smart_crawl` render as page cards with word counts, per-page errors and the
  crawl's shape.
- **HTTP.** Method, URL, status pill — 2xx green, 4xx/5xx red, 3xx amber,
  because a redirect that wasn't followed is a fact rather than a failure —
  headers folded, body shaped rather than escaped. `app_control` shares the
  family since it speaks the same shape against the app's own API.
- **Memory, skills, state.** Scope chips, file chips, and one-line before/after.
  `get_current_datetime` renders with *no card at all*: a bordered panel around
  "it is Tuesday" makes the transcript worse.
- **Export fidelity.** A file write exports as a real `+/−` diff and a shell
  tool as command / output / exit code, both tail-anchored like the screen.
  Sub-agent transcripts already nest under the spawning turn, so an agent card
  there would have duplicated what the export does better — left alone
  deliberately.
- **Family icons on step cards.** A run of twenty steps was a column of
  identical wrenches, and the strip is usually read collapsed.

0.13.x is now complete: 14 families, every built-in tool mapped, MCP tools on
the shaped fallback, and the raw call one click away throughout.

### Verified

`npx tsc --noEmit` clean · `npm run build` green · `npm test` 7 passed.

### Not verified

The new families have not been seen in the shell. The two worth doing first are
in TEST_CHECKLIST §11d: the engine strip with an engine actually blocked, and a
PDF export of a turn that both edited a file and ran a command.

---

## 2026-08-16 (0.13.2) — A Multizone run you can read

Version 0.13.2. 0.13.1's remaining item closed and 0.13.2 built.

### Built

**Agent cards (family 9).** The leader's step list was the least legible part of
the app: a spawn rendered as a JSON object whose most useful field — the
sub-agent's entire answer — was one escaped string. Now: zone name, the task as
prose, a status pill, and **Transcript** expanding in place.

`SubchatTranscript` is exported from `StackTrace.tsx` and reused rather than
reimplemented, so the step and the tracer show the same leader↔sub-agent
exchange and cannot drift. A background spawn reads as still working and names
`collect_subagents` as the way to pick it up, which is the thing a leader
forgets to do.

**The team board (family 10).** The differentiator nothing else surveyed has,
and until now completely invisible. Claims render as file chips with the stated
intent, releases struck through, notes tinted by kind, and `team_status` as the
board itself. Agents are tinted by a hash of their name, so the same agent is
the same colour in the claims list and in the notes feed — that consistency is
what makes a board scannable rather than something read line by line.

**One error look, where the backend earned it.** A write refused because
another agent holds the file carries `error_kind: "claimed"` plus the holder,
their intent and the hold duration. That is the exact moment the teamwork layer
exists for and it was arriving as a red string; it now renders as a board card.

Generic errors are deliberately still their own text on the Output tab. A card
repeating the same string adds nothing, and "every error gets a card" would
have been the kind of consistency that costs more than it returns.

**PDF page facts** (0.13.1's last open item). `read_file` already reported
`page_count` and `pages_read`; a PDF read is a *selection*, so which pages came
back leads the card.

### Verified

`npx tsc --noEmit` clean · `npm run build` green · `npm test` 7 passed.
Checked by hand that `StackTrace` imports nothing from the visuals, so the new
`AgentVisual → StackTrace` edge is not an import cycle.

### Not verified

Nothing in 0.13.2 has run in the shell. New checks are in TEST_CHECKLIST §11d —
the refused-write one needs two agents in one session (have one claim a file,
then have the other write it), which is also the least likely thing to be
exercised by accident.

---

## 2026-08-16 (0.13.1) — Families 2–4, and replay gets the visuals too

### Confirmed working in the app

Both 0.13.0 runtime checks passed, ticked in TEST_CHECKLIST §11d:

- An MCP tool result renders shaped rather than raw JSON.
- A long `run_command` output tail-anchors and stays inside its own scroll.

### Built

**Replay renders the same visuals as the transcript.** This was the ordering
mistake worth fixing early: replay is opened precisely when something went
wrong, so showing a worse view of a tool call there than in the chat was
backwards. The family dispatch moved out of `StepBlock` into `ToolVisual.tsx`
and both call it. Raw output stays below the visual under its own label, and a
tool returning prose rather than JSON behaves exactly as before.

**Family 2 — file card.** `read_file` shows path, size, line count, extension
and the first 15 lines *as text*; previously it was the file's own content
escaped inside a JSON string, which is the worst possible way to look at a file.
Paths are clickable and reveal in the OS file manager. Move and copy read
`from → to`; a delete shows the path struck through.

**Family 3 — tree.** `list_directory` returns a nested object (folder → children,
file → extension) that is compact to send and unreadable to look at; it now
draws as an indented tree with counts, and the backend's `…` depth marker reads
as an ellipsis rather than as a file called "…". `find_files` groups its flat
list by folder. Truncation is stated explicitly — a listing that silently
stopped at the limit is how someone concludes a file isn't there.

**Family 4 — match list.** Hits grouped by file with per-file counts and the
term highlighted. The highlight matches literally rather than compiling the
query: `search_file_text` takes a regex by default, and a highlight that threw
on the user's own pattern would take the whole card down with it.
Knowledge-base passages carry their score and source document.

One design point worth recording: `hasToolVisual` promises the tab strip that a
card exists, so the family components must never render nothing. Their
degenerate cases (a write with no path, an image read that came back as content
parts) fall back to the shaped view rather than leaving an empty pane behind a
tab the reader was invited to click.

### Verified

`npx tsc --noEmit` clean · `npm run build` green · `npm test` 7 passed.

### Not verified

The new families and the replay integration have not been seen in the shell —
new checks are in TEST_CHECKLIST §11d, including replay on a subchat, whose
messages were never opened in the transcript.

---

## 2026-08-16 (later) — 0.13.0 built, and the edit primitive fixed

Version bumped to **0.13.0** across `package.json`, `Cargo.toml` and
`tauri.conf.json`.

**`releaseBuild` was set to `false`.** It had been left `true` by commit
`47c7870` ("marked for release"), which was never pushed — so with the bump, the
next push to main would have published this UI as a release without it ever
having run in the Tauri shell. Flip it back when you actually want to ship.

### Built

**0.14.0's edit fix, landed early** (`tools/filesystem.rs`). 0.13.0's diff
visual is only honest if the edit it draws is the edit that happened, so this
came first.

- Ambiguity is refused with the count, or applied to all with `replace_all`.
  Previously `replacen(.., 1)` edited the first occurrence and reported success.
- An empty `old_text` — which passed `contains` and inserted at offset zero — and
  a no-op edit are both refused.
- A failed exact match retries line-wise ignoring indentation and trailing
  whitespace, re-indenting the replacement onto the file's own indentation.
  Ambiguous tolerant matches are refused too.
- A syntax check reverts the write when the file breaks, reported only as a
  *regression* (parsed before, doesn't after) so the checker's own blind spots
  cancel out. JSON is really parsed; C-like files get a bracket scan that
  understands strings and comments.
- `resolve_edit` is shared with `review::proposal`, so the approval diff and the
  applied edit cannot drift apart.

15 new tests. One of them found a real bug in the bracket scanner: a file ending
inside a `//` comment was treated as unterminated.

**0.13.0 tool visuals.** Family map over all built-in tools, Visual/Input/Output
tabs, shaped fallback, `DiffView` finally called from the step card, and the
terminal family pulled forward from 0.13.1. Errored steps open on Input.

**Testing infrastructure**, from TEST_STRATEGY.md's recommended order:

- `.github/workflows/ci.yml` — build, `npm test`, `cargo test --lib` on every
  push and PR. Nothing ran between releases before this.
- The updater manifest rewrite is now a pure function with 7 fixture tests,
  including the percent-encoded-filename case that would publish a manifest with
  unrewritten URLs and silently stop every install updating.

### Verified

| Check | Result |
| --- | --- |
| `cargo test --lib` | 192 passed, 0 failed |
| `npx tsc --noEmit` | clean |
| `npm run build` | green |
| `npm test` | 7 passed |
| `cargo build --lib` | clean at 0.13.0 |

### Not verified

- **Nothing has run in the Tauri shell.** Every visual is typechecked and built,
  not seen. Runtime checks are in TEST_CHECKLIST.md §11d.
- The CI workflow has never executed — it cannot until something is pushed.
- The edit rules are covered by unit tests; the *approval prompt* showing the
  same diff has not been exercised end to end in the app.

### Still open from the same releases

Windowed `read_file` (0.14.0), families 2/3/4 and 6–13 (0.13.1–0.13.3), and the
mock streaming provider — the one item on the test strategy with the highest
value per hour, and the one that closes "no dropped tokens" for good.

---

## 2026-08-16 — Comparison pass, tool visuals spec, 1.0 test strategy

Docs only. No source changed, nothing to runtime-test.

### What was done

**[BORROWABLES.md](BORROWABLES.md) — new.** A mechanism-level comparison against
roughly twenty open-source agents and chat clients (aider, SWE-agent,
mini-swe-agent, OpenHands, Cline, Roo Code, opencode, Goose, LiteLLM, LibreChat,
LobeChat, Open WebUI, Cherry Studio, CrewAI, AutoGen, SWE-bench and others).
Distinct from COMPETITORS.md, which sizes the market — this one lists specific
mechanisms to implement.

Our own Rust and React were read before the comparison, which changed the
result: six things such a pass would normally surface are already built
(checkpoints with redo, review-before-apply with hunk narrowing, compaction,
plan mode, teamwork locks, cache-aware token accounting) and are recorded as
struck so the next pass does not rediscover them.

Fourteen real gaps found. Every "ours today" claim cites the file it was checked
against. The three sharpest:

- `edit_file` uses `replacen(.., 1)` — when `old_text` appears twice it edits the
  first occurrence and reports success. A wrong edit that claims to have worked.
  [tools/filesystem.rs:1490](../src-tauri/src/tools/filesystem.rs)
- No 429 path anywhere in `llm/client.rs`. A rate limit mid-run kills whichever
  sub-agent hit it, and a seven-member panel meets limits long before one chat.
- Nothing detects a stuck agent. A background sub-agent can repeat a failing
  call until the task budget is gone, and nobody is watching it.

**[TOOL_VISUALS.md](TOOL_VISUALS.md) — new.** `renderToolOutput` handles 5 of 52
tools; the other 47 render as escaped JSON. Spec resolves them into 14 visual
families with a Visual/Input/Output tab strip, so the raw call stays available
rather than being the only thing on offer, plus a shaped fallback so MCP tools
never drop to raw JSON either.

Notable: `DiffView` already exists — built for 0.10.2's approval prompt and
review queue — and the step card has never called it. The file-edit visual is
wiring, not building.

**Scheduling.** [ROADMAP.md](ROADMAP.md) and [RELEASE_PLAN.md](RELEASE_PLAN.md)
gained three pre-1.0 releases:

| Release | Theme |
| --- | --- |
| 0.13.x | Tool visuals — dispatch and fallback, then file/shell tools, then sub-agents and the team board, then the rest and export |
| 0.14.x | The agent floor — edit reliability, loop detection and backoff, per-category approval, `AGENTS.md` and repo map, hybrid retrieval, cost in currency, eval harness |
| 0.15.x | Smaller lifts — chat search, command palette, fork scope, MCP resources/prompts, saved runs, quick assistant |

**[TEST_STRATEGY.md](TEST_STRATEGY.md) — new.** How each open 1.0.0 item can
actually be closed. Three of the six cannot be closed by a manual pass at all.

Ground state recorded while writing it: 37 Rust files carry tests and **CI never
runs them**; there is no frontend test runner; the only workflow fires on
publish, so nothing is verified between releases.

The load-bearing ideas: a mock OpenAI-compatible provider streaming a *known*
token sequence turns "no dropped tokens" from an unfalsifiable claim into a
named-index diff, and needs no provider, key or network — so it also runs in CI.
The updater can be verified end to end locally with a throwaway keypair and two
builds served from `python -m http.server`, without touching the release
pipeline where a build is a publish. Uninstall is a snapshot diff on a VM.

Four new items were added to the 1.0.0 list, led by what was then believed to be
the highest-consequence one: the `TAURI_SIGNING_PRIVATE_KEY` secrets being
absent. **That was wrong — see the correction on 2026-08-16 (updater).**

### Decisions taken

- macOS and Linux installers are a **distribution project, not a test task**.
  Options are laid out in TEST_STRATEGY.md §3; 1.0's scope depends on which is
  chosen and the choice has not been made.
- The edit-engine work in the backlog is not a prerequisite for the code
  interface. The cheap 80% — ambiguity refusal, whitespace tolerance, syntax
  check — is scheduled at 0.14.0 because it helps every zone immediately.
- `Ctrl/Cmd+K` is already bound to composer focus; a command palette would need
  a rebind. Noted in the 0.15.x item rather than silently assumed.

### Not done

- No source changed. Everything above is a plan; none of it is implemented.
- The tool-visual families are specified, not built. Open questions on export
  fidelity per family and on the activity rail's icons are recorded at the
  bottom of TOOL_VISUALS.md rather than guessed at.
- External claims were read from project documentation in August 2026 and not
  from the source of each project. Versions move — confirm before implementing
  against a specific mechanism.
