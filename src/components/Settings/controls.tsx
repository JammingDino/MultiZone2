import { useEffect, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { ApprovalCategory, ApprovalPolicy } from "@/lib/types";

/** A labelled checkbox row used by the export selector. */
export function CheckLine({
  label, hint, checked, onChange,
}: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {hint && <span className="text-[var(--color-text-muted)]">— {hint}</span>}
    </label>
  );
}

/**
 * Per-row picker for one collection. `selected === null` means "all", which is
 * kept distinct from "every id happens to be listed" so rows added later stay in.
 */
export function PickList({
  title, rows, selected, onToggle, onAll,
}: {
  title: string;
  rows: { id: string; name: string }[];
  selected: string[] | null;
  onToggle: (id: string) => void;
  onAll: (on: boolean) => void;
}) {
  if (rows.length === 0) return null;
  const isOn = (id: string) => selected === null || selected.includes(id);
  const count = selected === null ? rows.length : selected.length;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          {title} ({count}/{rows.length})
        </span>
        <div className="flex gap-2 text-[11px]">
          <button onClick={() => onAll(true)} className="text-[var(--color-accent)] hover:underline">All</button>
          <button onClick={() => onAll(false)} className="text-[var(--color-accent)] hover:underline">None</button>
        </div>
      </div>
      <div className="flex max-h-[120px] flex-col gap-0.5 overflow-y-auto">
        {rows.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" checked={isOn(r.id)} onChange={() => onToggle(r.id)} />
            <span className="truncate">{r.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Shared components ────────────────────────────────────────────────────────

/** Standard section block: title, optional help text, and consistent spacing. */
function Section({ title, help, children }: { title: string; help?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      {help && <p className="mb-3 text-xs text-[var(--color-text-muted)]">{help}</p>}
      {children}
    </section>
  );
}

/** Styled <select> matching the app's input chrome — replaces bare native selects. */
export function SettingSelect({
  value, onChange, children, className = "", disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full appearance-none rounded border border-[var(--color-border)] bg-[var(--color-panel)] py-2 pl-3 pr-8 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
      >
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
    </div>
  );
}

/**
 * A group of mutually-exclusive options — the settings counterpart to
 * [`ToggleRow`], for a choice with more than two states or one that needs a line
 * of explanation per option.
 *
 * This markup was hand-copied ten times across this file and had drifted in
 * padding and in whether an option could carry a description, so two settings
 * screens away from each other looked subtly different. One component, one look.
 *
 * `layout` is only about shape: `row` for two or three short labels side by
 * side, `column` when the descriptions need the width. `align` centres a row of
 * bare values (a numeric choice) where a label with prose reads better left.
 */
/**
 * A segmented control's two states. The selected one is a quiet fill rather
 * than the accent (0.18.3): a page of seven "Inherit"s in solid accent was the
 * loudest thing in Settings, and accent is what a switch that is on looks like.
 */
const SEG_ON = "bg-[var(--color-panel-hover)] font-medium text-[var(--color-text)]";
const SEG_OFF = "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]";

export function OptionCards<T extends string | number>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  /** `[value, label]` or `[value, label, description]`. */
  options: readonly (readonly [T, string] | readonly [T, string, string])[];
  /** Kept for callers; the shape now follows whether options are described. */
  layout?: "row" | "column";
  align?: "left" | "center";
}) {
  // Bare values are a segmented control: one line, the choice readable at a
  // glance (0.18.3). They were a row of full-width cards, which made "Enter or
  // Ctrl+Enter" the heaviest thing on its page.
  if (options.every((o) => o.length === 2)) {
    return (
      <div role="radiogroup" className="inline-flex flex-wrap overflow-hidden rounded border border-[var(--color-border)] text-sm">
        {options.map(([val, label]) => (
          <button
            key={val}
            role="radio"
            aria-checked={value === val}
            onClick={() => onChange(val)}
            className={`px-3 py-1.5 ${value === val ? SEG_ON : SEG_OFF}`}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }
  // Described options are a radio list: a dot, the label, the line of
  // explanation beside it — no box around each.
  return (
    <div role="radiogroup" className="flex flex-col">
      {options.map(([val, label, description]) => (
        <button
          key={val}
          role="radio"
          aria-checked={value === val}
          onClick={() => onChange(val)}
          className="-mx-2 flex items-baseline gap-2.5 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
        >
          <span
            className={`relative top-0.5 h-3.5 w-3.5 shrink-0 self-start rounded-full border ${
              value === val ? "border-[4px] border-[var(--color-accent)]" : "border-[var(--color-border)]"
            }`}
          />
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className={value === val ? "text-[var(--color-text)]" : ""}>{label}</span>
            {description && <span className="text-xs text-[var(--color-text-muted)]">{description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The seven categories, in the order someone reads them: what an agent looks
 * at, then what it changes, then what it reaches (0.14.2).
 */
const APPROVAL_CATEGORIES: [ApprovalCategory, string, string][] = [
  ["read", "Read", "Open files, search, list, read memory or another agent's transcript."],
  ["edit", "Edit", "Write, move, copy or delete files."],
  ["shell", "Shell", "Run commands, execute code, drive a terminal."],
  ["web", "Web", "Search, fetch a page, crawl, raw HTTP."],
  ["mcp", "MCP", "Anything served by a connected MCP server."],
  ["spawn", "Sub-agents", "Start a sub-agent or hand it work."],
  ["state", "App state", "Change settings, memories, skills, zones, tags."],
];

/**
 * Three states per category, and the third one matters: *inherit* is not the
 * same as *ask*. An install that never touches this panel has to keep behaving
 * exactly as it did, which means "undecided" has to be representable.
 */
export function ApprovalCategoryGrid({
  value,
  onChange,
  compact,
}: {
  value: ApprovalPolicy;
  onChange: (next: ApprovalPolicy) => void;
  compact?: boolean;
}) {
  function set(cat: ApprovalCategory, next: boolean | undefined) {
    const categories = { ...value.categories };
    if (next === undefined) delete categories[cat];
    else categories[cat] = next;
    onChange({ ...value, categories });
  }

  return (
    <div className="divide-y divide-[var(--color-border)]">
      {APPROVAL_CATEGORIES.map(([cat, label, description]) => {
        const current = value.categories[cat];
        return (
          <div key={cat} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">{label}</div>
              {!compact && (
                <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{description}</div>
              )}
            </div>
            <div className="flex shrink-0 overflow-hidden rounded border border-[var(--color-border)] text-[11px]">
              {([
                [undefined, "Inherit"],
                [false, "Ask"],
                [true, "Auto"],
              ] as [boolean | undefined, string][]).map(([state, text]) => (
                <button
                  key={text}
                  onClick={() => set(cat, state)}
                  className={`px-2 py-1 ${current === state ? SEG_ON : SEG_OFF}`}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A newline-separated prefix list, edited as text because that is how people
 * think about a list of commands. Blank lines are dropped on the way out. */
export function PrefixList({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">{label}</span>
      <textarea
        value={value.join("\n")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        rows={4}
        spellCheck={false}
        placeholder={placeholder}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

/** Integer input that validates on every keystroke: commits valid values
 *  immediately and highlights invalid ones inline rather than on save. */
export function NumberField({
  value, min, max, onCommit, width = "w-24",
}: {
  value: number;
  min: number;
  max?: number;
  onCommit: (v: number) => void;
  width?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const n = parseInt(draft, 10);
  const invalid = !Number.isFinite(n) || n < min || (max !== undefined && n > max);

  return (
    <div>
      <input
        value={draft}
        inputMode="numeric"
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          const v = parseInt(next, 10);
          if (Number.isFinite(v) && v >= min && (max === undefined || v <= max)) onCommit(v);
        }}
        className={`${width} rounded border bg-[var(--color-panel)] px-2 py-1.5 text-sm outline-none ${
          invalid ? "border-[var(--color-danger)]" : "border-[var(--color-border)] focus:border-[var(--color-accent)]"
        }`}
      />
      {invalid && (
        <p className="mt-1 text-[11px] text-[var(--color-danger)]">
          Enter a whole number {max !== undefined ? `between ${min} and ${max}` : `${min} or greater`}.
        </p>
      )}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block">
      <div className="mb-1 text-xs text-[var(--color-text-muted)]">{label}</div>
      {children}
    </label>
  );
}

export function SliderRow({
  label, value, min, max, step, display, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
        <span>{label}</span>
        <span className="tabular-nums">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full"
      />
    </div>
  );
}
