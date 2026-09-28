import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useApp } from "@/store/app";
import type { ContextPin } from "@/lib/types";
import * as api from "@/lib/tauri";
import { reportError } from "@/lib/reportError";

type Method = "smart" | "summary";

/**
 * Compaction, beside the meter it acts on (0.18.1). Both ways of shrinking what
 * the model re-reads — a free rule-based trim, or a summary written by the
 * chat's own model — plus the chat's rolling-context limit. Neither touches
 * what is on screen. It lived in a popover under the composer, where it was a
 * fifth icon in the prompt's toolbar and invisible from the context readout.
 */
export function CompactControls({ chatId }: { chatId: string }) {
  const [busy, setBusy] = useState<Method | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pins, setPins] = useState<ContextPin[]>([]);
  const own = useApp((s) => s.chats.find((c) => c.id === chatId)?.rollingContextTokens ?? null);
  const fallback = useApp((s) => s.appSettings.rollingContextTokens);
  const limit = own ?? fallback;

  useEffect(() => {
    api.listContextPins(chatId).then(setPins).catch(reportError("Couldn't load the notes"));
  }, [chatId]);

  function setLimit(tokens: number | null) {
    api.setChatRollingContext(chatId, tokens).catch(reportError("Couldn't change rolling context"));
  }

  function unpin(id: string) {
    api
      .deleteContextPin(chatId, id)
      .then(() => setPins((p) => p.filter((x) => x.id !== id)))
      .catch(reportError("Couldn't remove the note"));
  }

  async function run(method: Method) {
    setBusy(method);
    setResult(null);
    try {
      const r = await api.compactChat(chatId, method);
      setResult(
        r.messages === 0
          ? "Nothing old enough to compact yet."
          : method === "smart"
            ? `Trimmed ${r.messages} earlier messages.`
            : `Summarized ${r.messages} earlier messages.`,
      );
    } catch (e) {
      reportError("Couldn't compact the chat")(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex gap-1.5">
        <Option
          title="Smart compact"
          body="Free. Trims old tool output."
          busy={busy === "smart"}
          disabled={busy !== null}
          onClick={() => run("smart")}
        />
        <Option
          title="Summarize"
          body="The model rewrites older turns."
          busy={busy === "summary"}
          disabled={busy !== null}
          onClick={() => run("summary")}
        />
      </div>
      {result && <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{result}</p>}

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[var(--color-text-muted)]" title="Past the limit the oldest messages are forgotten, except what the model marks important.">
          Rolling limit
        </span>
        <select
          value={own === null ? "default" : own === 0 ? "off" : "custom"}
          onChange={(e) => {
            const v = e.target.value;
            setLimit(v === "default" ? null : v === "off" ? 0 : limit > 0 ? limit : 32000);
          }}
          className="ml-auto rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1.5 py-0.5"
        >
          <option value="default">Default ({fallback > 0 ? `${fallback.toLocaleString()}` : "off"})</option>
          <option value="off">Off</option>
          <option value="custom">Custom</option>
        </select>
        {own !== null && own > 0 && (
          <input
            type="number"
            min={1000}
            step={4000}
            defaultValue={own}
            onBlur={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n > 0 && n !== own) setLimit(n);
            }}
            className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1.5 py-0.5"
          />
        )}
      </div>
      {pins.length > 0 && (
        <div className="mt-2">
          <div className="mb-0.5 text-[10px] text-[var(--color-text-muted)]">Marked important</div>
          <ul className="max-h-40 overflow-auto">
            {pins.map((p) => (
              <li key={p.id} className="group flex items-start gap-1 py-0.5 text-[11px]">
                <span className="flex-1">{p.note}{p.messageId ? " (with a tool result)" : ""}</span>
                <button onClick={() => unpin(p.id)} title="Remove this note" className="opacity-50 hover:opacity-100">
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Option({ title, body, busy, disabled, onClick }: {
  title: string; body: string; busy: boolean; disabled: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-left hover:border-[var(--color-accent)] disabled:opacity-50"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {busy && <Loader2 size={11} className="animate-spin" />}
        {title}
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{body}</div>
    </button>
  );
}
