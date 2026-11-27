import { useState } from "react";
import { AlertCircle, Check, ChevronDown, ChevronRight, Loader2, Sparkles } from "lucide-react";
import type { ContentPart } from "@/lib/types";
import { commandName, commandsIn } from "@/lib/promptTokens";
import { parseSkillPart, type SkillPart } from "@/lib/skillRuns";
import { useSkillCommands } from "./PromptHighlight";

/**
 * The skills a message ran, shown with it (0.21.0). A typed `/skill` is not a
 * tool call: the app loads it on send and hands its instructions to the model
 * as a hidden part. So a run here is that load — loaded (with its files), or a
 * skill's name that went as plain text because no part was attached for it.
 */
export type SkillRun = SkillPart & { description: string; loaded: boolean };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A sent message's runs, from its unclaimed hidden parts and its text. */
export function useSkillRuns(text: string, hidden: ContentPart[]): SkillRun[] {
  const { list, names } = useSkillCommands();
  // The list holds command forms; a loaded part carries the skill's real name.
  const describe = (n: string) => list.find((k) => same(k.name, commandName(n)))?.description ?? "";
  const loaded = hidden.flatMap((p) => {
    const s = p.type === "hidden_text" ? parseSkillPart(p.text) : null;
    return s ? [s] : [];
  });
  const missing = commandsIn(text, names).filter((n) => !loaded.some((l) => same(commandName(l.name), n)));
  return [
    ...loaded.map((s) => ({ ...s, description: describe(s.name), loaded: true })),
    ...missing.map((name) => ({ name, files: [], excerpt: "", description: describe(name), loaded: false })),
  ];
}

/**
 * Under a bubble, a drawer with a row per skill; in the editorial style, a
 * timeline step per skill that leads into the reply.
 */
export function SkillRuns({ runs, editorial }: { runs: SkillRun[]; editorial: boolean }) {
  if (runs.length === 0) return null;
  return (
    <div className={editorial ? "mz-run-rail" : "mz-run-drawer"}>
      {runs.map((r) => <RunItem key={r.name} run={r} editorial={editorial} />)}
    </div>
  );
}

function RunItem({ run, editorial }: { run: SkillRun; editorial: boolean }) {
  const [open, setOpen] = useState(false);
  const more = run.loaded && (run.files.length > 0 || !!run.excerpt);
  const n = run.files.length;
  const status = run.loaded ? `Loaded${n ? ` · ${n} file${n === 1 ? "" : "s"}` : ""}` : "Sent as text";
  const description = run.loaded ? run.description : "Didn't load, so the word went as typed";
  const Icon = run.loaded ? Sparkles : AlertCircle;
  const Chevron = open ? ChevronDown : ChevronRight;
  // A plain row when there is nothing to open: a disabled button would be
  // drawn dimmed (styles.css), which reads as "failed".
  const Head = more ? "button" : "div";
  const headProps = more
    ? { type: "button" as const, "aria-expanded": open, onClick: () => setOpen((o) => !o), title: open ? "Hide what it loaded" : "Show what it loaded" }
    : {};
  const statusEl = (
    <span className="mz-run-status">
      {run.loaded && <Check size={12} />}
      {status}
    </span>
  );
  const detail = open && more && (
    <div className="mz-run-detail">
      {run.excerpt && <q>{run.excerpt}</q>}
      {n > 0 && (
        <div className="mz-run-files">
          {run.files.map((f) => <code key={f}>{f}</code>)}
        </div>
      )}
    </div>
  );

  if (editorial) {
    return (
      <div className="mz-step" data-bad={run.loaded ? undefined : ""}>
        <span className="mz-step-node"><Icon size={13} /></span>
        <div className="mz-step-card">
          <Head {...headProps} className="mz-step-head">
            <span className="mz-run-chev">{more && <Chevron size={13} />}</span>
            <span className="k">Skill ·</span>
            <span className="nm">{run.name}</span>
            <span className="ds">{description}</span>
            {statusEl}
          </Head>
          {detail}
        </div>
      </div>
    );
  }
  return (
    <div className="mz-run" data-bad={run.loaded ? undefined : ""}>
      <Head {...headProps} className="mz-run-head">
        <span className="mz-run-tile"><Icon size={13} /></span>
        <span className="mz-run-name"><small>Skill</small>{run.name}</span>
        {statusEl}
        <span className="mz-run-chev">{more && <Chevron size={13} />}</span>
        {description && <span className="mz-run-desc">{description}</span>}
      </Head>
      {detail}
    </div>
  );
}

/**
 * The composer's skills before they run: what will load on send, and a spinner
 * while `skillParts` loads them — the only time a run is "loading".
 */
export function SkillQueue({ names, loading }: { names: string[]; loading: boolean }) {
  if (names.length === 0) return null;
  const Icon = loading ? Loader2 : Sparkles;
  return (
    <div className="mz-queue" aria-live="polite">
      <span>{loading ? "Loading" : "Runs on send"}</span>
      {names.map((n) => (
        <span key={n} className="mz-queue-chip">
          <Icon size={11} className={loading ? "animate-spin" : undefined} />
          {n}
        </span>
      ))}
    </div>
  );
}
