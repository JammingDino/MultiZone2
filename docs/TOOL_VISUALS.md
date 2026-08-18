# Tool visuals — a look for every tool, and the raw call underneath

Design spec for 0.13.x. Scheduled in [RELEASE_PLAN.md](RELEASE_PLAN.md).

## The problem

`renderToolOutput` in [StepBlock.tsx](../src/components/Message/StepBlock.tsx)
handles five tools — `plot_function`, `update_plan`, `exit_plan_mode`,
`present_file`, `draw_diagram`. There are **52**. Every other tool falls through
to `prettyJson(resultText)`: a wall of escaped JSON in a scrolling `<pre>`.

That is the wrong default twice over. A file edit has an obvious picture (the
diff) and we already have the component that draws it — `DiffView`, built for
0.10.2's approval prompt and review queue, and never called from the step card.
A shell command has an obvious picture (the command, the exit code, the output).
A sub-agent spawn has one (who, what task, how it went). None of them get it.

And the raw call is not redundant — when something goes wrong, the exact
arguments and the exact result string are what you need. Today it is the only
thing on offer; after this it must still be one click away.

## The shape

Every tool step becomes two layers:

```
┌─────────────────────────────────────────────────┐
│ ▸ Step 4 · edit_file          src/lib/parse.rs ✓│   collapsed: one line
├─────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────┐  │
│  │  + 12  − 3   src/lib/parse.rs             │  │   the visual
│  │  ‥ @@ fn parse(…)                         │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  Visual · Input · Output                        │   the tabs
└─────────────────────────────────────────────────┘
```

**Rules for the whole system**

1. **The visual is the default tab.** Input and Output are always present, always
   one click away, never the landing view except in the generic fallback.
2. **A visual never invents.** It renders what the result says; it does not
   summarise with a model or guess at intent. If the result is an error, the
   visual is the error, presented properly — not an empty state.
3. **One card, one height.** Every visual caps at ~320px with its own scroll, so
   a step never pushes the rest of the turn off screen. Same cap `DiffView`
   already uses.
4. **Streaming-safe.** While arguments stream, the header and the input tab
   update; the visual renders once the result lands. No half-parsed visuals.
5. **Families, not bespoke components.** 52 tools resolve to 14 families. A new
   tool joins a family by adding one line to a map, and an unmapped tool still
   gets the shaped fallback rather than raw JSON.
6. **Exportable.** Anything rendered here has to survive Markdown and PDF export
   as at least a text equivalent, the way plans and diagrams already do.

## Families

### 1 · Diff — `create_file`, `edit_file`
`DiffView` unchanged, read-only mode (no hunk checkboxes — the decision was
already made). Header carries `+n / −n` and the path; the path is clickable and
reveals in the OS file manager. A create shows the whole file as added, capped
with a "show all" affordance. **Component exists** — this is wiring, not building.

### 2 · File card — `read_file`, `present_file`, `create_folder`, `move_file`, `copy_file`, `delete_file`
Path chip, size, line count, detected language, and for a read the first ~15
lines syntax-highlighted with a fade-out. Move and copy show `from → to` on one
line. Delete shows the path struck through with what was removed (bytes, lines).
`present_file` keeps its existing `SavedFileChip` / `HtmlReportBlock` treatment.
For a PDF read, show page count and which pages were extracted — `read_file`
already reports that.

### 3 · Tree — `list_directory`, `find_files`
Indented tree with folder/file icons, entry counts per folder, truncation marked
explicitly ("+ 41 more") rather than silently. Respects the `depth` argument
visually. Rows are click-to-copy path.

### 4 · Match list — `search_file_text`, `search_local_files`
Grouped by file, each hit as `line №` plus the line with the match highlighted.
File header shows the hit count. Collapsed to the first 3 files with the rest
behind a disclosure. For `search_local_files` (knowledge base) each hit carries
its similarity score and its source document, which is also what the citation
UI wants.

### 5 · Terminal — `run_command`, `execute_code`, `wsl_exec`, `terminal_start`, `terminal_write`, `terminal_read`, `terminal_stop`, `terminal_list`
Monospace block: the command on a prompt line, then stdout/stderr with stderr
tinted, then an exit-code pill (green 0, red non-zero) and duration. ANSI colour
parsed rather than shown as escapes. Long output tail-anchored — the last 200
lines with "scrolled to end", because the end is what matters. For the
persistent terminals, the header names the session and shows whether it is still
alive.

### 6 · Web results — `smart_search`
Ranked result rows: title, domain, snippet. Above them, the engine strip —
a chip per engine, coloured by contributed / returned nothing / failed — which is
information the tool already returns and currently nobody sees. Rows open in the
system browser.

### 7 · Page card — `smart_fetch`, `smart_crawl`
Title, domain, word count, and whether it was PDF or HTML. Body as collapsed
markdown, first ~20 lines, expandable. For a crawl, one row per page with its
own expander, plus the crawl's shape (pages visited / links followed / stopped
because).

### 8 · HTTP exchange — `http_request`
Method + URL on one line, status pill, duration, response size. Two sub-panes:
request headers/body, response headers/body, both JSON-shaped when the content
type says so. This is the one family where the "raw" view and the visual nearly
coincide — the value is in the shaping and the status pill.

### 9 · Agent card — `spawn_subagent`, `send_subchat_message`, `collect_subagents`, `list_subchats`, `read_subchat`
Zone avatar and name, the task line, a status pill (running / done / failed /
background), turn count, and **Open transcript** — which already exists in the
stack tracer and should be reachable from the step that caused it. `collect`
shows one row per sub-agent with its result folded. This is the family that most
changes how a Multizone run reads, because the leader's step list is currently
the least legible part of the app.

### 10 · Team board — `claim_files`, `release_files`, `post_note`, `team_status`
File chips tinted by owning agent, with the stated intent on hover. A refused
write shows who holds the file and since when. `post_note` renders as a board
entry with author avatar and timestamp; `team_status` as the whole board —
agents down one side, claims and notes beside them. The teamwork layer is a
genuine differentiator and currently invisible.

### 11 · Memory — `save_memory`, `read_memory`, `delete_memory`
Scope chip (global / project / chat), the fact itself as prose, and on an
overwrite the previous value struck through above the new one. A delete shows
what was forgotten. Reads show the matched entries with their scopes.

### 12 · Skill — `load_skill`, `create_skill`, `update_skill`
Name, one-line description, the tools it enables as chips, and the body
collapsed. An update diffs against the previous version using family 1.

### 13 · State change — `change_zone`, `list_zones`, `tag_chat`, `app_control`, `app_read`, `compact_context`, `get_current_datetime`, `enter_plan_mode`
Before → after, stated in one line with the two states as chips: zone A → zone
B, theme dark → light, tags + `research`. `compact_context` gets a token bar —
before, after, what fraction of the window is now free — which is the one number
a user wants at that moment. `list_zones` is a chip row. `get_current_datetime`
is a single inline line with no card at all; some tools do not deserve a box.

### 14 · Existing renderers — `plot_function`, `draw_diagram`, `update_plan`, `exit_plan_mode`, `ask_user`
Unchanged. They become families rather than special cases in the dispatch, and
inherit the Input/Output tabs they currently lack.

### Fallback — MCP tools and anything unmapped
Never raw JSON. Shape it: an array of objects becomes a table; an object becomes
a key/value list with nested objects collapsible; a bare string becomes markdown;
a string that parses as JSON gets shaped too. MCP tools are unbounded in number,
so the fallback is the most-used renderer in the system and deserves to be the
best-built one, not the leftover. Where an MCP server declares an output schema,
use it to label columns.

## Tool → family map

| Tool | Family | Visual in one line |
| --- | --- | --- |
| `create_file` | 1 Diff | Whole file as an addition, path clickable |
| `edit_file` | 1 Diff | `+n/−n` hunks, read-only `DiffView` |
| `read_file` | 2 File | Path, size, lines, first 15 lines highlighted |
| `present_file` | 2 File | Existing file chip / HTML report card |
| `create_folder` | 2 File | Path created, parent shown |
| `move_file` | 2 File | `from → to` |
| `copy_file` | 2 File | `from → to`, copy icon |
| `delete_file` | 2 File | Struck path, bytes/lines removed |
| `list_directory` | 3 Tree | Indented tree, counts, explicit truncation |
| `find_files` | 3 Tree | Matched paths grouped by folder |
| `search_file_text` | 4 Match | Hits grouped by file, term highlighted |
| `search_local_files` | 4 Match | Chunk hits with score and source doc |
| `run_command` | 5 Terminal | Command, output, exit pill, duration |
| `execute_code` | 5 Terminal | Language chip, source collapsed, output |
| `wsl_exec` | 5 Terminal | Distro chip, otherwise as `run_command` |
| `terminal_start` | 5 Terminal | Session id, shell, cwd, alive dot |
| `terminal_write` | 5 Terminal | Input echoed, resulting output |
| `terminal_read` | 5 Terminal | Tail of the buffer, tail-anchored |
| `terminal_stop` | 5 Terminal | Session closed, exit code |
| `terminal_list` | 5 Terminal | One row per session with liveness |
| `smart_search` | 6 Web | Engine strip + ranked results |
| `smart_fetch` | 7 Page | Title, domain, words, collapsed body |
| `smart_crawl` | 7 Page | Per-page rows + crawl shape |
| `http_request` | 8 HTTP | Method/URL, status pill, req/res panes |
| `spawn_subagent` | 9 Agent | Zone, task, status, open transcript |
| `send_subchat_message` | 9 Agent | Message sent, reply folded |
| `collect_subagents` | 9 Agent | Row per agent, results folded |
| `list_subchats` | 9 Agent | Roster with status pills |
| `read_subchat` | 9 Agent | Transcript preview + open |
| `claim_files` | 10 Board | File chips tinted by owner, intent on hover |
| `release_files` | 10 Board | Released chips, greyed |
| `post_note` | 10 Board | Board entry, author, timestamp |
| `team_status` | 10 Board | Agents, claims and notes as one board |
| `save_memory` | 11 Memory | Scope chip, fact, previous struck |
| `read_memory` | 11 Memory | Matched entries by scope |
| `delete_memory` | 11 Memory | What was forgotten |
| `load_skill` | 12 Skill | Name, description, tool chips |
| `create_skill` | 12 Skill | As above, marked new |
| `update_skill` | 12 Skill | Diff against previous version |
| `change_zone` | 13 State | `zone A → zone B` |
| `list_zones` | 13 State | Chip row |
| `tag_chat` | 13 State | Tags added/removed as chips |
| `app_control` | 13 State | Setting: before → after |
| `app_read` | 13 State | Setting and its value |
| `compact_context` | 13 State | Token bar before/after, freed % |
| `get_current_datetime` | 13 State | Inline line, no card |
| `enter_plan_mode` | 13 State | Mode chip |
| `plot_function` | 14 Existing | `MathPlotBlock` |
| `draw_diagram` | 14 Existing | `MermaidBlock` |
| `update_plan` | 14 Existing | `PlanBlock` |
| `exit_plan_mode` | 14 Existing | `PlanProposalBlock` |
| `ask_user` | 14 Existing | Inline question/answer |
| *MCP and anything else* | Fallback | Shaped table / key-value, never raw JSON |

## Errors

Every family needs its failure look, because failures are what people expand.
The rule: the error is the visual, in the family's own language. A refused write
shows the claim that blocked it (family 10), not a red box with a string. A
non-zero exit shows the exit pill and stderr (family 5). A 404 shows the status
pill (family 8). Where a tool returns `{"error": ...}` and nothing else, the card
is the error text plus the input tab pre-opened — because that is the tab you
wanted.

## Build order

1. **Dispatch + tabs + shaped fallback.** Every tool improves the day this lands,
   because the fallback replaces raw JSON everywhere. Families 1 and 14 wire up
   in the same pass since their components exist.
2. **Families 5, 2, 3, 4** — the file and shell tools, which are most of what an
   agent run actually does.
3. **Families 9 and 10** — sub-agents and the team board, the highest-value
   legibility win for Multizone mode.
4. **Families 6, 7, 8, 11, 12, 13** — the rest.

## Open questions

- Does the activity rail in compact mode show family icons rather than one
  wrench for everything? Probably yes, but it is a separate visual budget.
- Should the Input tab render arguments through the same shaper as the output?
  Leaning yes — a tool call with a 400-line `content` argument has the same
  readability problem as its result.
- Export fidelity per family is unspecified above. Families 1, 5 and 9 clearly
  need a text form in Markdown export; the rest may be fine as their existing
  summary line.
