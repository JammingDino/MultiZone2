import { useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronRight, Copy, FileJson } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { Modal } from "@/components/common/Modal";
import { formatTokens } from "@/lib/format";
import {
  isLean, isOn, leanSwitches, readSwitches, SECTION_SWITCHES, sectionWarning, writeSwitches,
  type FirstRequest, type Switches,
} from "@/lib/promptSections";

/**
 * The first request (0.21.0): what a zone or chat would send next, built by
 * the same code the send uses (`first_request`, a dry run) and never sent.
 */

type Target = { chatId?: string | null; zoneId?: string | null; draft?: unknown };

/** The dry run for `target`, re-run (debounced) whenever it changes. */
function useFirstRequest(target: Target | null) {
  const [data, setData] = useState<FirstRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = target ? JSON.stringify(target) : "";
  useEffect(() => {
    if (!target) return;
    let live = true;
    const timer = setTimeout(() => {
      api.firstRequest(target)
        .then((r) => { if (live) { setData(r); setError(null); } })
        .catch((e) => { if (live) setError(String(e?.message ?? e)); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data, error };
}

export function FirstRequestViewer({ target, onClose }: { target: Target; onClose: () => void }) {
  const { data, error } = useFirstRequest(target);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!data) return;
    await navigator.clipboard.writeText(data.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal onClose={onClose} header={<span className="text-sm font-medium">First request{data ? ` · ${data.zoneName}` : ""}</span>}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-xs">
        {error && <p className="text-[var(--color-danger)]">{error}</p>}
        {!data && !error && <p className="text-[var(--color-text-muted)]">Building…</p>}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-mono">{data.model}</span>
              <span className="text-[var(--color-text-muted)]">{data.providerName} · {data.endpoint}</span>
              <span className="ml-auto font-mono">
                {formatTokens(data.totalTokens)} tokens
                <span className="text-[var(--color-text-muted)]">
                  {" "}= {formatTokens(data.systemTokens)} prompt + {formatTokens(data.toolsTokens)} tools
                  {data.historyTokens > 0 && ` + ${formatTokens(data.historyTokens)} history`}
                </span>
              </span>
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Built the way a send builds it, and not sent. Your next message goes after {data.messageCount === 1 ? "the system message" : `these ${data.messageCount} messages`}. No API key is in the body; keys travel in a header.
            </p>

            <div>
              <h4 className="mb-1 font-medium">System prompt · {data.sections.length} section{data.sections.length === 1 ? "" : "s"}</h4>
              {data.sections.map((s, i) => {
                const k = `${s.id}-${i}`;
                return (
                  <div key={k} className="border-b border-[var(--color-border)] last:border-0">
                    <button
                      type="button"
                      onClick={() => setOpen((o) => ({ ...o, [k]: !o[k] }))}
                      className="flex w-full items-center gap-2 py-1 text-left hover:bg-[var(--color-panel-hover)]"
                    >
                      <ChevronRight size={12} className={`transition-transform ${open[k] ? "rotate-90" : ""}`} />
                      <span>{s.title}</span>
                      <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{s.id}</span>
                      <span className="ml-auto font-mono">{formatTokens(s.tokens)}</span>
                    </button>
                    {open[k] && (
                      <pre className="mb-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-panel-hover)] p-2 font-mono text-[11px]">{s.text}</pre>
                    )}
                  </div>
                );
              })}
              {data.off.length > 0 && (
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  Switched off: {data.off.map((id) => SECTION_SWITCHES.find((s) => s.id === id)?.label ?? id).join(", ")}
                </p>
              )}
            </div>

            <div>
              <h4 className="mb-1 font-medium">Tools · {data.tools.length}</h4>
              {data.tools.length === 0 && <p className="text-[var(--color-text-muted)]">None — the request carries no tool list.</p>}
              <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                {data.tools.map((t) => (
                  <div key={t.name} className="flex items-center gap-2 py-0.5">
                    <span className="truncate font-mono">{t.name}</span>
                    <span className="truncate text-[10px] text-[var(--color-text-muted)]">{t.group}</span>
                    <span className="ml-auto font-mono">{formatTokens(t.tokens)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button type="button" onClick={copy} className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)]">
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy request JSON"}
              </button>
              <button type="button" onClick={() => setShowJson((v) => !v)} className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                <FileJson size={12} /> {showJson ? "Hide JSON" : "Show JSON"}
              </button>
              <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">{formatTokens(data.body.length)} characters</span>
            </div>
            {showJson && (
              <pre className="max-h-96 overflow-auto whitespace-pre rounded bg-[var(--color-panel-hover)] p-2 font-mono text-[11px]">{data.body}</pre>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** "First request…" for a chat: the Context panel's way in. */
export function FirstRequestButton({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] text-[var(--color-text-muted)] underline hover:text-[var(--color-accent)]"
      >
        View the exact request…
      </button>
      {open && <FirstRequestViewer target={{ chatId }} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The zone editor's prompt sections: the size of the first request, the
 * lean preset with its before and after, and a switch per section.
 */
export function PromptSections({
  tools, toolConfig, setToolConfig, draft,
}: {
  tools: string[];
  toolConfig: string;
  setToolConfig: (f: (tc: string) => string) => void;
  /** The editor's unsaved zone, in `upsert_zone`'s shape. */
  draft: { toolConfig: string } & Record<string, unknown>;
}) {
  const app = useApp((s) => s.appSettings.promptSections) ?? {};
  const zone = readSwitches(toolConfig);
  const lean = isLean(zone, app, tools);
  const leanDraft = { ...draft, toolConfig: writeSwitches(draft.toolConfig, leanSwitches(tools)) };
  const now = useFirstRequest({ draft }).data;
  // The other side of the comparison: lean when it is not, the defaults when it is.
  const other = useFirstRequest({ draft: lean ? { ...draft, toolConfig: writeSwitches(draft.toolConfig, {}) } : leanDraft }).data;
  const [listOpen, setListOpen] = useState(false);
  const [viewing, setViewing] = useState(false);

  const set = (next: Switches) => setToolConfig((tc) => writeSwitches(tc, next));
  const sizeOf = (id: string) =>
    id === "tool_descriptions"
      ? now?.toolsTokens
      : now?.sections.filter((s) => s.id === id).reduce((n, s) => n + s.tokens, 0) || undefined;
  const warnings = SECTION_SWITCHES.filter((s) => !isOn(s.id, zone, app) && sectionWarning(s.id, tools));

  return (
    <div className="mb-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setListOpen((v) => !v)} className="flex items-center gap-1 font-medium">
          <ChevronRight size={12} className={`transition-transform ${listOpen ? "rotate-90" : ""}`} />
          First request
        </button>
        <span className="font-mono text-[var(--color-text-muted)]">
          {now ? `${formatTokens(now.totalTokens)} tokens · ${formatTokens(now.systemTokens)} prompt + ${formatTokens(now.toolsTokens)} tools` : "…"}
        </span>
        <button
          type="button"
          onClick={() => set(lean ? {} : leanSwitches(tools))}
          title="For small local models: only the sections these tools need, and one-sentence tool descriptions"
          className={`ml-auto rounded border px-2 py-0.5 ${lean ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]" : "border-[var(--color-border)] hover:border-[var(--color-accent)]"}`}
        >
          {lean ? "Lean ✓" : "Lean"}
          {now && other && (
            <span className="ml-1 font-mono text-[10px] text-[var(--color-text-muted)]">
              {lean
                ? `${formatTokens(other.totalTokens)} → ${formatTokens(now.totalTokens)}`
                : `${formatTokens(now.totalTokens)} → ${formatTokens(other.totalTokens)}`}
            </span>
          )}
        </button>
        <button type="button" onClick={() => setViewing(true)} className="text-[var(--color-text-muted)] underline hover:text-[var(--color-accent)]">
          View
        </button>
      </div>
      {!listOpen && warnings.length > 0 && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-[#f59e0b]">
          <AlertTriangle size={11} /> {warnings.map((w) => w.label).join(", ")} off — see sections.
        </p>
      )}
      {listOpen && (
        <div className="mt-1.5 flex flex-col">
          {SECTION_SWITCHES.map((s) => {
            const on = isOn(s.id, zone, app);
            const warn = !on ? sectionWarning(s.id, tools) : null;
            const size = sizeOf(s.id);
            return (
              <label key={s.id} className="flex cursor-pointer flex-col py-0.5 hover:bg-[var(--color-panel-hover)]">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => set({ ...zone, [s.id]: e.target.checked })}
                  />
                  <span>{s.label}</span>
                  {zone[s.id] === undefined && app[s.id] === false && (
                    <span className="text-[10px] text-[var(--color-text-muted)]">off app-wide</span>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-[var(--color-text-muted)]">
                    {on && size ? formatTokens(size) : on ? "not sent here" : "off"}
                  </span>
                </span>
                {warn && (
                  <span className="ml-5 flex items-center gap-1 text-[11px] text-[#f59e0b]">
                    <AlertTriangle size={11} /> {warn}
                  </span>
                )}
              </label>
            );
          })}
          <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            The zone's own prompt and plan mode are always sent. "Not sent here" means this zone or chat has nothing for that section.
            {Object.keys(zone).length > 0 && (
              <>
                {" "}
                <button type="button" onClick={() => set({})} className="underline hover:text-[var(--color-accent)]">
                  Use the app-wide defaults
                </button>
              </>
            )}
          </p>
        </div>
      )}
      {viewing && <FirstRequestViewer target={{ draft }} onClose={() => setViewing(false)} />}
    </div>
  );
}

/** Settings → Chat: the app-wide default for every switch. */
export function PromptSectionDefaults() {
  const app = useApp((s) => s.appSettings.promptSections) ?? {};
  const setAppSettings = useApp((s) => s.setAppSettings);
  function set(id: string, on: boolean) {
    const next = { ...app };
    // Only "off" is stored, so a section added later is on by default.
    if (on) delete next[id];
    else next[id] = false;
    void setAppSettings({ promptSections: next });
  }
  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">System prompt sections</h3>
      <p className="mb-2 text-xs text-[var(--color-text-muted)]">
        What every zone's system prompt may include. A zone can override each one in its editor (Tools → First request), where sizes are shown.
      </p>
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        {SECTION_SWITCHES.map((s) => (
          <label key={s.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-xs">
            <input type="checkbox" checked={app[s.id] !== false} onChange={(e) => set(s.id, e.target.checked)} />
            {s.label}
          </label>
        ))}
      </div>
    </section>
  );
}
