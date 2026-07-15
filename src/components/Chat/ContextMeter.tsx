import { useMemo, useState } from "react";
import { Gauge } from "lucide-react";
import { useApp } from "@/store/app";
import { formatTokens } from "@/lib/format";
import { chatContextEstimate } from "@/lib/tokens";

const EMPTY: never[] = [];

/**
 * Chat header meter showing the current context size — an estimate of the
 * total tokens the model is carrying for this conversation, across everything:
 * user turns, uploaded file text, tool responses, and the model's own answers,
 * thinking, and tool calls. Hover/click for the input vs output split.
 *
 * Estimated from character length (no exact tokenizer for arbitrary local
 * models), so it's a guide, not a billed count.
 */
export function ContextMeter({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  const messages = useApp((s) => s.messagesByChat[chatId] ?? EMPTY);
  const est = useMemo(() => chatContextEstimate(messages), [messages]);

  if (messages.length === 0) return null;

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
        title="Current context size (estimated)"
      >
        <Gauge size={12} />
        <span className="font-mono">{formatTokens(est.totalTokens)}</span>
        <span className="hidden sm:inline">ctx</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 min-w-[220px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-xs shadow-lg">
          <div className="mb-1 font-medium text-[var(--color-text)]">
            Context size (est.)
          </div>
          <MeterRow label="Input (you, files, tools)" value={est.inputTokens} />
          <MeterRow label="Output (answers, thinking, tools)" value={est.outputTokens} />
          <div className="mt-1 border-t border-[var(--color-border)] pt-1">
            <MeterRow label="Total" value={est.totalTokens} strong />
          </div>
          <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            Estimated from text length — a guide, not an exact token count.
          </div>
        </div>
      )}
    </div>
  );
}

function MeterRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span
        className={`font-mono ${strong ? "text-[var(--color-text)] font-semibold" : "text-[var(--color-text)]"}`}
      >
        {formatTokens(value)}
      </span>
    </div>
  );
}
