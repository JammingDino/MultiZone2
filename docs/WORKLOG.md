# Worklog

Dated entries: what changed, what was verified, and what was deliberately left
alone. Newest first. Detail belongs in the linked docs; this is the thread.

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

Four new items were added to the 1.0.0 list, led by the one with the highest
consequence: **the `TAURI_SIGNING_PRIVATE_KEY` secrets are still not in the
repo**, so every published build ships without a signed manifest and every
existing install silently stops seeing updates.

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
