import { useEffect, useRef, useState } from "react";
import { FoldVertical, Loader2, X } from "lucide-react";
import { useApp } from "@/store/app";
import type { ContextPin } from "@/lib/types";
import { Popover } from "@/components/common/Popover";
import * as api from "@/lib/tauri";
import { reportError } from "@/lib/reportError";
import { CHROME_ACTIVE, CHROME_QUIET } from "@/lib/chrome";

type Method = "smart" | "summary";

/**
 * The composer's compaction button (0.18): both ways of shrinking what the
 * model re-reads, on the user's say-so. Smart compaction is a rule-based
 * rewrite and costs nothing; a summary is one full-context request to the
 * chat's own model. Neither touches what is on screen.
 */
export function CompactMenu({ chatId, disabled }: { chatId: string; disabled?: boolean }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Method | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pins, setPins] = useState<ContextPin[]>([]);
  const own = useApp((s) => s.chats.find((c) => c.id === chatId)?.rollingContextTokens ?? null);
  const fallback = useApp((s) => s.appSettings.rollingContextTokens);
  const limit = own ?? fallback;

  useEffect(() => {
    if (open) api.listContextPins(chatId).then(setPins).catch(reportError("Couldn't load the notes"));
  }, [open, chatId]);

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
      <button
        ref={btnRef}
        onClick={() => { setOpen((v) => !v); setResult(null); }}
        disabled={disabled}
        title="Compact this chat's context"
        className={`rounded p-1.5 disabled:opacity-40 ${open ? CHROME_ACTIVE : CHROME_QUIET}`}
      >
        <FoldVertical size={16} />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={btnRef}
        side="top"
        zIndex={30}
        className="w-80 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-lg"
      >
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Compact context
        </div>
        <Option
          title="Smart compact"
          body="Free and instant. Trims old tool output, drops results of calls repeated later, hides long tool inputs and strips old thinking."
          busy={busy === "smart"}
          disabled={busy !== null}
          onClick={() => run("smart")}
        />
        <Option
          title="Summarize"
          body="The chat's model writes a summary that replaces the earlier turns. Uses one request the size of the whole chat."
          busy={busy === "summary"}
          disabled={busy !== null}
          onClick={() => run("summary")}
        />
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
          {result ?? "Only what the model re-reads changes — the whole conversation stays on screen."}
        </p>

        <div className="mt-3 border-t border-[var(--color-border)] pt-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Rolling context
          </div>
          <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">
            Past the limit the oldest messages are forgotten, except what the model marks important.
          </p>
          <div className="flex items-center gap-2 text-xs">
            <select
              value={own === null ? "default" : own === 0 ? "off" : "custom"}
              onChange={(e) => {
                const v = e.target.value;
                setLimit(v === "default" ? null : v === "off" ? 0 : limit > 0 ? limit : 32000);
              }}
              className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1.5 py-1"
            >
              <option value="default">Default ({fallback > 0 ? `${fallback.toLocaleString()} tokens` : "off"})</option>
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
                className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1.5 py-1"
              />
            )}
          </div>
          {pins.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">Marked important</div>
              <ul className="max-h-40 overflow-auto">
                {pins.map((p) => (
                  <li key={p.id} className="group flex items-start gap-1 py-0.5 text-[11px]">
                    <span className="flex-1">{p.note}{p.messageId ? " (with a tool result)" : ""}</span>
                    <button
                      onClick={() => unpin(p.id)}
                      title="Remove this note"
                      className="opacity-50 hover:opacity-100"
                    >
                      <X size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Popover>
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
      className="mb-1.5 w-full rounded border border-[var(--color-border)] px-2.5 py-2 text-left hover:border-[var(--color-accent)] disabled:opacity-50"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {busy && <Loader2 size={11} className="animate-spin" />}
        {title}
      </div>
      <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{body}</div>
    </button>
  );
}
