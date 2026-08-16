# Borrowables — mechanisms worth taking from open source

A comparison pass run on 16 Aug 2026 against MultiZone 0.12.7 (commit `47c7870`).
Companion to [COMPETITORS.md](COMPETITORS.md), which sizes the *market*; this
file is only about *mechanisms* — specific things other projects do that we do
not, checked against our own source rather than against our feature list.

Scheduled into [RELEASE_PLAN.md](RELEASE_PLAN.md) as 0.14.x (the agent floor)
and 0.15.x (the smaller lifts). Nothing here is unscheduled.

**Method.** Our own Rust and React were read first, because the roadmap
understates what is built. Checkpoints with redo, review-before-apply with
per-hunk narrowing, staged writes, compaction, teamwork locks, plan mode and
per-model token calibration are all present and substantial. Several things a
comparison would normally surface are therefore struck rather than listed — see
"Already built" at the bottom, so they do not come back around next pass.

Every "ours today" claim was confirmed by reading the file named beside it.

---

## Gap matrix

| Area | State | Ours today | Prior art | Borrow |
| --- | --- | --- | --- | --- |
| Edit reliability | gap | Exact byte match, first occurrence, silent on ambiguity, no post-edit check — `tools/filesystem.rs:1490` | aider, SWE-agent | Whitespace-tolerant fallback, ambiguity refusal, syntax check with auto-revert |
| Code navigation | gap | `find_files` + `search_file_text`; no symbol index | aider | Repo map: tree-sitter symbols ranked by PageRank over the reference graph, fitted to a token budget |
| Loop / stall detection | gap | Nothing — a sub-agent can repeat a failing call until the task budget runs out | OpenHands `controller/stuck.py` | Sliding window over hashed (tool, args, result); 4 repeats → stop, 3 repeated errors → fail the turn |
| Rate-limit handling | gap | No retry, no backoff, no 429 path — `llm/client.rs` | LiteLLM router | Exponential backoff on 429/5xx, per-provider cooldown after N fails, fallback zone |
| Spend visibility | partial | Tokens tracked well incl. cache hits — `llm/tokens.rs`. No currency anywhere | LiteLLM, Cline | Bundled price table keyed by model; cost per turn and per sub-agent |
| Retrieval quality | partial | Embed-only brute-force cosine, fixed chunks — `knowledge/mod.rs` | Open WebUI | BM25 via FTS5 fused with the vector score (~0.5 weight), cross-encoder rerank top 20→8 |
| Approval granularity | partial | Global auto-approval up to "Everything" — the documented pre-flight for a long run | Roo Code, opencode | Per-category approval, shell allow/deny prefixes (longest match wins), per-zone overrides |
| Project conventions | gap | No `AGENTS.md` / `CLAUDE.md` reader; project knowledge lives only in our own store | OpenHands skills, opencode | Read the repo's agent file into the system prompt; path-triggered rules injected on first touch |
| Verification loop | gap | Code Verifier runs builds by prompt convention; nothing enforced by the tools | aider `--auto-lint` / `--auto-test` | Per-project lint and test commands, failures fed back as the next turn's input |
| MCP surface | partial | `tools/list` and `tools/call` only — `mcp/mod.rs:639,691` | Goose, Open WebUI | `resources/list` as attachable context, `prompts/list` as slash commands |
| Reusable runs | gap | Zones and teams are configs; a repeated task is retyped | Goose recipes | Parameterised saved runs — prompt template + zone + params, shareable as one file |
| Conversation branching | partial | Fork exists in `MessageActions.tsx`; single behaviour | LibreChat, LobeChat | Fork scope (visible path / with branches / all) and standalone-vs-continuation |
| Finding past work | gap | No cross-chat search, no command palette | LobeChat, Cherry Studio | Full-text search across messages (FTS5 already available); palette over zones, chats, settings |
| Measurement | gap | No eval harness; `scripts/` holds an icon script and a manifest rewriter | SWE-bench, mini-swe-agent | A runner pointing a zone or team at SWE-bench Verified, reporting pass rate per config |

---

## Ranked, with the reasoning

### 01 — Make `edit_file` hard to get wrong

An edit fails outright if a single trailing space differs, and succeeds
*wrongly* if `old_text` appears twice: `replacen(.., 1)` takes the first hit
without saying so. Both cost turns, and turns are what a panel spends.

Three changes, all in `tools/filesystem.rs`:

1. Count occurrences before writing; refuse with the count when it is not 1.
2. On no match, retry with whitespace-normalised and indentation-shifted
   comparison before giving up.
3. After writing, run a syntax check for the language and auto-revert with the
   error if it broke.

SWE-agent attributes roughly a doubling of their benchmark score to the
combination of a windowed file view and a syntax-checked edit. Their stated rule
for (3) is worth keeping: never add a guardrail whose false-positive rate you
cannot show is low — a syntax check qualifies, a style check does not.

Related: the backlog's "File editing as an engine, not a tool" describes the
same problem at larger scope. This is the cheap 80% of it, and it is not a
prerequisite for the code interface — it helps every zone today.

### 02 — Loop detection on the agent turn

The one failure mode with no floor under it. Nothing stops a sub-agent repeating
a call that keeps failing, and nobody is watching a background sub-agent.

Hash `(tool_name, arguments, result)` per step, keep a window of the last ~12,
and act on repeats: four identical triples stops and surfaces it; three
consecutive identical errors fails the turn with the error rather than burning
the budget. OpenHands also catches the ping-pong case — two action/observation
pairs alternating for six cycles — which is the shape a stuck agent takes when
it "fixes" one thing by breaking another.

The stack tracer already has somewhere to show this.

### 03 — Backoff, cooldown, fallback in the LLM client

There is no 429 path at all. A rate limit mid-run kills whichever sub-agent hit
it, and a seven-member panel hits limits far sooner than one chat does.

Exponential backoff with jitter on 429 and 5xx; per-provider cooldown after
three failures in a window; an optional fallback zone per zone so a leader keeps
going on a second provider instead of losing a panel member. Confined to
`llm/client.rs`.

### 04 — Per-category approval

The README tells users to set auto-approval to *Everything* before a long run,
because a sub-agent cannot show a prompt. That is a real constraint solved the
blunt way.

Split approval into read / edit / shell / MCP / spawn. Give shell an
allow-prefix and deny-prefix list where the longer match wins (Roo Code's rule,
and it resolves the "allow `git`, deny `git push`" case correctly). Let a zone
carry its own overrides, so a scout gets read and search, an implementer gets
edit inside the project root, and nobody gets unreviewed shell by default.

### 05 — A repo map for the first turn

Every agent on a new project spends its opening turns rediscovering the layout,
and seven agents pay that cost seven times.

Tree-sitter symbol index → PageRank over the who-references-whom graph → top N
rendered into a fixed token budget, injected at session start. aider defaults to
1k tokens and expands when no files are in context. Largest item here, and the
biggest single lever on how fast Code Scout becomes useful.

### 06 — Read the repo's own agent file

Project memory is good but private to us. Most repos an agent meets now carry
`AGENTS.md` or `CLAUDE.md`. On project open, load it into every zone's system
prompt for that project. Then add the path-triggered form — a rule that fires the
first time a matching file is read — which is how OpenHands keeps
directory-specific conventions out of the base prompt.

The base case is an afternoon.

### 07 — Lint and test commands the tools actually run

Code Verifier runs builds because its prompt says so. Make it structural: per-project
lint and test commands in settings, run after an edit batch, output fed back as
the next turn's input. This is what turns "the implementer thinks it is done"
into evidence, and it is what a compete-mode leader needs to choose between two
diffs on something other than prose.

### 08 — Hybrid retrieval and a rerank

Brute-force cosine over fixed chunks misses exact-token queries — an error
string, a config key, a function name — which is most of what a coding agent
looks up. SQLite gives us FTS5: score BM25 alongside the vector score, fuse at
roughly equal weight, rerank the top ~20 to ~8. Same shape as the RRF already
running in `smart_search`, applied to the local index.

### 09 — Cost in currency, per sub-agent

Token accounting is already the careful part and it reads `cached_tokens` across
OpenAI and DeepSeek shapes. Add a bundled, refreshable price table (LiteLLM's
`model_prices_and_context_window.json` is the community-maintained one) and the
panel gets a number people reason about: what that seven-zone run cost, split by
member. It is also the honest answer to our own premise, since the argument for
a panel is that it beats one model per dollar.

### 10 — An eval harness

The stated goal is that the panel beats a single local model, and there is
currently no way to know. A runner that takes a zone or team config, executes
SWE-bench Verified instances, and reports pass rate makes every item above
measurable instead of plausible. mini-swe-agent is the reference for how little
scaffolding this needs: bash only, no tool-calling interface, ~100 lines, >74%
on Verified.

---

## Smaller lifts

| Change | Source | Why it lands here |
| --- | --- | --- |
| Cross-chat search | LobeChat | Subchats multiply conversations by the size of the panel; there is no way to find one |
| Command palette | LobeChat, Cherry Studio | Zones, chats, settings and skills are all named things behind menus |
| Fork scope options | LibreChat | Fork exists; missing is whether the copy carries branches, and standalone vs continuation |
| MCP resources and prompts | Goose | Two protocol calls buy attachable context and slash commands |
| Saved parameterised runs | Goose recipes | Teams encode who does the work; recipes encode the task, with parameters, in a tradeable file |
| Windowed file view | SWE-agent | `read_file` serves whole files; a 100-line window with scroll and in-file search was worth measurable score |
| Quick assistant window | Cherry Studio | Global-shortcut mini window over the base zone — the fast end of our own fast-to-thorough spectrum |
| Explicit step and cost caps | CrewAI, AutoGen | Task length is a turn budget; delegation depth, total spend and handoff-back termination are the other three |

---

## Already built — struck from the list

| Would have suggested | Already there |
| --- | --- |
| Cline-style checkpoints | `checkpoints.rs` (1,590 lines) — rewind to message, subset restore, and a checkpoint of the restore so undo is undoable |
| Per-hunk diff approval | `review.rs` — diff preview, hunk narrowing that rewrites the call arguments, staging queue whose staged content is what `read_file` serves back |
| Context condensing | `tools/compact.rs`, with a cutoff that will not split the turn that triggered it |
| Plan mode | `plan_mode.rs`, `update_plan`, the task panel |
| Concurrent-edit safety | `teamwork.rs` — advisory claims enforced at the tool layer, auto-claim on unclaimed write, expiry and release on turn end. Nothing surveyed has an equivalent |
| Cache-aware accounting | `llm/tokens.rs` — reads `cached_tokens` across OpenAI and DeepSeek shapes, calibrates chars-per-token per model |

---

## The short version

The gaps cluster in one place. Orchestration, review, checkpointing and
coordination are ahead of most of the field. What is behind is the layer
underneath: the edit primitive, the retry path, the retrieval, the guardrails on
a runaway turn. A panel of seven agents amplifies whatever is under it,
including a bad edit primitive. Items 01–03 are small, confined to files that
already exist, and raise the floor every zone stands on.

---

## Sources

Read August 2026. Versions move; confirm specifics before implementing against them.

- SWE-agent — <https://swe-agent.com/latest/background/aci/>
- mini-swe-agent — <https://github.com/SWE-agent/mini-swe-agent>
- aider edit formats — <https://aider.chat/docs/more/edit-formats.html>
- aider repo map — <https://aider.chat/docs/repomap.html>
- aider lint/test — <https://aider.chat/docs/usage/lint-test.html>
- OpenHands stuck detector — <https://docs.openhands.dev/sdk/guides/agent-stuck-detector>
- OpenHands skills / microagents — <https://docs.openhands.dev/>
- LiteLLM routing — <https://docs.litellm.ai/docs/routing>
- Roo Code auto-approval — <https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions>
- opencode agents & permissions — <https://opencode.ai/docs/agents/>
- Cline checkpoints — <https://docs.cline.bot/features/checkpoints>
- Cline auto-compact — <https://docs.cline.bot/features/auto-compact>
- LibreChat fork — <https://www.librechat.ai/docs/features/fork>
- LobeChat branching — <https://lobehub.com/changelog/2024-11-27-forkable-chat>
- Open WebUI RAG — <https://docs.openwebui.com/features/chat-conversations/rag/>
- Goose sub-recipes — <https://block.github.io/goose/docs/guides/recipes/sub-recipes/>
- CrewAI hierarchical process — <https://docs.crewai.com/en/learn/hierarchical-process>
- AutoGen termination — <https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/tutorial/termination.html>
- Cherry Studio — <https://docs.cherry-ai.com/docs/en-us/cherry-studio/preview>
