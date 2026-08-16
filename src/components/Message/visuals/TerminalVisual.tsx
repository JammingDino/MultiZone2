import { Shaped } from "./Shaped";

/**
 * Family 5 — what ran, what it printed, and how it ended (0.13.0).
 *
 * The exit code is the thing a reader looks for first and it was previously
 * three lines into a JSON blob. stderr is tinted rather than merged, because
 * "it printed a warning and succeeded" and "it failed" are different outcomes
 * that read identically in a single stream. Output is tail-anchored: the end of
 * a long run is the part that matters.
 */

const MAX_LINES = 200;

export function TerminalVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  const command =
    (typeof args?.command === "string" && args.command) ||
    (typeof args?.input === "string" && args.input) ||
    (typeof args?.code === "string" && args.code) ||
    "";
  const language = typeof args?.language === "string" ? args.language : null;
  const shell = typeof args?.shell === "string" && args.shell !== "auto" ? args.shell : null;
  const distro = typeof args?.distro === "string" ? args.distro : null;

  const stdout = str(result.stdout);
  const stderr = str(result.stderr);
  const exit = typeof result.exit_code === "number" ? result.exit_code : null;

  // Nothing terminal-shaped came back (terminal_list, for instance) — shape the
  // result rather than showing an empty console.
  if (!command && !stdout && !stderr && exit === null) {
    return <Shaped value={result} />;
  }

  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-[11px]">
        <span className="text-[var(--color-text-muted)]">
          {language ?? shell ?? distro ?? name.replace(/_/g, " ")}
        </span>
        {exit !== null && (
          <span
            className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
              exit === 0
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
            }`}
          >
            exit {exit}
          </span>
        )}
      </div>
      <div className="max-h-[320px] overflow-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed">
        {command && (
          <div className="flex gap-1.5">
            <span className="select-none text-[var(--color-accent)]">$</span>
            <pre className="whitespace-pre-wrap break-words text-[var(--color-text)]">{command}</pre>
          </div>
        )}
        <Stream text={stdout} />
        <Stream text={stderr} tone="text-[var(--color-danger)]" />
        {!stdout && !stderr && (
          <div className="text-[var(--color-text-muted)]">(no output)</div>
        )}
      </div>
    </div>
  );
}

function Stream({ text, tone }: { text: string; tone?: string }) {
  if (!text) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const clipped = lines.length > MAX_LINES;
  const shown = clipped ? lines.slice(lines.length - MAX_LINES) : lines;
  return (
    <>
      {clipped && (
        <div className="text-[10px] text-[var(--color-text-muted)]">
          … first {lines.length - MAX_LINES} lines hidden — full output on the Output tab
        </div>
      )}
      <pre
        className={`whitespace-pre-wrap break-words ${tone ?? "text-[var(--color-text-muted)]"}`}
      >
        {stripAnsi(shown.join("\n"))}
      </pre>
    </>
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Escape sequences are noise here — rendering them as colour is a later item,
 * but showing them as `[0;32m` never was.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}
