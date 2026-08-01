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
    name: "about-this-app",
    description:
      "Use when the question is about the app this conversation is happening inside — what it " +
      "is, what it can do, how zones, projects, sub-agents, tools, skills, memory or knowledge " +
      "work, how to configure or troubleshoot any of it, or how to get better answers out of " +
      "it. Covers \"tell me about this harness\", \"how should I set up a project\", \"why " +
      "can't you read that file\", \"which zone should answer this\". Load it before " +
      "explaining the environment rather than guessing at it.",
    content: `# The app you are running in

MultiZone is a desktop chat app for LLMs. It talks to any OpenAI-compatible endpoint — a frontier API, a self-hosted server, a model on the user's own GPU — and stores every chat in a local SQLite database. Nothing is sent anywhere except to the providers the user configured.

Answer questions about it from this page. If something here doesn't match what you can actually see, say so rather than inventing behaviour; the app changes and this page can lag.

## Zones

A **zone** is the unit of configuration: one provider + model + system prompt + temperature + toolset + thinking setting, saved under a name with an icon and colour. A chat is bound to a zone, and that zone answers.

- **Perspective zones** — add more zones to one chat and every message fans out to all of them. One thread, independent replies, side by side or stacked. Good for comparing models, bad for a long task (each zone pays the full context).
- **Smart chat** — a router picks the best zone per turn instead of you choosing.
- **Quick chat** — a chat with no zone. The app-wide default zone answers (Settings → Chat), or the first provider's default model with no system prompt and only the safe tools.
- The **Zone Library** ships curated presets. Installing one binds it to the user's own provider and model.

## Multizone mode: leaders and sub-agents

A zone flagged **Response Leader** doesn't answer from its own knowledge. It spawns other zones as sub-agents, each in its own subchat, cross-examines them, and writes one synthesized answer.

- Sub-agents get real tools and inherit the parent chat's project directory.
- \`background: true\` on a spawn returns immediately, so a leader can put several specialists to work at once and collect the replies later.
- **Only the leader can talk to the user.** A sub-agent's request for input is suppressed — which is why an unattended multi-agent run needs *Tool auto-approval: Everything*, or it will silently stall on an approval prompt nobody can see.
- The **teamwork** tool lets several agents edit one working tree at once: each claims the files it is about to change, and a write to a file another agent holds is refused rather than clobbering it. There is a shared note board for decisions, because agents can't read each other's transcripts.
- **Teams** in the library install a leader plus its specialists in one action.
- The whole call tree is inspectable inline in the chat, and chat exports fold the sub-agent conversations in.

## Projects

A project groups chats and, more importantly, gives them a **directory**. That directory is what the file tools are scoped to — a chat with no project falls back to the default directory in Settings.

Configuring one well:
- **Set the directory** first. Most "the assistant can't find my file" problems are this.
- Keep the **context snippet** short and factual — it is prepended to every chat in the project, so it is paid for on every turn. Conventions and constraints, not documentation.
- **Knowledge (RAG)** is opt-in per chat. Index the directory when you want meaning-based search over a lot of prose; for code, the exact \`file_search\` tools are usually better and cost nothing to keep current.

## Memory, skills, tags

- **Memory** — facts the model saves itself, scoped to this chat, this project, or everywhere. Project-scope memory reaches every agent working on that project, including ones spawned later, which makes it the durable counterpart to the team board.
- **Skills** — named instruction sets. Every enabled skill's *description* is offered on each turn; the model loads the body on demand. Folder-backed skill packs installed on disk are picked up too (Settings → Skills). A skill an agent writes itself arrives disabled, for review.
- **Tags** — labels for finding chats, optionally carrying a context snippet of their own.

## Tools

Grouped as Files, Web, Knowledge, Agents, System, and enabled per zone. Notes that matter:

- **Every enabled tool costs context on every single turn**, used or not. A focused toolset makes a zone both cheaper and more accurate. Per-zone usage counters in the zone editor show which ones actually earn their place.
- Web research is keyless out of the box — \`smart_search\` queries several engines at once and merges them.
- \`run_command\` runs a command and waits for it to finish. For something that keeps running — a dev server, a REPL, a program that prompts part-way through — the **terminal** tools start it and stay attached, so you can read its output and type into it across several turns.
- Tools are classified safe / moderate / dangerous, and **Settings → Chat → Tool auto-approval** decides which prompt first.
- **Task length** caps how many steps one turn may take before the model must answer. Raise it for long agentic work; the default suits ordinary chat.

## Getting better results

- Match the zone to the job: a cheap fast model for chat, a strong one with file tools for code, a leader with a panel for anything genuinely hard.
- Put durable instructions in the zone's system prompt, task-specific ones in the message.
- For a long unattended run: auto-approval to *Everything*, task length up, and a project directory set.
- If answers drift late in a long chat, the \`compact\` tool condenses the older turns; the user still sees the whole conversation.

## Where to change things

Settings holds Providers, Chat (approvals, task length, default zone), Appearance (including chat export), Web search, Knowledge, Skills, MCP servers, Voice, and the local HTTP API. The API exposes chats and messages on \`127.0.0.1\` behind a bearer token, so scripts can drive the app the same way the window does.`,
  },
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

/**
 * Highest version of the built-in set that has been seeded. Bumped whenever a
 * skill is *added* here, so an install that seeded an earlier set picks the new
 * one up — one-time seeding alone would mean only brand-new installs ever see
 * anything added later.
 *
 * 1 — `about-this-app` (0.9.11).
 */
export const SKILL_SEED_VERSION = 1;

/**
 * Create the built-in skills the catalog doesn't already have, matched by name.
 * Returns how many were created.
 *
 * Matching by name is what makes a re-seed safe: a default the user has edited,
 * renamed or deleted-and-replaced is left alone, and only genuinely absent ones
 * are written. Caller decides *when* to run this; see App.tsx.
 */
export async function seedDefaultSkills(existingNames: Iterable<string>): Promise<number> {
  const have = new Set(existingNames);
  let created = 0;
  for (const s of DEFAULT_SKILLS) {
    if (have.has(s.name)) continue;
    await api.upsertSkill({ name: s.name, description: s.description, content: s.content, enabled: true });
    created += 1;
  }
  return created;
}
