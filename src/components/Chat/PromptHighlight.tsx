import { forwardRef, useEffect, useRef, useState, type RefObject } from "react";
import * as api from "@/lib/tauri";
import { replaceRange, segments, slashAt } from "@/lib/promptTokens";
import { skillPartText } from "@/lib/skillRuns";

/**
 * Everything a composer needs for commands and folders as words (0.20.1): the
 * caret's `/word` for the menu, what a pick does, and the overlay's state. One
 * hook so the chat composer and the Home screen's behave the same.
 */
export function usePromptTokens(
  text: string,
  setText: (t: string) => void,
  taRef: RefObject<HTMLTextAreaElement | null>,
  paths: string[],
  /** The app's own commands this composer understands (`plan`), drawn like skills. */
  builtins: string[] = [],
) {
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // A send empties the box without an onChange; the next `/` should open the menu.
  useEffect(() => { if (!text) setDismissed(false); }, [text]);
  const word = dismissed ? null : slashAt(text, caret);
  const skills = useSkillCommands();
  const names = builtins.length ? new Set([...skills.names, ...builtins]) : skills.names;
  // The `/word` being typed, while the menu is open for it, draws as becoming a command.
  const typingAt = word ? caret : undefined;
  const highlighted = hasTokens(text, names, paths, typingAt);
  const overlayRef = useRef<HTMLDivElement>(null);
  return {
    /** The menu's query, or null when the caret is not in a `/word`. */
    slash: word?.query ?? null,
    names,
    /** Skills only: what `skillParts` should look up. */
    skillNames: skills.names,
    highlighted,
    /** The overlay's caret: set only while the menu is open for its `/word`. */
    caret: typingAt,
    overlayRef,
    /** Put a pick in place of the caret's `/word`. */
    pick(insert: string) {
      if (!word) return;
      const next = replaceRange(text, word.start, word.end, insert);
      setText(next.text);
      setCaret(next.caret);
      setDismissed(true);
      requestAnimationFrame(() => {
        taRef.current?.focus();
        taRef.current?.setSelectionRange(next.caret, next.caret);
      });
    },
    dismiss: () => setDismissed(true),
    /** Call from the textarea's onChange, after setting the text. */
    changed(value: string, at: number) {
      setCaret(at);
      // Re-arm once the caret leaves a `/word`, so dismissing once does not
      // disable the menu for the session.
      if (slashAt(value, at) === null) setDismissed(false);
    },
    textareaProps: {
      onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart ?? 0),
      onScroll: (e: React.UIEvent<HTMLTextAreaElement>) => {
        if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop;
      },
    },
    /**
     * Classes for the textarea: its own text hides while the overlay draws it.
     * Important, because styles.css gives textarea an unlayered `color: inherit`
     * that beats Tailwind's layered utility: without it the plain text painted
     * over the overlay and every token looked like ordinary words.
     */
    textClass: highlighted ? "text-transparent! caret-[var(--color-text)]" : "",
  };
}

/** Put `insert` at the textarea's caret, with a space either side as needed. */
export function insertAtCaret(cur: string, ta: HTMLTextAreaElement | null, insert: string): string {
  const at = Math.min(ta?.selectionStart ?? cur.length, cur.length);
  const before = cur.slice(0, at);
  const after = cur.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = /^\s/.test(after) ? "" : " ";
  return `${before}${lead}${insert}${trail}${after}`;
}

/**
 * The composer's commands and folders, drawn behind its textarea (0.20.1).
 *
 * The textarea stays a textarea — dictation, paste, undo and IME are unchanged
 * — and its text is made transparent only while there is something to draw.
 * This layer repeats the text in the same font, box and wrapping, with
 * `/commands` and granted paths styled; it never changes a glyph's width, so
 * the caret stays where the eye expects it. The parent keeps `scrollTop` in
 * step.
 */
export const PromptHighlight = forwardRef<HTMLDivElement, { text: string; commands: Set<string>; paths: string[]; caret?: number; className: string }>(
  function PromptHighlight({ text, commands, paths, caret, className }, ref) {
    const segs = segments(text, commands, paths, caret);
    return (
      <div ref={ref} aria-hidden style={{ scrollbarGutter: "stable" }} className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words ${className}`}>
        {segs.map((s, i) =>
          s.kind === "text" ? (
            <span key={i}>{s.text}</span>
          ) : (
            <span key={i} className={`mz-prompt-${s.kind}`}>{s.text}</span>
          ),
        )}
        {/* A trailing newline needs a character after it to take up its line. */}
        {text.endsWith("\n") && " "}
      </div>
    );
  },
);

/** Whether a prompt has anything for the overlay to draw. */
export function hasTokens(text: string, commands: Set<string>, paths: string[], caret?: number): boolean {
  return segments(text, commands, paths, caret).some((s) => s.kind !== "text");
}

// One list for every composer, refreshed when the window regains focus — a
// skill installed in Settings or by an installer shows up without a restart.
let cached: { name: string; description: string }[] = [];
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
// A failed load used to leave the list empty until the window next regained
// focus, so every skill read as plain text while `/plan` (built in) still
// lit up. Retry a failure, backing off, until one load succeeds.
let retryMs = 1000;
function load() {
  inflight ??= api.listSkillCommands()
    .then((l) => { cached = l; retryMs = 1000; })
    .catch(() => {
      setTimeout(load, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    })
    .finally(() => { inflight = null; listeners.forEach((f) => f()); });
}

/** The skills a prompt can invoke as `/name`. */
export function useSkillCommands(): { list: { name: string; description: string }[]; names: Set<string> } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    if (cached.length === 0) load();
    window.addEventListener("focus", load);
    return () => { listeners.delete(f); window.removeEventListener("focus", load); };
  }, []);
  return { list: cached, names: new Set(cached.map((c) => c.name.toLowerCase())) };
}

/**
 * What the commands in a prompt hand the model: each invoked skill's
 * instructions, exactly as `load_skill` returns them, as a part the model reads
 * and the transcript does not show. A name that turns out not to be a skill is
 * left as the word it is.
 */
export async function skillParts(names: string[]): Promise<{ type: "hidden_text"; text: string }[]> {
  const out: { type: "hidden_text"; text: string }[] = [];
  for (const name of names) {
    try {
      const r = JSON.parse(await api.invokeSkill(name));
      if (r.status !== "loaded") continue;
      out.push({ type: "hidden_text", text: skillPartText(r.name, r.instructions, Array.isArray(r.files) ? r.files : []) });
    } catch {
      // Unreachable or not a skill: the word goes as typed.
    }
  }
  return out;
}
