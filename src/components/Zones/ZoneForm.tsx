import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Trash2, X, BookOpen, ChevronDown, Crown } from "lucide-react";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { VisionOverrideSelect } from "@/components/common/VisionOverrideSelect";
import type { Provider, ToolFunctionInfo, ToolUsage, Zone } from "@/lib/types";
import { ALL_TOOLS, TOOL_CATEGORIES, mcpToolEnableId } from "@/lib/types";
import { useApp } from "@/store/app";
import { DEFAULT_ZONES } from "@/lib/defaultZones";

const SAFETY_BADGE: Record<number, { label: string; cls: string }> = {
  0: { label: "Safe",      cls: "border-green-600/40  bg-green-600/10  text-green-500" },
  1: { label: "Moderate",  cls: "border-yellow-600/40 bg-yellow-600/10 text-yellow-500" },
  2: { label: "Dangerous", cls: "border-red-600/40    bg-red-600/10    text-red-500" },
};

/**
 * Header row that switches a whole group of tools on or off (0.9.0). Tri-state:
 * `mixed` renders an indeterminate box, so a partially-enabled group reads as
 * partial rather than off. Clicking a mixed or empty group enables all of it;
 * clicking a full group clears it.
 */
function GroupToggle({
  label,
  enabled,
  mixed,
  onToggle,
  emphasis,
}: {
  label: string;
  enabled: boolean;
  mixed: boolean;
  onToggle: () => void;
  emphasis?: boolean;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label
      className={`flex cursor-pointer select-none items-center gap-2 rounded px-0.5 py-1 text-[10px] font-medium uppercase tracking-wide hover:text-[var(--color-text)] ${
        emphasis ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"
      }`}
    >
      <input
        ref={box}
        type="checkbox"
        checked={enabled}
        onChange={onToggle}
        className="shrink-0"
      />
      {label}
    </label>
  );
}
import {
  ZONE_ICON_GROUPS,
  ZONE_ICONS,
  ZONE_COLOR_PRESETS,
  getZoneIcon,
} from "@/lib/zoneIcons";

// ---------------------------------------------------------------------------
// Built-in prompt templates
// ---------------------------------------------------------------------------
interface PromptTemplate {
  id: string;
  label: string;
  description: string;
  prompt: string;
  /** Tool IDs that should be enabled for this template to work well. */
  suggestedTools?: string[];
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Start with an empty system prompt.",
    prompt: "",
  },
  // Starter zones (also seeded on first run) — offered here so they're
  // discoverable when building a zone from scratch.
  ...DEFAULT_ZONES.map((z) => ({
    id: `default_${z.name.toLowerCase().replace(/\s+/g, "_")}`,
    label: z.name,
    description: z.description,
    prompt: z.systemPrompt,
    suggestedTools: z.tools,
  })),
  {
    id: "study_guide",
    label: "Study Guide (Socratic)",
    description: "Guides students to answers through questions and visuals — never gives the answer directly.",
    suggestedTools: ["ask_user", "render_graph", "code_exec", "smart_search"],
    prompt: `You are an encouraging study guide for engineering and mathematics. Your single most important rule: never give the student a final answer directly. Always guide them to find it themselves — and reach for your tools constantly to make that guidance visual, interactive, and verifiable.

## Core Rules

1. **Never give the answer.** Respond with a question, a hint, or point them back to the reference sheet.
2. **One hint at a time.** Don't overwhelm — ask one targeted question that unlocks the next step.
3. **Praise correct reasoning** explicitly before addressing what's wrong.
4. **Flag errors without fixing them.** Point to where something looks off and ask the student to check it.
5. **If they ask you to just tell them:** acknowledge the frustration, offer a slightly more direct hint, but hold the line.

## The One Exception

If the student shows correct working with all values fully substituted and only the final calculation remains, you may confirm their setup is correct and verify the result. You may also use \`code_exec\` to check arithmetic once they've done the algebra.

## Tools — Use Them Aggressively

Default to using tools rather than describing things in prose. A visual hint almost always beats a text hint.

- **plot_function**: Any time a function, equation, or relationship appears — plot it first and ask where they expect key features (zeros, maxima, asymptotes).
- **draw_diagram**: For concepts, processes, decision points, free-body diagrams, flowcharts of strategy (not answers).
- **ask_user**: Your primary Socratic instrument. Offer 2–4 plausible options so the student actively chooses the next step. Surface common misconceptions as options to be rejected.
- **code_exec**: Verify arithmetic *after* the student has set up the problem — never solve from scratch.
- **smart_search**: Canonical constants, material properties, or a similar-but-different worked example to point at.

## Workflow

1. Draw the picture first (diagram or plot).
2. Ask what's given, what's unknown, what principle applies — use \`ask_user\` with options.
3. Hint at the strategy, not the equation. Use a flowchart if there are branches.
4. Let them set up. Flag sign errors and unit errors by location, not correction.
5. When values are substituted and only arithmetic remains, optionally verify with \`code_exec\`.

## Tone

Warm, precise, and patient. Reframe confusion as a normal part of learning, never a failure.`,
  },
  {
    id: "code_reviewer",
    label: "Code Reviewer",
    description: "Systematic, opinionated code reviewer focused on correctness, clarity, and maintainability.",
    suggestedTools: ["code_exec", "file_system"],
    prompt: `You are a senior software engineer conducting a thorough code review. Your goal is to help the author ship better, more maintainable code.

## Review Priorities (in order)

1. **Correctness** — bugs, edge cases, off-by-one errors, race conditions, security vulnerabilities (injection, XSS, auth bypass).
2. **Clarity** — can a new engineer understand this in 30 seconds? Rename, restructure, or split as needed.
3. **Simplicity** — eliminate unnecessary abstraction, duplication, and indirection. Three similar lines beats a premature abstraction.
4. **Performance** — flag O(n²) where O(n) is obvious, unnecessary allocations, blocking calls on hot paths. Don't micro-optimise without evidence.
5. **Conventions** — consistency with the rest of the codebase matters more than personal style preferences.

## How to Give Feedback

- Lead with what's **working well** before issues.
- For each issue: explain **why** it matters, not just what to change.
- Distinguish severity: 🔴 must-fix, 🟡 should-fix, 🔵 suggestion/nit.
- When you suggest an alternative, show a short code snippet.
- If you're unsure about intent, **ask before assuming it's wrong**.

## What Not to Do

- Don't rewrite the entire thing — targeted feedback only.
- Don't enforce style preferences that aren't in an existing linter config.
- Don't flag things that are fine as they are just to look thorough.`,
  },
  {
    id: "writing_coach",
    label: "Writing Coach",
    description: "Helps improve writing through targeted feedback — never rewrites your work for you.",
    suggestedTools: ["ask_user"],
    prompt: `You are a writing coach who helps people become better writers. You give targeted, specific feedback — you never rewrite passages for the author. Your job is to teach, not to ghost-write.

## Principles

1. **Diagnose, don't prescribe.** Name the issue and explain why it matters; let the author fix it.
2. **Be specific.** Quote the exact sentence or phrase that needs attention.
3. **One thing at a time.** Pick the most important issue in each round of feedback.
4. **Ask about intent.** Before flagging something as wrong, confirm what the author was trying to achieve.
5. **Celebrate what works.** Note strong word choices, clear arguments, and effective structure explicitly.

## Common Issues to Watch For

- **Clarity**: Is every sentence doing one job? Is the subject clear?
- **Structure**: Does the argument flow logically? Are transitions signposted?
- **Concision**: Which words can be cut without losing meaning?
- **Voice**: Is the tone consistent? Does it suit the audience?
- **Evidence**: Are claims supported? Are examples concrete?

## What You Don't Do

- You don't rewrite sentences for the author (you may show a very short example of a technique, but not a wholesale rewrite).
- You don't copy-edit for minor grammar unless it obscures meaning.
- You don't impose your stylistic preferences — serve the author's voice.`,
  },
  {
    id: "research_assistant",
    label: "Research Assistant",
    description: "Explains topics deeply with sources, draws concept maps, and surfaces nuance.",
    suggestedTools: ["smart_search", "render_graph", "ask_user"],
    prompt: `You are a rigorous research assistant. You help users understand topics deeply — not just surface-level summaries. You cite sources, surface nuance, and use diagrams to build mental models.

## How You Work

1. **Clarify scope first.** Use \`ask_user\` to confirm what depth, audience, and angle the user wants before diving in.
2. **Search before summarising.** Use \`smart_search\` to find current, authoritative sources rather than relying on training data for facts that change.
3. **Visualise structure.** Use \`draw_diagram\` to show concept hierarchies, timelines, cause-and-effect chains, or comparisons — wherever a picture clarifies more than prose.
4. **Distinguish certainty levels.** Clearly separate established consensus, active debate, and your own synthesis.
5. **Cite specifically.** Quote or paraphrase with source attribution. Don't cite sources you haven't verified exist.

## What You Don't Do

- Don't fabricate citations. If you can't find a source, say so.
- Don't flatten nuance into false certainty.
- Don't give a 10-point listicle when the topic deserves a structured explanation.

## Tone

Academic but accessible. Precise vocabulary, short sentences. Assume an intelligent adult reader who doesn't already know the field.`,
  },
  {
    id: "debate_partner",
    label: "Debate Partner",
    description: "Steelmans all sides of an argument and challenges the user's reasoning rigorously.",
    suggestedTools: ["ask_user", "smart_search"],
    prompt: `You are an intellectual debate partner. Your job is to stress-test arguments, steelman opposing views, and help the user think more clearly — not to validate them.

## Rules of Engagement

1. **Steelman first.** Always present the strongest version of every position, including ones you're about to critique.
2. **Attack the argument, not the person.** Keep disagreement analytical and respectful.
3. **Ask for evidence.** When the user asserts a fact, ask for the basis. When you assert one, provide it.
4. **Name the fallacy.** If you spot a logical error (straw man, appeal to authority, false dichotomy), name it and explain why.
5. **Change your mind publicly.** If the user makes a good point, acknowledge it explicitly. Model intellectual honesty.

## What You Don't Do

- Don't agree just to be agreeable — honest pushback is the whole point.
- Don't manufacture false balance on empirical questions with clear scientific consensus.
- Don't lecture — keep it conversational and back-and-forth.

## Format

Keep responses tight. Make one sharp point per turn, then invite the user to respond. Use \`ask_user\` when you want them to commit to a position before you respond to it.`,
  },
  {
    id: "pair_programmer",
    label: "Pair Programmer",
    description: "Thinks through problems with you step by step — asks before it writes.",
    suggestedTools: ["code_exec", "file_system", "ask_user"],
    prompt: `You are an experienced pair programmer working alongside the user. You think out loud, ask before assuming, and write code together rather than handing over a finished solution.

## How You Work

1. **Understand before coding.** Restate the problem in your own words and confirm before writing a line.
2. **Plan before implementing.** Sketch the approach (in prose or pseudocode) and get agreement.
3. **Write incrementally.** Deliver small, testable chunks. Explain what each piece does and why.
4. **Ask about trade-offs.** When there are multiple valid approaches, present them and ask which fits the user's constraints.
5. **Verify as you go.** Use \`code_exec\` to run snippets and confirm they behave as expected.

## What You Don't Do

- Don't write 200 lines without a checkpoint.
- Don't make architectural decisions unilaterally — flag them and discuss.
- Don't silently assume language, framework, or style — ask if it's not obvious from context.

## Debugging Mode

When debugging: reproduce first, hypothesise second, fix third. Always explain *why* something was wrong, not just what to change.`,
  },
];


interface Props {
  zone: Zone | null;
  providers: Provider[];
  onSaved: (saved: Zone) => void;
  onDeleted: () => void;
}

export function ZoneForm({ zone, providers, onSaved, onDeleted }: Props) {
  const [name, setName] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState("");
  const [topP, setTopP] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [toolConfig, setToolConfig] = useState("{}");
  /** Per-zone tool description overrides (0.9.3), keyed by function name. */
  const [descOverrides, setDescOverrides] = useState<Record<string, string>>({});
  /** The shipped descriptions, read from Rust so there's one source of truth. */
  const [toolFns, setToolFns] = useState<ToolFunctionInfo[]>([]);
  /** Which tool group has its description editor open. */
  const [editingDesc, setEditingDesc] = useState<string | null>(null);

  /** Per-tool call counters for this zone (0.9.3); empty for an unsaved zone. */
  const [usage, setUsage] = useState<ToolUsage[]>([]);

  useEffect(() => {
    api.listToolFunctions().then(setToolFns).catch(console.error);
  }, []);

  useEffect(() => {
    if (!zone?.id) {
      setUsage([]);
      return;
    }
    api.getToolUsage(zone.id).then(setUsage).catch(console.error);
  }, [zone?.id]);
  const mcpServers = useApp((s) => s.mcpServers);
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);
  const [ceHeadless, setCeHeadless] = useState(false);
  const [ttsVoice, setTtsVoice] = useState("");
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [includeThinkingInContext, setIncludeThinkingInContext] = useState(false);
  const [isLeader, setIsLeader] = useState(false);
  const [icon, setIcon] = useState<string | null>(null);
  const [accentColor, setAccentColor] = useState<string | null>(null);
  const [iconSearch, setIconSearch] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const templatePickerRef = useRef<HTMLDivElement>(null);

  // Reset form when switching zones (keyed on zone id, not object reference).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (zone) {
      setName(zone.name);
      setProviderId(zone.providerId);
      setModel(zone.model);
      setSystemPrompt(zone.systemPrompt ?? "");
      setTemperature(zone.temperature);
      setMaxTokens(zone.maxTokens?.toString() ?? "");
      setTopP(zone.topP?.toString() ?? "");
      try {
        setTools(JSON.parse(zone.toolsEnabled));
      } catch {
        setTools([]);
      }
      const tc = zone.toolConfig || "{}";
      setToolConfig(tc);
      try {
        const parsed = JSON.parse(tc);
        const ce = parsed?.code_exec ?? {};
        setCeHeadless(ce.headless ?? false);
        setTtsVoice(typeof parsed?.tts_voice === "string" ? parsed.tts_voice : "");
        setDescOverrides(
          parsed?.tool_descriptions && typeof parsed.tool_descriptions === "object"
            ? (parsed.tool_descriptions as Record<string, string>)
            : {},
        );
      } catch { /* ignore */ }
      setThinkingEnabled(zone.thinkingEnabled ?? false);
      setIncludeThinkingInContext(zone.includeThinkingInContext ?? false);
      setIsLeader(zone.isLeader ?? false);
      setIcon(zone.icon ?? null);
      setAccentColor(zone.accentColor ?? null);
    } else {
      setName("");
      setProviderId(providers[0]?.id ?? null);
      setModel("");
      setSystemPrompt("");
      setTemperature(0.7);
      setMaxTokens("");
      setTopP("");
      setTools([]);
      setToolConfig("{}");
      setCeHeadless(false);
      setTtsVoice("");
      setDescOverrides({});
      setThinkingEnabled(false);
      setIncludeThinkingInContext(false);
      setIsLeader(false);
      setIcon(null);
      setAccentColor(null);
    }
    setIconSearch("");
  }, [zone?.id, providers]);

  useEffect(() => {
    if (!providerId) return;
    setLoadingModels(true);
    api
      .fetchModels(providerId)
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setLoadingModels(false));
  }, [providerId]);

  useEffect(() => {
    refreshMcpServers().catch(console.error);
  }, [refreshMcpServers]);

  const filteredIcons = useMemo(() => {
    if (!iconSearch.trim()) return null; // null = show groups
    const q = iconSearch.toLowerCase();
    return ZONE_ICONS.filter((i) => i.label.toLowerCase().includes(q));
  }, [iconSearch]);

  const activeColor = accentColor ?? "var(--color-accent)";

  function buildToolConfig(base: string, headless: boolean): string {
    let obj: Record<string, unknown> = {};
    try { obj = JSON.parse(base); } catch { /* keep empty */ }
    delete obj.web_search;
    const ce = typeof obj.code_exec === "object" && obj.code_exec !== null ? { ...obj.code_exec as object } : {};
    obj.code_exec = { ...ce, headless };
    return JSON.stringify(obj, null, 2);
  }

  function onCeHeadlessChange(v: boolean) {
    setCeHeadless(v);
    setToolConfig((tc) => buildToolConfig(tc, v));
  }

  async function onSave() {
    if (!name.trim() || !model.trim()) return;
    setSaving(true);
    // Fold the per-zone TTS voice (0.8.1) into the tool_config JSON so it rides
    // along with the rest of the zone config rather than needing its own column.
    let finalToolConfig = toolConfig;
    try {
      const obj = JSON.parse(toolConfig || "{}") as Record<string, unknown>;
      if (ttsVoice.trim()) obj.tts_voice = ttsVoice.trim();
      else delete obj.tts_voice;
      // Per-zone tool description overrides (0.9.3). Only non-empty entries are
      // persisted — clearing a box restores the shipped description rather than
      // sending the model an empty one.
      const overrides = Object.fromEntries(
        Object.entries(descOverrides).filter(([, v]) => v.trim()),
      );
      if (Object.keys(overrides).length > 0) obj.tool_descriptions = overrides;
      else delete obj.tool_descriptions;
      finalToolConfig = JSON.stringify(obj, null, 2);
    } catch { /* keep raw toolConfig if it isn't valid JSON */ }
    try {
      const saved = await api.upsertZone({
        id: zone?.id,
        name: name.trim(),
        providerId,
        model: model.trim(),
        systemPrompt: systemPrompt.trim() || null,
        temperature,
        maxTokens: maxTokens ? parseInt(maxTokens, 10) : null,
        topP: topP ? parseFloat(topP) : null,
        toolsEnabled: JSON.stringify(tools),
        toolConfig: finalToolConfig,
        thinkingEnabled,
        includeThinkingInContext,
        isLeader,
        icon,
        accentColor,
      });
      onSaved(saved);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!zone) return;
    await api.deleteZone(zone.id);
    onDeleted();
  }

  function toggleTool(id: string) {
    setTools((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }

  /** Switch a whole group (a category, or one MCP server's tools) on or off. */
  function setGroupEnabled(ids: string[], enabled: boolean) {
    setTools((t) => {
      const rest = t.filter((x) => !ids.includes(x));
      return enabled ? [...rest, ...ids] : rest;
    });
  }

  // Every id the master toggle covers: the built-ins plus the tools of every
  // connected MCP server, so "all" really means all of what this zone can see.
  const allToolIds = useMemo(
    () => [
      ...ALL_TOOLS.filter((t) => !t.hidden).map((t) => t.id),
      ...mcpServers
        .filter((s) => s.enabled)
        .flatMap((s) => s.tools.map((t) => mcpToolEnableId(s.id, t.name))),
    ],
    [mcpServers],
  );
  const enabledCount = allToolIds.filter((id) => tools.includes(id)).length;
  const everyToolEnabled = allToolIds.length > 0 && enabledCount === allToolIds.length;
  const someToolEnabled = enabledCount > 0;

  function applyTemplate(tpl: PromptTemplate) {
    setSystemPrompt(tpl.prompt);
    if (tpl.suggestedTools) {
      setTools((prev) => {
        const next = new Set(prev);
        for (const id of tpl.suggestedTools!) next.add(id);
        return [...next];
      });
    }
    setTemplatePickerOpen(false);
  }

  const SelectedIcon = getZoneIcon(icon);

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4">
        {/* Name + icon preview row */}
        <div className="mb-3 flex items-start gap-3">
          <div className="flex-1">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
            </Field>
          </div>
          {/* Live preview avatar — spacer div matches the Field label height so the
              avatar visually aligns with the input rather than the label text. */}
          <div className="flex shrink-0 flex-col">
            <div className="mb-1 h-[16px]" />
            <div
              className="flex h-[34px] w-9 items-center justify-center rounded-lg shadow-sm"
              style={{ background: activeColor }}
            >
              <SelectedIcon size={18} color="white" />
            </div>
          </div>
        </div>

        {/* Icon picker */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>Icon</span>
            {icon && (
              <button
                onClick={() => setIcon(null)}
                className="flex items-center gap-1 hover:text-[var(--color-text)]"
              >
                <X size={10} /> Clear
              </button>
            )}
          </div>
          <input
            value={iconSearch}
            onChange={(e) => setIconSearch(e.target.value)}
            placeholder="Search icons…"
            className="input mb-2 text-xs"
          />
          <div className="max-h-44 overflow-y-auto rounded border border-[var(--color-border)] p-2">
            {filteredIcons !== null ? (
              filteredIcons.length === 0 ? (
                <div className="py-2 text-center text-xs text-[var(--color-text-muted)]">
                  No icons found
                </div>
              ) : (
                <div className="grid grid-cols-10 gap-1">
                  {filteredIcons.map(({ id: iconId, icon: IconComp, label }) => (
                    <IconButton
                      key={iconId}
                      iconId={iconId}
                      IconComp={IconComp}
                      label={label}
                      selected={icon === iconId}
                      activeColor={activeColor}
                      onClick={() => setIcon(iconId === icon ? null : iconId)}
                    />
                  ))}
                </div>
              )
            ) : (
              <div className="flex flex-col gap-3">
                {ZONE_ICON_GROUPS.map((group) => (
                  <div key={group.label}>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                      {group.label}
                    </div>
                    <div className="grid grid-cols-10 gap-1">
                      {group.icons.map(({ id: iconId, icon: IconComp, label }) => (
                        <IconButton
                          key={iconId}
                          iconId={iconId}
                          IconComp={IconComp}
                          label={label}
                          selected={icon === iconId}
                          activeColor={activeColor}
                          onClick={() => setIcon(iconId === icon ? null : iconId)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Color picker */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>Zone color</span>
            {accentColor && (
              <button
                onClick={() => setAccentColor(null)}
                className="flex items-center gap-1 hover:text-[var(--color-text)]"
              >
                <X size={10} /> Use global accent
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {ZONE_COLOR_PRESETS.map((color) => (
              <button
                key={color}
                onClick={() => setAccentColor(accentColor === color ? null : color)}
                className="h-6 w-6 rounded-full transition hover:scale-110"
                style={{
                  background: color,
                  outline:
                    accentColor === color ? `2px solid ${color}` : "2px solid transparent",
                  outlineOffset: "2px",
                }}
                title={color}
              />
            ))}
            <div
              className="relative flex h-6 w-8 cursor-pointer items-center justify-center overflow-hidden rounded border border-[var(--color-border)] hover:border-[var(--color-accent)]"
              title="Custom color"
            >
              <input
                type="color"
                value={accentColor ?? "#4f9cf9"}
                onChange={(e) => setAccentColor(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
              <span className="pointer-events-none z-10 text-[9px] font-mono text-[var(--color-text-muted)]">
                {accentColor ? accentColor.slice(1, 4).toUpperCase() : "···"}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Provider">
            <select
              value={providerId ?? ""}
              onChange={(e) => setProviderId(e.target.value || null)}
              className="input"
            >
              <option value="">— select —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={
              <span className="flex items-center justify-between">
                Model
                {loadingModels && <RefreshCw size={10} className="animate-spin" />}
              </span>
            }
          >
            <ModelCombobox
              value={model}
              onChange={setModel}
              options={models}
              className="input"
              placeholder={loadingModels ? "loading…" : "e.g. gpt-4o-mini"}
            />
          </Field>
        </div>

        <Field label="Image input">
          <VisionOverrideSelect model={model} />
        </Field>

        {/* System prompt — kept as a plain div (not label) so the template-picker
            backdrop overlay doesn't trigger label focus side-effects. */}
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <label htmlFor="zone-system-prompt">System prompt (optional)</label>
            {/* Template picker */}
            <div className="relative" ref={templatePickerRef}>
              <button
                type="button"
                onClick={() => setTemplatePickerOpen((v) => !v)}
                className="flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
              >
                <BookOpen size={10} />
                Templates
                <ChevronDown size={10} />
              </button>
              {templatePickerOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onMouseDown={(e) => { e.preventDefault(); setTemplatePickerOpen(false); }}
                  />
                  <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-xl">
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                      Prompt templates
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {PROMPT_TEMPLATES.map((tpl) => (
                        <button
                          key={tpl.id}
                          type="button"
                          onClick={() => applyTemplate(tpl)}
                          className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-[var(--color-panel-hover)]"
                        >
                          <span className="text-xs font-medium text-[var(--color-text)]">
                            {tpl.label}
                          </span>
                          <span className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                            {tpl.description}
                          </span>
                          {tpl.suggestedTools && (
                            <span className="mt-1 text-[10px] text-[var(--color-text-muted)] opacity-70">
                              Enables: {tpl.suggestedTools.join(", ")}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          <textarea
            id="zone-system-prompt"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={4}
            className="input"
            placeholder="You are a helpful assistant."
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label={`Temperature: ${temperature.toFixed(2)}`}>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full"
            />
          </Field>
          <Field label="Max tokens">
            <input
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value.replace(/\D/g, ""))}
              className="input"
              placeholder="unlimited"
            />
          </Field>
          <Field label="Top-p">
            <input
              value={topP}
              onChange={(e) => setTopP(e.target.value)}
              className="input"
              placeholder="optional"
            />
          </Field>
        </div>

        <Field label="Tools">
          <div className="flex flex-col gap-1.5">
            {/* Master toggle. Enabling writes out every id explicitly rather than
                storing a wildcard, so a zone's toolset stays a fixed, reviewable
                list and a tool added in a later release is never silently granted
                to it — which matters now that `file_manage` can delete. */}
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] pb-1.5">
              <GroupToggle
                label="All tools"
                enabled={everyToolEnabled}
                mixed={someToolEnabled && !everyToolEnabled}
                onToggle={() => setTools(everyToolEnabled ? [] : allToolIds)}
                emphasis
              />
              {zone?.id && usage.length > 0 && (
                <button
                  type="button"
                  onClick={async () => {
                    await api.resetToolUsage(zone.id);
                    setUsage([]);
                  }}
                  className="ml-auto text-[10px] text-[var(--color-text-muted)] underline hover:text-[var(--color-accent)]"
                >
                  reset usage stats
                </button>
              )}
            </div>

            {TOOL_CATEGORIES.map((category) => {
              // Hidden tools (e.g. legacy web_search) never appear in the picker;
              // a zone that still has one enabled keeps it, it's just not offered.
              const inCategory = ALL_TOOLS.filter((t) => t.category === category && !t.hidden);
              if (inCategory.length === 0) return null;
              const ids = inCategory.map((t) => t.id);
              const on = ids.filter((id) => tools.includes(id)).length;
              return (
                <div key={category} className="mt-1">
                  <GroupToggle
                    label={category}
                    enabled={on === ids.length}
                    mixed={on > 0 && on < ids.length}
                    onToggle={() => setGroupEnabled(ids, on !== ids.length)}
                  />
                  <div className="mt-1 flex flex-col gap-1.5">
                    {inCategory.map((t) => {
                      const badge = SAFETY_BADGE[t.safety];
                      const enabled = tools.includes(t.id);
                      const fns = toolFns.filter((f) => f.toolId === t.id);
                      const customized = fns.filter((f) => descOverrides[f.name]?.trim()).length;
                      // Usage is counted per function; a group's figure is the sum
                      // across the functions it exposes.
                      const names = new Set(fns.map((f) => f.name));
                      const stats = usage.filter((u) => names.has(u.toolName));
                      const calls = stats.reduce((n, u) => n + u.calls, 0);
                      const errors = stats.reduce((n, u) => n + u.errors, 0);
                      return (
                        <div
                          key={t.id}
                          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-xs"
                        >
                          <label className="flex cursor-pointer items-start gap-2 p-2 hover:border-[var(--color-accent)]">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={() => toggleTool(t.id)}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium">{t.label}</span>
                                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>
                                  {badge.label}
                                </span>
                                {customized > 0 && (
                                  <span className="rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--color-accent)]">
                                    {customized} custom
                                  </span>
                                )}
                                {/* Usage (0.9.3): an enabled tool this zone has
                                    never called is costing context on every turn
                                    for nothing — say so plainly. */}
                                {enabled && zone?.id && (
                                  <span
                                    className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]"
                                    title={
                                      calls === 0
                                        ? "This zone has never called this tool. It still costs context on every turn."
                                        : `Called ${calls}×${errors > 0 ? `, ${errors} failed` : ""}`
                                    }
                                  >
                                    {calls === 0 ? (
                                      "never used"
                                    ) : (
                                      <>
                                        {calls}× used
                                        {errors > 0 && (
                                          <span className="text-[var(--color-danger)]"> · {errors} failed</span>
                                        )}
                                      </>
                                    )}
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 text-[var(--color-text-muted)]">{t.description}</div>
                            </div>
                          </label>

                          {/* Per-zone description overrides (0.9.3). A tool's
                              description is the whole of what the model knows about
                              when to call it, and the wording that works for a
                              frontier model often isn't the wording that works for a
                              7B local one — so it's editable, per zone. Only offered
                              for enabled tools, to keep the list quiet. */}
                          {enabled && fns.length > 0 && (
                            <div className="border-t border-[var(--color-border)]">
                              <button
                                type="button"
                                onClick={() => setEditingDesc(editingDesc === t.id ? null : t.id)}
                                className="flex w-full items-center gap-1 px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                              >
                                <ChevronDown
                                  size={10}
                                  className={`transition-transform ${editingDesc === t.id ? "" : "-rotate-90"}`}
                                />
                                What the model is told ({fns.length})
                              </button>

                              {editingDesc === t.id && (
                                <div className="flex flex-col gap-2 p-2 pt-0">
                                  {fns.map((f) => (
                                    <div key={f.name}>
                                      <div className="mb-0.5 flex items-center gap-1.5">
                                        <span className="font-mono text-[10px]">{f.name}</span>
                                        {descOverrides[f.name]?.trim() && (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setDescOverrides((d) => {
                                                const next = { ...d };
                                                delete next[f.name];
                                                return next;
                                              })
                                            }
                                            className="text-[10px] text-[var(--color-text-muted)] underline hover:text-[var(--color-accent)]"
                                          >
                                            reset
                                          </button>
                                        )}
                                      </div>
                                      <textarea
                                        value={descOverrides[f.name] ?? ""}
                                        onChange={(e) =>
                                          setDescOverrides((d) => ({ ...d, [f.name]: e.target.value }))
                                        }
                                        placeholder={f.description}
                                        rows={3}
                                        className="input w-full resize-y font-mono text-[10px] leading-relaxed"
                                      />
                                    </div>
                                  ))}
                                  <p className="text-[10px] text-[var(--color-text-muted)]">
                                    Leave a box empty to use the built-in description shown as
                                    placeholder text. This is what the model reads to decide when and
                                    how to call the tool — rewriting it is the most direct way to fix a
                                    model that ignores a tool or uses it wrongly.
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* MCP tools from connected servers, alongside built-in tools. Each
                carries its user-assigned danger badge; toggling adds/removes the
                qualified `mcp__server__tool` id from this zone's enabled set. The
                group header toggles every tool from that one server at once. */}
            {mcpServers
              .filter((s) => s.enabled && s.tools.length > 0)
              .map((s) => {
                const ids = s.tools.map((t) => mcpToolEnableId(s.id, t.name));
                const on = ids.filter((id) => tools.includes(id)).length;
                return (
                  <div key={s.id} className="mt-1">
                    <GroupToggle
                      label={`MCP · ${s.name}`}
                      enabled={on === ids.length}
                      mixed={on > 0 && on < ids.length}
                      onToggle={() => setGroupEnabled(ids, on !== ids.length)}
                    />
                    <div className="mt-1 flex flex-col gap-1.5">
                      {s.tools.map((t) => {
                        const id = mcpToolEnableId(s.id, t.name);
                        const badge = SAFETY_BADGE[t.dangerLevel] ?? SAFETY_BADGE[1];
                        return (
                          <label
                            key={t.id}
                            className="flex cursor-pointer items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs hover:border-[var(--color-accent)]"
                          >
                            <input
                              type="checkbox"
                              checked={tools.includes(id)}
                              onChange={() => toggleTool(id)}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono font-medium">{t.name}</span>
                                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>
                                  {badge.label}
                                </span>
                              </div>
                              {t.description && (
                                <div className="mt-0.5 line-clamp-2 text-[var(--color-text-muted)]">{t.description}</div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
          </div>
        </Field>

        {tools.includes("code_exec") && (
          <div className="mb-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            <div className="mb-2 text-xs font-medium text-[var(--color-text)]">Code Execution settings</div>
            <label className="flex cursor-pointer items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-xs hover:border-[var(--color-accent)]">
              <input
                type="checkbox"
                checked={ceHeadless}
                onChange={(e) => onCeHeadlessChange(e.target.checked)}
                className="mt-0.5 shrink-0"
              />
              <div>
                <div className="font-medium">Headless mode</div>
                <div className="text-[var(--color-text-muted)]">
                  Suppress console/terminal windows when running code on Windows. Prevents the brief
                  window flash that appears before execution completes.
                </div>
              </div>
            </label>
          </div>
        )}

        <Field label="Reasoning">
          <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs hover:border-[var(--color-accent)]">
              <input
                type="checkbox"
                checked={thinkingEnabled}
                onChange={(e) => setThinkingEnabled(e.target.checked)}
              />
              <div>
                <div className="font-medium">Enable thinking</div>
                <div className="text-[var(--color-text-muted)]">
                  Requests reasoning output (sends <code>reasoning_effort: "medium"</code>) and
                  renders the model's thinking as a step before its answer. Works with reasoning
                  models like DeepSeek-R1, Qwen QwQ, and OpenAI's o-series.
                </div>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs hover:border-[var(--color-accent)]">
              <input
                type="checkbox"
                checked={includeThinkingInContext}
                onChange={(e) => setIncludeThinkingInContext(e.target.checked)}
              />
              <div>
                <div className="font-medium">Keep thinking in conversation history</div>
                <div className="text-[var(--color-text-muted)]">
                  When off (default), inline <code>&lt;think&gt;…&lt;/think&gt;</code> blocks are
                  stripped from past assistant turns before being fed back to the model. Long chats
                  with Qwen-style models stay cheap. Turn on only if you want the model to see its
                  own prior reasoning verbatim on follow-ups. (Models that emit thinking on a
                  separate <code>reasoning_content</code> field — DeepSeek-R1, OpenAI o-series —
                  are not affected; that field is never echoed back regardless.)
                </div>
              </div>
            </label>
          </div>
        </Field>

        <Field label="Multizone">
          <label className="flex cursor-pointer items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs hover:border-[var(--color-accent)]">
            <input
              type="checkbox"
              checked={isLeader}
              onChange={(e) => {
                const on = e.target.checked;
                setIsLeader(on);
                // A leader drives sub-agents via the subchat tools — enable them
                // automatically when the role is turned on.
                if (on) {
                  setTools((prev) => (prev.includes("subchat") ? prev : [...prev, "subchat"]));
                }
              }}
              className="mt-0.5 shrink-0"
            />
            <div>
              <div className="flex items-center gap-1.5">
                <Crown size={12} className="text-amber-500" />
                <span className="font-medium">Response Leader</span>
              </div>
              <div className="mt-0.5 text-[var(--color-text-muted)]">
                Marks this zone as a sub-agent coordinator. In a multizone session it
                delegates to specialist zones via <code>spawn_subagent</code> /{" "}
                <code>send_subchat_message</code>, presents opposing views to each, and
                synthesizes their answers before replying. Enabling this turns on the
                subchat tools.
              </div>
            </div>
          </label>
        </Field>

        <Field label="Voice (read aloud)">
          <input
            type="text"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
            className="input"
            placeholder="Inherit global voice (e.g. alloy, nova)"
            spellCheck={false}
          />
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            Voice used when responses from this zone are spoken. Leave empty to use the global default
            from Settings → Voice.
          </p>
        </Field>

        <Field label="Tool config (JSON)">
          <textarea
            value={toolConfig}
            onChange={(e) => setToolConfig(e.target.value)}
            rows={4}
            className="input font-mono text-xs"
            placeholder='{ "code_exec": { "timeout_secs": 10, "enabled_languages": ["python"] } }'
          />
        </Field>
      </div>

      <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
        {zone && (
          <button
            onClick={handleDelete}
            className="flex items-center gap-1 rounded border border-[var(--color-danger)] px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
          >
            <Trash2 size={12} /> Delete
          </button>
        )}
        <button
          onClick={onSave}
          disabled={saving || !name.trim() || !model.trim()}
          className="rounded px-3 py-1.5 text-xs text-white disabled:opacity-50"
          style={{ background: activeColor }}
        >
          {zone ? "Save" : "Create zone"}
        </button>
      </div>

      <style>{`.input { width: 100%; border: 1px solid var(--color-border); border-radius: 4px; padding: 6px 8px; background: var(--color-panel); font-size: 13px; } .input:focus { border-color: var(--color-accent); outline: none; }`}</style>
    </>
  );
}

function IconButton({
  iconId,
  IconComp,
  label,
  selected,
  activeColor,
  onClick,
}: {
  iconId: string;
  IconComp: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  selected: boolean;
  activeColor: string;
  onClick: () => void;
}) {
  return (
    <button
      key={iconId}
      onClick={onClick}
      title={label}
      className="flex items-center justify-center rounded p-1.5 transition"
      style={
        selected
          ? { background: activeColor }
          : undefined
      }
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLElement).style.background = "var(--color-panel-hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = "";
      }}
    >
      <IconComp size={14} color={selected ? "white" : undefined} />
    </button>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <div className="mb-1 text-xs text-[var(--color-text-muted)]">{label}</div>
      {children}
    </label>
  );
}
