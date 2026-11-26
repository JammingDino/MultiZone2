import { forwardRef, useEffect, useState } from "react";
import * as api from "@/lib/tauri";
import { segments } from "@/lib/promptTokens";

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
export const PromptHighlight = forwardRef<HTMLDivElement, { text: string; commands: Set<string>; paths: string[]; className: string }>(
  function PromptHighlight({ text, commands, paths, className }, ref) {
    const segs = segments(text, commands, paths);
    return (
      <div ref={ref} aria-hidden style={{ scrollbarGutter: "stable" }} className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words ${className}`}>
        {segs.map((s, i) =>
          s.kind === "text" ? (
            <span key={i}>{s.text}</span>
          ) : (
            <span key={i} className={s.kind === "command" ? "mz-prompt-command" : "mz-prompt-path"}>{s.text}</span>
          ),
        )}
        {/* A trailing newline needs a character after it to take up its line. */}
        {text.endsWith("\n") && " "}
      </div>
    );
  },
);

/** Whether a prompt has anything for the overlay to draw. */
export function hasTokens(text: string, commands: Set<string>, paths: string[]): boolean {
  return segments(text, commands, paths).some((s) => s.kind !== "text");
}

// One list for every composer, refreshed when the window regains focus — a
// skill installed in Settings or by an installer shows up without a restart.
let cached: { name: string; description: string }[] = [];
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
function load() {
  inflight ??= api.listSkillCommands()
    .then((l) => { cached = l; })
    .catch(() => {})
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
      const files = Array.isArray(r.files) && r.files.length
        ? `\n\nThis skill has more files, read with load_skill {"name": "${r.name}", "file": …} as its instructions direct: ${r.files.join(", ")}`
        : "";
      out.push({
        type: "hidden_text",
        text: `The user invoked /${r.name} in their message. Apply this skill to it — its instructions:\n\n${r.instructions}${files}`,
      });
    } catch {
      // Unreachable or not a skill: the word goes as typed.
    }
  }
  return out;
}
