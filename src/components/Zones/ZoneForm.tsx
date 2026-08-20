import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw, Trash2, X, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Crown,
  Sliders, MessageSquareText, Wrench, Gauge, Cog, Brain,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { VisionOverrideSelect } from "@/components/common/VisionOverrideSelect";
import { IconPicker } from "@/components/common/IconPicker";
import { ColorPicker } from "@/components/common/ColorPicker";
import type { ApprovalCategory, ApprovalPolicy, Provider, ToolFunctionInfo, ToolUsage, Zone } from "@/lib/types";
import { ALL_TOOLS, TOOL_CATEGORIES, mcpToolEnableId } from "@/lib/types";
import { useApp } from "@/store/app";
import { DEFAULT_ZONES } from "@/lib/defaultZones";
import { EMPTY_APPROVALS, parseApprovals, serializeApprovals } from "@/lib/approvals";

/** Zone override categories, short labels — the long descriptions live in
 * Settings, where the global policy is set and explained. */
const ZONE_APPROVAL_CATEGORIES: [ApprovalCategory, string][] = [
  ["read", "Read"],
  ["edit", "Edit"],
  ["shell", "Shell"],
  ["web", "Web"],
  ["mcp", "MCP"],
  ["spawn", "Sub-agents"],
  ["state", "App state"],
];

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
/**
 * A collapsible tool group (0.9.4). The header carries the group's own
 * enable-all checkbox alongside the disclosure, so a category can be switched on
 * wholesale without expanding it — and the "n of m on" count means a collapsed
 * group still says what it's doing.
 */
function ToolGroup({
  label,
  enabled,
  mixed,
  onToggle,
  open,
  onOpenChange,
  count,
  total,
  children,
}: {
  label: string;
  enabled: boolean;
  mixed: boolean;
  onToggle: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  total: number;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)]">
      <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--color-panel-hover)]">
        <input
          ref={box}
          type="checkbox"
          checked={enabled}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0"
          title={enabled ? `Disable all of ${label}` : `Enable all of ${label}`}
        />
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronDown
            size={12}
            className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <span className="truncate text-[11px] font-semibold uppercase tracking-wide">{label}</span>
          <span className="ml-auto shrink-0 text-[10px] font-normal text-[var(--color-text-muted)]">
            {count} of {total} on
          </span>
        </button>
      </div>
      {open && <div className="flex flex-col gap-1.5 border-t border-[var(--color-border)] p-2">{children}</div>}
    </div>
  );
}

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


/**
 * The five anchors of the editor. The form is one continuous scroll — this list
 * drives both the section headings and the nav rail beside them, so adding a
 * section here is all it takes for it to appear in the rail.
 */
const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "basics",   label: "Basics",   icon: Sliders },
  { id: "prompt",   label: "Prompt",   icon: MessageSquareText },
  { id: "tools",    label: "Tools",    icon: Wrench },
  { id: "sampling", label: "Sampling", icon: Gauge },
  { id: "advanced", label: "Advanced", icon: Cog },
];

const NAV_OPEN_KEY = "mz.zoneForm.navOpen";

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
  // null = leave the field off the request so the provider's own default applies.
  const [temperature, setTemperature] = useState<number | null>(null);
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
  const refreshZones = useApp((s) => s.refreshZones);
  /** Every other zone, for the fallback picker (0.14.1). */
  const zones = useApp((s) => s.zones);
  const [ceHeadless, setCeHeadless] = useState(false);
  const [ttsVoice, setTtsVoice] = useState("");
  // Thinking is on by default for new zones (0.9.4) — most current models
  // benefit, and the ones that don't simply ignore the request.
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [includeThinkingInContext, setIncludeThinkingInContext] = useState(false);
  const [isLeader, setIsLeader] = useState(false);
  const [fallbackZoneId, setFallbackZoneId] = useState<string | null>(null);
  /** This zone's approval overrides (0.14.2). Empty = inherit everything. */
  const [approvals, setApprovals] = useState<ApprovalPolicy>(EMPTY_APPROVALS);
  const [icon, setIcon] = useState<string | null>(null);
  const [accentColor, setAccentColor] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const templatePickerRef = useRef<HTMLDivElement>(null);
  /** Which tool groups are expanded. Missing key = collapsed. */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  // ── Section nav (anchor scroll) ────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);
  const [navOpen, setNavOpen] = useState(
    () => localStorage.getItem(NAV_OPEN_KEY) !== "0",
  );
  useEffect(() => {
    localStorage.setItem(NAV_OPEN_KEY, navOpen ? "1" : "0");
  }, [navOpen]);

  /**
   * Scroll spy. An IntersectionObserver is the usual reach, but sections here
   * differ wildly in height (Tools dwarfs Sampling) and collapse as groups are
   * toggled, which makes ratio-based observers jumpy. Measuring tops against a
   * fixed probe line is stable under all of that.
   */
  const syncActive = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const probe = box.getBoundingClientRect().top + 72;
    let current = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const el = sectionRefs.current[s.id];
      if (el && el.getBoundingClientRect().top <= probe) current = s.id;
    }
    // At the very bottom the last section may never cross the probe line, so
    // claim it explicitly — otherwise the rail sticks on the second-to-last.
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) {
      current = SECTIONS[SECTIONS.length - 1].id;
    }
    setActiveSection(current);
  }, []);

  useLayoutEffect(syncActive, [syncActive]);

  function goToSection(id: string) {
    const el = sectionRefs.current[id];
    const box = scrollRef.current;
    if (!el || !box) return;
    const top = el.offsetTop - 12;
    box.scrollTo({ top, behavior: "smooth" });
    setActiveSection(id);
  }

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
      setThinkingEnabled(zone.thinkingEnabled ?? true);
      setIncludeThinkingInContext(zone.includeThinkingInContext ?? false);
      setIsLeader(zone.isLeader ?? false);
      setFallbackZoneId(zone.fallbackZoneId ?? null);
      setApprovals(parseApprovals(zone.approvals));
      setIcon(zone.icon ?? null);
      setAccentColor(zone.accentColor ?? null);
    } else {
      setName("");
      setProviderId(providers[0]?.id ?? null);
      setModel("");
      setSystemPrompt("");
      setTemperature(null);
      setMaxTokens("");
      setTopP("");
      setTools([]);
      setToolConfig("{}");
      setCeHeadless(false);
      setTtsVoice("");
      setDescOverrides({});
      setThinkingEnabled(true);
      setIncludeThinkingInContext(false);
      setIsLeader(false);
      setFallbackZoneId(null);
      setApprovals(EMPTY_APPROVALS);
      setIcon(null);
      setAccentColor(null);
    }
    setOpenGroups({});
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

  /** Everything the editor holds, in the shape `upsert_zone` takes. */
  function buildPayload() {
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
    return {
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
      fallbackZoneId,
      approvals: serializeApprovals(approvals),
      icon,
      accentColor,
    };
  }

  /** Create a new zone. Editing an existing one saves itself — see below. */
  async function onCreate() {
    if (!name.trim() || !model.trim()) return;
    setSaving(true);
    try {
      onSaved(await api.upsertZone(buildPayload()));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Autosave (1.1).
   *
   * The zone editor is five sections of settings behind a scroll and a nav
   * rail, and it ended in a Save button you had to remember on the way out —
   * so the common way to use it was to change a tool, close it, and find out
   * later that nothing had been saved. An existing zone now writes itself a
   * beat after you stop, and the button is gone. Creating one still takes the
   * explicit action, because a half-typed zone should not become a real one.
   *
   * The debounce is also what makes switching zones safe: for one render after
   * `zone` changes the fields still hold the *previous* zone's values, and a
   * write then would copy them onto the new zone. The reset effect refills them
   * in the same commit cycle, which cancels that timer long before it fires.
   */
  useEffect(() => {
    if (!zone?.id) return;
    if (!name.trim() || !model.trim()) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        await api.upsertZone(buildPayload());
        await refreshZones();
      } catch (e) {
        console.error("zone autosave failed", e);
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    zone?.id, name, providerId, model, systemPrompt, temperature, maxTokens, topP,
    tools, toolConfig, descOverrides, ttsVoice, thinkingEnabled,
    includeThinkingInContext, isLeader, fallbackZoneId, approvals, icon, accentColor,
  ]);

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

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} onScroll={syncActive} className="flex-1 overflow-y-auto p-4">
        <Section id="basics" label="Basics" refs={sectionRefs}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
        </Field>

        {/* Identity: icon and colour sit side by side, and the icon grid lives in
            a popover rather than inline — it used to be the tallest thing in the
            form for what is a one-off choice. */}
        <div className="mb-3 grid grid-cols-2 gap-3">
          <IconPicker value={icon} onChange={setIcon} activeColor={activeColor} />
          <ColorPicker
            value={accentColor}
            onChange={setAccentColor}
            label="Zone color"
          />
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

        {/* Image input and reasoning share a row. Reasoning used to be two
            paragraph-sized cards further down the form; the long-form rationale
            now lives in tooltips so the choice reads as the pair of switches it
            actually is. */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Image input">
            <VisionOverrideSelect model={model} />
          </Field>
          <div className="mb-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              <Brain size={12} /> Reasoning
            </div>
            <label
              className="flex h-[34px] cursor-pointer items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs hover:border-[var(--color-accent)]"
              title={'Requests reasoning output (sends reasoning_effort: "medium") and renders the model\'s thinking as a step before its answer. Works with reasoning models like DeepSeek-R1, Qwen QwQ, and OpenAI\'s o-series.'}
            >
              <input
                type="checkbox"
                checked={thinkingEnabled}
                onChange={(e) => setThinkingEnabled(e.target.checked)}
                className="shrink-0"
              />
              Enable thinking
            </label>
          </div>
        </div>
        </Section>

        <Section id="prompt" label="Prompt" refs={sectionRefs}>
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

        </Section>

        <Section id="tools" label="Tools" refs={sectionRefs}>
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
                <ToolGroup
                  key={category}
                  label={category}
                  enabled={on === ids.length}
                  mixed={on > 0 && on < ids.length}
                  onToggle={() => setGroupEnabled(ids, on !== ids.length)}
                  open={!!openGroups[category]}
                  onOpenChange={(o) => setOpenGroups((g) => ({ ...g, [category]: o }))}
                  count={on}
                  total={ids.length}
                >
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
                </ToolGroup>
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
                  <ToolGroup
                    key={s.id}
                    label={`MCP · ${s.name}`}
                    enabled={on === ids.length}
                    mixed={on > 0 && on < ids.length}
                    onToggle={() => setGroupEnabled(ids, on !== ids.length)}
                    open={!!openGroups[`mcp:${s.id}`]}
                    onOpenChange={(o) => setOpenGroups((g) => ({ ...g, [`mcp:${s.id}`]: o }))}
                    count={on}
                    total={ids.length}
                  >
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
                  </ToolGroup>
                );
              })}
          </div>

        {tools.includes("code_exec") && (
          <div className="mt-3 mb-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
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

        </Section>

        <Section id="sampling" label="Sampling" refs={sectionRefs}>
        <div className="grid grid-cols-3 gap-3">
          <Field
            label={`Temperature: ${temperature === null ? "provider default" : temperature.toFixed(2)}`}
          >
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={temperature ?? 0.7}
              disabled={temperature === null}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full disabled:opacity-40"
            />
            <button
              type="button"
              onClick={() => setTemperature(temperature === null ? 0.7 : null)}
              className="mt-0.5 text-[10px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-accent)] hover:underline"
            >
              {temperature === null ? "Set a temperature" : "Use provider default"}
            </button>
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
        </Section>

        <Section id="advanced" label="Advanced" refs={sectionRefs}>
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
                synthesizes their answers before replying. It's told to fan several
                sub-agents out in the background at once and reuse the ones it already
                briefed. Enabling this turns on the subchat tools.
              </div>
            </div>
          </label>
        </Field>

        <Field label="Approvals">
          <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">
            What this zone in particular may do without asking. Everything left on{" "}
            <strong>Inherit</strong> follows Settings → Chat. This is where a scout that only reads
            and an implementer that may edit stop being the same policy — and where neither of them
            gets unreviewed shell.
          </p>
          <div className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
            {ZONE_APPROVAL_CATEGORIES.map(([cat, label]) => {
              const current = approvals.categories[cat];
              return (
                <div key={cat} className="flex items-center gap-3 px-2 py-1.5">
                  <span className="min-w-0 flex-1 text-xs">{label}</span>
                  <div className="flex shrink-0 overflow-hidden rounded border border-[var(--color-border)] text-[11px]">
                    {([
                      [undefined, "Inherit"],
                      [false, "Ask"],
                      [true, "Auto"],
                    ] as [boolean | undefined, string][]).map(([state, text]) => (
                      <button
                        key={text}
                        type="button"
                        onClick={() =>
                          setApprovals((p) => {
                            const categories = { ...p.categories };
                            if (state === undefined) delete categories[cat];
                            else categories[cat] = state;
                            return { ...p, categories };
                          })
                        }
                        className={`px-2 py-0.5 ${
                          current === state
                            ? "bg-[var(--color-accent)] text-white"
                            : "bg-[var(--color-panel)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {([
              ["shellAllow", "Run without asking", "npm run test"],
              ["shellDeny", "Never run", "git push"],
              ["editAllow", "Edit without asking", "{project}"],
              ["editDeny", "Never edit", "{project}/.git"],
            ] as ["shellAllow" | "shellDeny" | "editAllow" | "editDeny", string, string][]).map(([key, label, placeholder]) => (
              <label key={key} className="block">
                <span className="mb-1 block text-[11px] font-medium">{label}</span>
                <textarea
                  value={approvals[key].join("\n")}
                  onChange={(e) =>
                    setApprovals((p) => ({
                      ...p,
                      [key]: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    }))
                  }
                  rows={3}
                  spellCheck={false}
                  placeholder={placeholder}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--color-accent)]"
                />
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            Command prefixes and paths, one per line — <strong>added to</strong> the global lists
            rather than replacing them, since a deny list you can drop by configuring something
            else is not a deny list. Longest match wins. In the path lists{" "}
            <code>{"{project}"}</code> is the chat's own project directory, and anything under{" "}
            <em>Edit without asking</em> makes those paths a boundary: an edit outside them is
            prompted even where the Edit category says auto.
          </p>
        </Field>

        <Field label="Fallback zone">
          <select
            value={fallbackZoneId ?? ""}
            onChange={(e) => setFallbackZoneId(e.target.value || null)}
            className="input"
          >
            <option value="">None — a provider failure ends the turn</option>
            {zones
              .filter((z) => z.id !== zone?.id)
              .map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
          </select>
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            Answers with instead when this zone's provider won't serve the request — rate limited,
            host down, key rejected. Used once per turn, so pick a zone on a{" "}
            <strong>different provider</strong>: falling back to another zone on the same dead host
            just fails twice. In a panel this is the difference between losing a member mid-run and
            losing the run.
          </p>
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

        {/* The counterpart to "Enable thinking" up in Basics, but a much rarer
            thing to want — it lives down here with the other sharp edges. */}
        <Field label="Thinking in history">
          <label
            className={`flex items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs ${
              thinkingEnabled ? "cursor-pointer hover:border-[var(--color-accent)]" : "cursor-default opacity-50"
            }`}
          >
            <input
              type="checkbox"
              checked={includeThinkingInContext}
              onChange={(e) => setIncludeThinkingInContext(e.target.checked)}
              disabled={!thinkingEnabled}
              className="mt-0.5 shrink-0"
            />
            <div>
              <div className="font-medium">Keep thinking in conversation history</div>
              <div className="text-[var(--color-text-muted)]">
                When off (default), inline <code>&lt;think&gt;…&lt;/think&gt;</code> blocks are
                stripped from past assistant turns before being fed back to the model, so long
                chats with Qwen-style models stay cheap. Turn on only if you want the model to see
                its own prior reasoning verbatim on follow-ups. (Models that emit thinking on a
                separate <code>reasoning_content</code> field — DeepSeek-R1, OpenAI o-series — are
                not affected; that field is never echoed back regardless.)
              </div>
            </div>
          </label>
        </Field>
        </Section>
        </div>

        {/* Section rail. Collapses to icons — the labels are useful the first few
            times and noise after that. */}
        <nav
          className="flex flex-shrink-0 flex-col gap-1 border-l border-[var(--color-border)] p-2 transition-[width] duration-150"
          style={{ width: navOpen ? 136 : 44 }}
        >
          <button
            type="button"
            onClick={() => setNavOpen((v) => !v)}
            title={navOpen ? "Collapse section nav" : "Expand section nav"}
            className="mb-1 flex h-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            {navOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = activeSection === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => goToSection(s.id)}
                title={navOpen ? undefined : s.label}
                className={`flex h-8 items-center gap-2 overflow-hidden rounded-md px-2.5 text-xs font-medium transition ${
                  navOpen ? "" : "justify-center"
                } ${
                  active
                    ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                }`}
              >
                <Icon size={14} className="flex-shrink-0" />
                {navOpen && <span className="whitespace-nowrap">{s.label}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
        {zone && (
          <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">
            {saving ? "Saving…" : "Changes save as you make them"}
          </span>
        )}
        {zone && (
          <button
            onClick={handleDelete}
            className="flex items-center gap-1 rounded border border-[var(--color-danger)] px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
          >
            <Trash2 size={12} /> Delete
          </button>
        )}
        {!zone && (
          <button
            onClick={onCreate}
            disabled={saving || !name.trim() || !model.trim()}
            className="rounded px-3 py-1.5 text-xs text-white disabled:opacity-50"
            style={{ background: activeColor }}
          >
            Create zone
          </button>
        )}
      </div>

      <style>{`.input { width: 100%; border: 1px solid var(--color-border); border-radius: 4px; padding: 6px 8px; background: var(--color-panel); font-size: 13px; } .input:focus { border-color: var(--color-accent); outline: none; }`}</style>
    </>
  );
}

/** One anchor target in the continuous scroll, registered with the nav rail. */
function Section({
  id,
  label,
  refs,
  children,
}: {
  id: string;
  label: string;
  refs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={(el) => { refs.current[id] = el; }}
      className="mt-5 border-t border-[var(--color-border)] pt-4 first:mt-0 first:border-t-0 first:pt-0"
    >
      <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      {children}
    </div>
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
