import { useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Shaped } from "./Shaped";

/**
 * Family 8 — an HTTP exchange (0.13.3).
 *
 * The status code is the answer to "did this work", and it was three lines into
 * a JSON blob next to a body that may itself be JSON escaped inside a string.
 * The pill carries the outcome; the body is shaped rather than escaped; and the
 * response headers fold away because they are rarely what you came for and
 * always long.
 *
 * `app_control` speaks the same shape against the app's own API, so it shares
 * this family.
 */

export function HttpVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  const status = typeof result.status === "number" ? result.status : null;
  if (status === null && !result.body && !result.json) return <Shaped value={result} />;

  const method = (str(args?.method) || "GET").toUpperCase();
  const target = str(args?.url) || str(args?.path) || str(result.url);
  const body = result.json ?? result.body ?? null;
  const headers = result.headers ?? null;

  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-[11px]">
        <ArrowLeftRight size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="shrink-0 font-mono font-medium text-[var(--color-text-muted)]">
          {method}
        </span>
        <span className="min-w-0 truncate font-mono text-[var(--color-text)]" title={target}>
          {target || (name === "app_control" ? "app API" : "")}
        </span>
        {status !== null && <StatusPill status={status} text={str(result.status_text)} />}
      </div>

      {headers != null && <Fold label="Response headers" value={headers} />}

      {body != null && (
        <div className="max-h-[280px] overflow-auto px-2 py-1.5">
          <Shaped value={body} />
        </div>
      )}

      {result.truncated === true && (
        <div className="border-t border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          Body truncated — full response on the Output tab.
        </div>
      )}
    </div>
  );
}

/**
 * 2xx is green, 4xx and 5xx are red, and a 3xx is neither — a redirect that was
 * not followed is a fact rather than a failure.
 */
function StatusPill({ status, text }: { status: number; text: string }) {
  const tone =
    status >= 200 && status < 300
      ? "bg-emerald-500/10 text-emerald-400"
      : status >= 400
        ? "bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
        : "bg-amber-500/10 text-amber-400";
  return (
    <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums ${tone}`}>
      {status}
      {text ? ` ${text}` : ""}
    </span>
  );
}

function Fold({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-[var(--color-border)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2 py-1 text-left text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        {open ? "▾" : "▸"} {label}
      </button>
      {open && (
        <div className="max-h-[160px] overflow-auto px-2 pb-1.5 text-[11px]">
          <Shaped value={value} depth={1} />
        </div>
      )}
    </div>
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
