# Configure Zones — current-state replica

`index.html` is a static, self-contained reproduction of MultiZone's **Configure
Zones** modal in its *Edit zone* state — the screen as it ships today, not a
proposal. Open it in a browser; nothing else is needed. It exists so a redesign
can start from the real thing instead of a description of it.

It covers the **whole** editor panel, not just the part visible without
scrolling. The screen is far longer than one viewport, and its length is
arguably its central problem, so the replica shows all of it.

## What it reproduces

| Region | Source |
|---|---|
| Modal shell (backdrop, chrome, close) | [`src/components/common/Modal.tsx`](../../src/components/common/Modal.tsx) |
| Left rail, editor header | [`src/components/Zones/ZoneLibrary.tsx`](../../src/components/Zones/ZoneLibrary.tsx) |
| Form body and footer | [`src/components/Zones/ZoneForm.tsx`](../../src/components/Zones/ZoneForm.tsx) |
| Tool catalogue, categories, safety levels | [`src/lib/types.ts`](../../src/lib/types.ts) — `ALL_TOOLS`, `TOOL_CATEGORIES` |
| Icon groups, colour presets | [`src/lib/zoneIcons.tsx`](../../src/lib/zoneIcons.tsx) |
| Prompt templates | `ZoneForm.tsx` — `PROMPT_TEMPLATES` + [`src/lib/defaultZones.ts`](../../src/lib/defaultZones.ts) |
| Tool function names and built-in descriptions | [`src-tauri/src/tools/`](../../src-tauri/src/tools/) |

Tokens are copied verbatim from [`src/styles.css`](../../src/styles.css), both
palettes, including the custom checkbox / indeterminate / range-slider styling.
Tailwind utility classes are resolved to their pixel values in plain CSS so every
measurement is legible without a Tailwind build. Icons are real Lucide paths,
extracted from the app's own `lucide-react@0.460.0` rather than redrawn.

## The full form, in order

1. **Name** + live avatar preview
2. **Icon picker** — search field, 176px scrolling box, 10-column grid, grouped
3. **Zone color** — 12 presets, custom colour chip, "Use global accent"
4. **Provider / Model** (2-col)
5. **Image input** — vision override
6. **System prompt** + Templates dropdown *(14 entries)*
7. **Sampling** — Temperature slider / Max tokens / Top-p (3-col)
8. **Tools** — the bulk of the screen:
   - "All tools" master toggle (tri-state) + *reset usage stats*
   - Five categories (Files, Web, Knowledge, Agents, System), each with its own
     tri-state group toggle
   - Per tool: checkbox, label, **safety badge** (Safe / Moderate / Dangerous),
     an *N custom* badge, a **usage counter** (`42× used · 2 failed`, or the
     pointed `never used`), and the description
   - **"What the model is told (N)"** — expandable per-zone description overrides,
     one textarea per tool function, with the built-in description as placeholder
   - **MCP groups** — one per connected server, tools carrying their
     user-assigned danger badge
9. **Code Execution settings** — appears only when *Run code* is enabled
10. **Reasoning** — *Enable thinking* and *Keep thinking in conversation history*
11. **Multizone** — *Response Leader*
12. **Voice (read aloud)**
13. **Tool config (JSON)**
14. Footer — Delete / Save

## Interaction

Enough to explore the screen, not a working editor. Checkboxes toggle, group and
master toggles go tri-state correctly, "What the model is told" expands, the
Templates dropdown opens and closes on outside click, the icon and colour pickers
change the avatar / Save button / hex chip, and the temperature slider updates its
label. Nothing persists and nothing validates.

Two controls in the top right are **not** part of the app: a light/dark switch,
and *Expand all tools* (which is how you see the whole description-override
surface at once).

## Fixed dimensions worth knowing before redesigning

Hard-coded today; a redesign either keeps them or changes them deliberately:

- Modal **980 × 700**, capped at `96vw × 94vh`. No responsive behaviour below
  that — the modal just clips.
- Header **56px**, left rail **224px** (fixed, not resizable).
- Icon grid box **max-height 176px**, **10 columns**, scrolling *inside* a form
  that also scrolls.
- Form padding **16px**, footer **12px / 16px**.

## Things this surfaced that are worth fixing

Reproduced faithfully rather than quietly corrected:

- **The Templates dropdown is clipped.** It is absolutely positioned inside the
  form's `overflow-y: auto` container, so it is cut off at the container edge and
  scrolls away with the content instead of floating above it.
- **Nested scroll containers.** The icon grid scrolls inside the form, which
  scrolls inside a fixed-height modal. Three scroll regions on one screen.
- **Selection and focus look the same.** The magenta ring on the selected zone in
  the left rail is a *focus* ring; selection itself is only the
  `--color-panel-hover` background. They are easy to confuse.
- **Length with no navigation.** Thirteen sections, no anchors, no sections, no
  tabs — and the tool list alone runs to over twenty cards once expanded.

## Deliberate deviations

- **Icon grid is truncated** to the first two groups (AI & Technology, Analysis &
  Data). The picker continues with Creative & Writing, Business, People, Nature
  and more.
- **Zone avatar icons are approximate.** `Globe` (Deepseek) and `PieChart`
  (Ornith) are legible in the reference screenshot; the other seven use `Bot`,
  which is what `getZoneIcon()` falls back to for a zone with no icon set. The
  colours are read off the screenshot and are exact.
- **Prompt template bodies are omitted** — only label, description, and the
  "Enables:" tool list are shown, which is all the dropdown itself displays.
- **Usage counts, MCP servers, and the enabled-tool set are sample data**, chosen
  to exercise every badge and state at once. They live in `ENABLED`, `USAGE`,
  `CUSTOMIZED` and `MCP_SERVERS` near the bottom of the file.
- **Accent is magenta** (`#ec4899`) to match the screenshot's theme; the shipped
  default is `#4f9cf9`. It is one variable, `--color-accent`. The zone's own
  colour is another, `--zone-color` (`#06b6d4` here). Changing either re-themes
  everything downstream.

## Editing it

All data lives in one `<script>` block at the bottom, above the render code, and
each array names the file it mirrors. Add a tool to `ALL_TOOLS`, a category to
`TOOL_CATEGORIES`, an icon group, a template — the screen re-renders from it.
Layout is plain CSS in the `<style>` block, sectioned in the same order as the
form.
