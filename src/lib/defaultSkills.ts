/**
 * Built-in skill templates seeded on first run so the Skills catalog isn't empty.
 * Modeled on Anthropic Agent Skills (https://github.com/anthropics/skills): each
 * skill is a name + a description written as the *use case that should trigger
 * it* + freeform-markdown instructions the agent loads on demand via `load_skill`.
 * Seeding is one-time (gated by the `seededSkills` app setting) and only runs when
 * no skills exist yet. All are editable / deletable afterward.
 */
import * as api from "@/lib/tauri";

export interface DefaultSkillDef {
  name: string;
  /** Written as the use case an agent matches against to decide to load it. */
  description: string;
  content: string;
}

export const DEFAULT_SKILLS: DefaultSkillDef[] = [
  {
    name: "frontend-design",
    description:
      "Use when the user asks to build, design, restyle, or review a web UI — components, " +
      "pages, layouts, design systems, or any HTML/CSS/React front-end work where visual " +
      "quality, layout, or aesthetics matter. Load this before writing UI code.",
    content: `# Frontend design

Apply these principles whenever you produce or review front-end UI. The goal is interfaces that look intentional and considered, not default-template generic.

## Hierarchy & layout
- Establish a clear visual hierarchy with **size, weight, and spacing** before reaching for color. The most important thing on the screen should be unmistakable.
- Use a consistent spacing scale — 4 / 8 / 12 / 16 / 24 / 32 / 48px. Never use arbitrary one-off values.
- Give content room to breathe: generous whitespace reads as quality. Constrain line length to ~60–75 characters for body text.
- Align everything to a grid. Inconsistent alignment is the most common tell of an amateur layout.

## Typography
- Pick one type family for UI; at most two. Establish a type scale (e.g. 12 / 14 / 16 / 20 / 24 / 32) and stick to it.
- Use weight and size for hierarchy, not many colors. Body text 14–16px; don't go below 12px.
- Set comfortable line-height (1.4–1.6 for body). Tighten it for large headings.

## Color
- Start from a neutral gray scale for surfaces, borders, and text; reserve a single accent for primary actions and focus.
- Ensure text meets **WCAG AA** contrast (4.5:1 body, 3:1 large text). Check it, don't guess.
- Convey state (success / warning / danger) with color *plus* an icon or label — never color alone.

## Components & states
- Design every interactive element's full state set: default, hover, focus-visible, active, disabled, loading, and empty — not just the happy path.
- Always provide a visible **focus ring** for keyboard users and an accessible label for every control.
- Keep components small and composable; lift state only as far as it needs to go. Name props by intent, not implementation.

## Motion & polish
- Use motion to clarify, not decorate: 150–250ms ease-out transitions on hover/state changes; respect \`prefers-reduced-motion\`.
- Round corners, borders, and shadows consistently across the whole UI.

## Responsiveness & accessibility
- Design mobile-first; let layouts reflow rather than shrink. Test at narrow widths.
- Use semantic HTML (\`button\`, \`nav\`, \`main\`, headings in order). Every image has alt text; every input has a label.

When reviewing existing UI, call out specific violations of the above with the fix, rather than vague praise.`,
  },
  {
    name: "markdown-formatting",
    description:
      "Use when the user wants a written explanation, summary, report, or any longer prose " +
      "answer and readable structure matters. Load this to apply consistent markdown formatting.",
    content: `# Markdown formatting

Format longer answers for readability:

- Use \`##\` / \`###\` headings to structure anything beyond a few paragraphs.
- Prefer bullet and numbered lists over long comma-separated sentences.
- Put code, file paths, commands, and identifiers in backticks; use fenced code blocks with a language tag for multi-line code.
- Use **bold** for key terms and tables for comparisons of three or more items.
- Keep paragraphs short (2–4 sentences) with a blank line between blocks.
- Don't over-format — short, simple answers can stay plain prose.`,
  },
  {
    name: "json-output",
    description:
      "Use when the user asks for structured data, an API-shaped response, or output that " +
      "another program will parse. Load this to return strict, parseable JSON.",
    content: `# JSON output format

When asked for structured / JSON output:

- Return **only** valid JSON — no prose, no markdown fences, no trailing commentary.
- Double-quoted keys and string values. No comments, no trailing commas.
- Prefer \`null\` over omitting a key when a value is unknown; keep the shape stable across responses.
- Use \`snake_case\` keys unless told otherwise.
- Numbers are bare; booleans are \`true\`/\`false\`.
- Never invent data to fill a field — use \`null\`.`,
  },
];

/** Create the built-in skill templates. Caller gates this on first-run state. */
export async function seedDefaultSkills(): Promise<void> {
  for (const s of DEFAULT_SKILLS) {
    await api.upsertSkill({ name: s.name, description: s.description, content: s.content, enabled: true });
  }
}
