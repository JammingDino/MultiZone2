import { useEffect, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { useReported, type Reported } from "@/lib/reportError";
import { ErrorNote } from "@/components/common/ErrorNote";
import { CHROME_QUIET } from "@/lib/chrome";

/** Where `reportError` failures appear: bottom right, above modals. */
export function ErrorToasts() {
  const items = useReported((s) => s.items);
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
      {items.map((item) => <Toast key={item.id} item={item} />)}
    </div>
  );
}

function Toast({ item }: { item: Reported }) {
  const dismiss = useReported((s) => s.dismiss);
  // Gone after ten seconds, unless the pointer is on it — someone reading the
  // details should not have them pulled away mid-sentence.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => dismiss(item.id), 10_000);
    return () => clearTimeout(t);
  }, [held, item.id, dismiss]);

  return (
    <div
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      className="pointer-events-auto flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-panel)] p-3 shadow-lg"
    >
      <AlertCircle size={15} className="mt-px shrink-0 text-[var(--color-danger)]" />
      <ErrorNote error={item.error} context={item.context} className="min-w-0 flex-1 text-xs text-[var(--color-danger)]" />
      <button onClick={() => dismiss(item.id)} aria-label="Dismiss" className={`shrink-0 rounded p-0.5 ${CHROME_QUIET}`}>
        <X size={13} />
      </button>
    </div>
  );
}
