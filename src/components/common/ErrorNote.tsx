import { useState } from "react";
import { friendlyError } from "@/lib/errors";

/**
 * An error, worded for the person reading it.
 *
 * Takes whatever the catch caught — an Error, a backend string, a message the
 * component wrote itself — and shows `friendlyError`'s reading of it. When
 * that reading is not the raw text, the raw text is one click away: it is what
 * goes in a bug report. `className` is the caller's box; each panel keeps its
 * own look. `context` names what was being done ("Couldn't save the provider").
 */
export function ErrorNote({
  error,
  context,
  className = "text-xs text-[var(--color-danger)]",
}: {
  error: unknown;
  context?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (error == null || error === "") return null;

  const f = friendlyError(error);
  const headline = context ? `${context}: ${f.headline.charAt(0).toLowerCase()}${f.headline.slice(1)}` : f.headline;
  const translated = !f.raw.toLowerCase().endsWith(f.headline.toLowerCase());

  return (
    <div role="alert" className={className}>
      <span className="font-medium">{headline}</span>
      {f.hint && <span className="opacity-80"> — {f.hint}</span>}
      {translated && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-1.5 underline decoration-dotted opacity-70 hover:opacity-100"
        >
          {open ? "Hide details" : "Details"}
        </button>
      )}
      {open && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] opacity-80">
          {f.raw}
        </pre>
      )}
    </div>
  );
}
