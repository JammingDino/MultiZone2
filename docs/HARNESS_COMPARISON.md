# Harness comparison — pi, opencode, MultiZone (September 2026)

What each harness sends to the model before the user says a word: the system
prompt and the default tool set. Sources read at HEAD on 2026-09-17:
`badlogic/pi-mono` (`packages/coding-agent/src/core/`), `anomalyco/opencode`
(`packages/opencode/src/{session,tool,agent}/`), and our
`src-tauri/src/{commands/messages.rs,tools/}`.

Figures for MultiZone were measured by building the actual tool list and
system snippets for three zone shapes in a test (bare zone prompt, no
project, no skills). Figures for the others are summed from their source
files. ~4 chars/token throughout.

## Per-turn baseline

| | pi (defaults) | opencode (build agent) | MultiZone: Code Companion | MultiZone: Code Team Lead |
|---|---|---|---|---|
| Tools offered | 4 (`read`, `bash`, `edit`, `write`) | ~12 (`bash`, `read`, `edit`, `write`, `glob`, `grep`, `task`, `todowrite`, `webfetch`, `websearch`*, `skill`, `question`) | **26** | **30** |
| Tool schema size | ~2.2k chars / ~0.55k tok | ~16k chars / ~4k tok | 22.0k chars / ~5.5k tok | 22.5k chars / ~5.6k tok |
| Harness system prompt | ~1.7k chars / ~0.4k tok | 8.6k chars / ~2.2k tok (`default.txt`; per-model variants 4–15k) | 2.2k chars / ~0.55k tok | 4.8k chars / ~1.2k tok |
| + user's own prompt | AGENTS.md if present | AGENTS.md if present | zone prompt (~1.4k chars for Code Companion) + AGENTS.md | zone prompt (~4k chars) |
| **Baseline total** | **~1k tok** | **~6.3k tok** | **~6.4k tok** | **~7.8k tok** |

\* `websearch` only when an Exa/Parallel key is configured.

The headline: our total is level with opencode's but the mix is inverted.
opencode spends its budget on a long behavioural prompt and a dozen tools;
we spend it on 26–30 tool schemas and keep the harness prompt short. pi
spends almost nothing and leans on the model already knowing how to code.

Our largest single schemas, Code Companion: `render_chart` 2.2k chars,
`draw_diagram` 1.5k, `smart_fetch` 1.4k, `create_skill` 1.3k,
`plot_function` 1.2k, `compact_context` 1.2k. Six tools a coding zone will
rarely call cost more than pi's entire request.

## System prompt: what each one says

### pi — `system-prompt.ts`
About 15 lines. One-sentence identity ("expert coding assistant operating
inside pi"), a one-line-per-tool list, a rules block that tools contribute to
("Use edit for precise changes…", "Use write only for new files…", "Be
concise", "Show file paths clearly"), a pointer to pi's own docs, project
context files, a skills list, and the cwd. Every section is wrapped in an XML
tag of its own name so an extension can replace one section and the
transcript can diff it (`diffSystemPromptSections`) — the prefix-cache
concern handled by making sections addressable rather than by ordering them.

No tone rules, no proactiveness rules, no git rules, no "never commit". pi's
position is that a frontier model does not need to be told these things.

### opencode — `session/prompt/*.txt` + `system.ts`
Claude Code's prompt, forked and then tuned per model family: `anthropic.txt`,
`gpt.txt`, `codex.txt`, `gemini.txt`, `kimi.txt`, `beast.txt` (GPT-4-era),
`meta.txt`, `trinity.txt`, `default.txt`. Selection by model id substring. All
of them carry: tone rules with worked `<example>` blocks (one-word answers
are best), proactiveness limits, "follow conventions / never assume a library
is available", "NEVER commit unless asked", tool-usage policy (batch
independent calls; prefer `Task` for open-ended search; prefer dedicated
tools over bash for file ops), and `file_path:line_number` references. The
Anthropic variant adds a "professional objectivity" section and pushes
`TodoWrite` hard ("Use these tools VERY frequently"). After the prompt:
an `<env>` block (cwd, worktree, git yes/no, platform, date), a verbose skills
list, and MCP server instructions.

Plan mode is a separate *agent* with edit permissions denied, plus a
synthetic reminder part appended to the user message (`reminders.ts`) rather
than a system-prompt section.

### MultiZone — `build_system_snippets`
Assembled from typed snippets, ordered most-stable-first for prefix caching:
zone prompt → project AGENTS.md → loop preamble (`continuity.rs`) → plan
mode / approved plan / plan offer → skills catalog → knowledge index → repo
map → project & tag context → leader roster → multi-zone identity → memories.

What we say that neither of them does:
- **The loop is explained.** "You are running in a loop… up to N times this
  turn. Never announce an action without taking it." Plus stall detection and
  a nudge when the model narrates instead of acting. Both competitors assume
  a model that keeps going; ours was written for local models that do not.
- **Plan offer** (1.1k chars, every tooled zone): when to call
  `enter_plan_mode` instead of writing a numbered list.
- **Leader preamble** (2.6k chars): the delegation protocol and roster.
- **Repo map**, **knowledge index**, **memories**: context neither competitor
  injects (opencode reads AGENTS.md; pi reads context files; neither has a
  memory store or a ranked symbol map).

What we do not say that opencode does, at length: tone and verbosity, don't
commit, don't add comments, check the library exists, run lint/typecheck
when done, batch tool calls. These live in our *zone prompts* instead
(Code Companion's seven "How you work" points cover the substance), which is
the right place for a product where the user authors the agent — but it means
a user-made zone with an empty prompt gets none of it.

## Tools, one by one

### Read
- **pi**: `read(path, offset?, limit?)`. Text truncated at 2000 lines / 50KB,
  images attached. Relative or absolute paths.
- **opencode**: `read(filePath, offset?, limit?)`. Absolute paths only. 2000
  lines default. Every line prefixed `N: ` so the model can quote line
  numbers; the edit tool's description then spends a paragraph explaining
  how to strip that prefix. Reads directories too. Images and PDFs attached.
- **ours**: `read_file(path, offset?, limit?, pages?, as_image?, as_text?)`.
  1200 lines default, 5000 max; reports total lines and the window so the
  model continues with `offset`. PDF handling is the most capable of the
  three (page images for vision models, text for the rest, page ranges). The
  vision-only options are withheld from text-only models.

### Edit
- **pi**: `edit(path, edits[{oldText,newText}])` — **multiple disjoint edits
  in one call**, each matched against the original file. Fewer round trips on
  a multi-hunk change than either of the other two.
- **opencode**: `edit(filePath, oldString, newString, replaceAll?)`.
  **Refuses to edit a file that has not been read this session** (enforced
  by the tool, not the prompt). GPT models get `apply_patch` instead.
- **ours**: `edit_file(path, old_text, new_text, replace_all?)`. Same shape as
  opencode; lenient whitespace matching when exact fails (neither competitor
  does this — it saves a retry on local models that reflow indentation).
  Read-before-edit is advice in the description, not enforced.

### Write
All three: create-or-overwrite, parents created. opencode's description
adds "NEVER proactively create documentation files (*.md)". Ours says use
`edit_file` for partial changes.

### Search
- **pi**: none by default. The rule "Use bash for file operations like ls, rg,
  find" is added to the prompt when grep/find/ls are off. They exist as
  opt-in tools.
- **opencode**: `glob` and `grep` (ripgrep), each ~600 chars, both pointing
  at `Task` for open-ended searches.
- **ours**: `find_files` and `search_file_text`, ~1k chars each, plus
  `list_directory` (nested JSON with a depth). Equivalent capability; twice
  the description.

### Shell
- **pi**: `bash(command, timeout?)`. Output truncated to the last 2000
  lines / 50KB; **full output saved to a temp file and the path returned**.
- **opencode**: `bash(command, timeout?, workdir?, description)`. Truncated
  and spilled to a truncation directory. Description carries OS/shell, a
  temp dir, "DO NOT use it for file operations", and a nine-line git/GitHub
  policy.
- **ours**: `run_command(command, shell?)`. **No output cap.** `cat` on a
  20MB log goes into context whole. `terminal_*` clips at 30k chars and WSL
  at 100k, but the plain shell tool does not. This is the one concrete
  correctness gap in the table.

### Delegation
- **pi**: none built in (extensions).
- **opencode**: `task(description, prompt, subagent_type, task_id?)`.
  Fresh context per call, resumable by id, background with notification.
  Agent types (`general`, `explore`) are permission profiles over the same
  tool set.
- **ours**: `spawn_subagent` / `send_subchat_message` / `collect_subagents` /
  `list_subchats` / `read_subchat` — five tools where opencode has one, but
  the sub-agent is a *zone* (its own model, prompt, temperature, toolset),
  which is the product's whole point. Plus `teamwork` (`claim_files`,
  `release_files`, `post_note`, `team_status`) for parallel edits on one
  tree, which neither competitor has at all.

### Progress and planning
- **pi**: nothing.
- **opencode**: `todowrite` — 2k-char description ending "When in doubt, use
  it", and the Anthropic prompt reinforcing it. Plan mode is a separate agent
  with writes denied.
- **ours**: `update_plan` (checklist) + `enter_plan_mode` / `draft_plan_step`
  / `exit_plan_mode` / `read_plan` (a plan the user edits and approves,
  which then becomes the task list) + the plan-offer preamble. More
  machinery than opencode; the approve-then-execute loop is a real feature
  they lack, but it is five tools and a preamble to express it.

### Ask the user
opencode `question` ≈ our `ask_user`. Same shape (options, custom answer,
"(Recommended)" convention). Ours is 1.5k chars, theirs 0.7k.

### Skills
All three: catalog in the system prompt, load-on-demand tool. opencode's
comment is worth stealing: models "ingest the information about skills a bit
better if we present a more verbose version in the system prompt and a less
verbose version in the tool description". Ours also has `create_skill` and
`update_skill` (2k chars between them) on every zone with skills.

### Web
- pi: none. opencode: `webfetch`, `websearch` (Exa). Ours: `smart_search`,
  `smart_fetch`, `smart_crawl`, `http_request`.

### Memory
Only ours (`save_memory` / `read_memory` / `delete_memory`, scoped
chat/project/global). The other two rely on AGENTS.md and the user.

### Compaction
- **pi**: harness-driven. Measures context tokens against the model's
  window minus a 16k reserve; when over, runs a separate summarisation call
  with a structured template (goals, decisions, files touched, open items),
  and replaces the history. The model is never asked to decide.
- **opencode**: harness-driven, same shape (`overflow.ts` → `compaction.ts`),
  with an auto-continue afterwards and plugin hooks on the prompt.
- **ours**: a **tool the model calls** (`compact_context`) with its own
  summary, at moderate safety (approval). Until today a system-prompt nudge
  told it when; that nudge counted the whole history rather than the
  uncompacted remainder, so it nagged forever after the first compaction and
  was removed. Nothing now triggers compaction except the model's judgement
  or the user asking. Both competitors' approach — measure the provider's
  reported `prompt_tokens` against the window and compact from the harness —
  would be more reliable and would take the 1.2k-char tool off every zone.

## Where this leaves us

**Advantages that are real and theirs to envy:** zones as sub-agents,
teamwork locks, user-approved plans, memory, repo map, PDF reading, the
loop preamble for weak models, snippet ordering for prefix caches.

**Costs we pay that they don't:**
1. Tool-schema weight. 26 tools for a pair programmer; six of them (charts,
   diagrams, plots, skill authoring, compaction) cost ~9k chars and are
   rarely used in a coding turn. The path hint (`PATHS: working directory
   is …`) is repeated in every file tool's description — eleven copies on
   the team lead, ~2.7k chars — where opencode states the cwd once in
   `<env>` and pi once in `<cwd>`.
2. No shell output cap. The one item here that is a bug rather than a
   trade-off.
3. Compaction is opt-in by the model. Both competitors trigger it from
   measured usage.
4. Behavioural defaults live only in zone prompts. A blank custom zone gets
   the loop preamble and nothing about conventions, committing, or
   verbosity.

**What to lift, in order of return per line of code:**
1. Cap `run_command` output like `terminal_*` already does; spill the rest to
   a file and return the path (pi's pattern).
2. State the working directory once in the system prompt and drop the
   per-tool `PATHS:` paragraph.
3. Multiple edits per `edit_file` call (pi's `edits[]`).
4. Harness-driven compaction from reported `prompt_tokens` vs. the model's
   context window; keep `compact_context` for the manual case only.
5. A short default rules block for tooled zones with an empty prompt
   (conventions, don't commit, verify) — opencode's substance at pi's length.
