import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Square, TerminalSquare, X } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import type { TerminalInfo } from "@/lib/types";
import { usePersistentBool } from "@/lib/uiState";

/**
 * The chat's terminals, first-hand (0.17.9).
 *
 * `terminal_start` gave the agent processes that outlive a tool call — a dev
 * server, a REPL, a build to follow. Until now the user saw them only through
 * whatever the model chose to quote from `terminal_read`, and could not touch
 * them at all: a program waiting on a prompt the model had not noticed just
 * sat there. This is the same set of terminals (the session's — the agent's
 * view and this one can never disagree), followed live, with an input line.
 *
 * Output is *followed*, not polled: each read carries the last cursor and the
 * backend holds it until something new arrives or the process exits, so the
 * panel is idle while the process is. The `\r` redraws a progress bar makes are
 * resolved here over the whole transcript rather than per chunk, which is why
 * the backend leaves them in.
 *
 * Renders nothing when the chat has no terminals, which is nearly always.
 */
export function TerminalPanel({ chatId }: { chatId: string }) {
  const [terms, setTerms] = useState<TerminalInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = usePersistentBool("terminalPanel.collapsed", false);
  const [starting, setStarting] = useState(false);
  const [startCmd, setStartCmd] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listTerminals(chatId);
      setTerms(list);
      setSelected((cur) => {
        if (cur && list.some((t) => t.id === cur)) return cur;
        // Prefer whatever is still running; the newest of those.
        const live = list.filter((t) => t.running);
        const pick = (live.length ? live : list).at(-1);
        return pick?.id ?? null;
      });
    } catch (e) {
      console.warn("terminal list failed", e);
    }
  }, [chatId]);

  // Refresh when the agent's terminal_* tool finishes — the cheapest signal
  // that the set changed — and on a slow timer for exits nobody asked about.
  const runningTool = useApp((s) => s.streamingByChat[chatId]?.runningTool ?? null);
  const lastToolRef = useRef<string | null>(null);
  useEffect(() => {
    const was = lastToolRef.current;
    lastToolRef.current = runningTool;
    if (was?.startsWith("terminal_") && runningTool === null) void refresh();
  }, [runningTool, refresh]);
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const start = async () => {
    setError(null);
    try {
      const t = await api.startTerminal(chatId, { command: startCmd.trim() || null });
      setStartCmd("");
      setStarting(false);
      await refresh();
      setSelected(t.id);
      setCollapsed(false);
    } catch (e) {
      setError(String(e));
    }
  };

  const stop = async (id: string) => {
    setError(null);
    try {
      await api.stopTerminal(chatId, id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  if (terms.length === 0 && !starting) return null;
  const current = terms.find((t) => t.id === selected) ?? null;
  const live = terms.filter((t) => t.running).length;

  return (
    <div className="max-h-[40vh] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] flex flex-col">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          aria-label={collapsed ? "Show terminals" : "Hide terminals"}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <TerminalSquare size={12} className="text-[var(--color-text-muted)]" />
        <span className="font-medium text-[var(--color-text)]">Terminals</span>
        <span className="text-[var(--color-text-muted)]">
          {live} running{terms.length > live ? ` · ${terms.length - live} exited` : ""}
        </span>
        <div className="ml-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {terms.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setSelected(t.id);
                setCollapsed(false);
              }}
              title={t.command ?? t.shell}
              className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 ${
                t.id === selected
                  ? "border-[var(--color-accent)] text-[var(--color-text)]"
                  : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  t.running ? "bg-emerald-500" : t.exitCode === 0 ? "bg-[var(--color-text-muted)]" : "bg-red-500"
                }`}
              />
              <span className="max-w-[10rem] truncate">{t.name}</span>
              <span className="opacity-60">{t.id}</span>
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setStarting((v) => !v);
            setCollapsed(false);
          }}
          title="Open a terminal in this chat — the agent can see and use it too"
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          <Plus size={10} /> New
        </button>
      </div>

      {!collapsed && starting && (
        <form
          className="flex items-center gap-1 border-t border-[var(--color-border)] px-2.5 py-1.5 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <input
            autoFocus
            value={startCmd}
            onChange={(e) => setStartCmd(e.target.value)}
            placeholder="Command to run (empty for a bare shell)"
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <button type="submit" className="rounded border border-[var(--color-border)] px-2 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            Start
          </button>
          <button
            type="button"
            onClick={() => setStarting(false)}
            className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label="Cancel"
          >
            <X size={12} />
          </button>
        </form>
      )}

      {error && (
        <div className="border-t border-[var(--color-border)] px-2.5 py-1 text-xs text-red-500">{error}</div>
      )}

      {!collapsed && current && (
        <TerminalView key={current.id} chatId={chatId} term={current} onStop={() => stop(current.id)} onChanged={refresh} />
      )}
    </div>
  );
}

/** Resolve `\r` the way a screen would: only what follows the last one on a line survives. */
function resolveRedraws(s: string): string {
  if (!s.includes("\r")) return s;
  return s
    .split("\n")
    .map((line) => line.split("\r").reverse().find((seg) => seg !== "") ?? "")
    .join("\n");
}

/** Keep the transcript bounded in the DOM; the backend window is 200k chars. */
const MAX_VIEW_CHARS = 200_000;

function TerminalView({
  chatId,
  term,
  onStop,
  onChanged,
}: {
  chatId: string;
  term: TerminalInfo;
  onStop: () => void;
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [running, setRunning] = useState(term.running);
  const [exitCode, setExitCode] = useState<number | null>(term.exitCode);
  const [input, setInput] = useState("");
  const [gap, setGap] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  // Follow loop: one read with no cursor for the backlog, then long-polls with
  // the returned cursor until the process exits or the view goes away.
  useEffect(() => {
    let alive = true;
    let cursor: number | null = null;
    (async () => {
      while (alive) {
        try {
          const r = await api.readTerminal(chatId, term.id, cursor, 20_000);
          if (!alive) return;
          cursor = r.cursor;
          if (r.output) {
            setText((prev) => {
              const next = prev + r.output;
              return next.length > MAX_VIEW_CHARS ? next.slice(next.length - MAX_VIEW_CHARS) : next;
            });
          }
          if (r.gap) setGap(true);
          setRunning(r.running);
          setExitCode(r.exitCode);
          if (!r.running) {
            onChanged();
            return;
          }
        } catch (e) {
          // The terminal was stopped (by the agent, or the Stop button) — the
          // list refresh will drop it; nothing to follow any more.
          console.warn("terminal follow ended", e);
          if (alive) onChanged();
          return;
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, term.id]);

  const shown = useMemo(() => resolveRedraws(text), [text]);

  // Stick to the bottom unless the user has scrolled up to read.
  useEffect(() => {
    const el = preRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const send = async () => {
    const body = input;
    setInput("");
    try {
      await api.writeTerminal(chatId, term.id, body, true);
    } catch (e) {
      setText((prev) => `${prev}\n[input failed: ${String(e)}]\n`);
    }
  };

  return (
    <div className="flex min-h-0 flex-col border-t border-[var(--color-border)]">
      <div className="flex items-center gap-2 px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]">
        <span className="truncate font-mono">{term.command ?? `${term.shell} (interactive)`}</span>
        {term.cwd && <span className="truncate opacity-70">in {term.cwd}</span>}
        <span className="ml-auto shrink-0">
          {running ? "running" : `exited${exitCode !== null ? ` (${exitCode})` : ""}`}
        </span>
        <button
          onClick={onStop}
          title={running ? "Kill the process and everything it started" : "Remove this terminal"}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          {running ? <Square size={8} /> : <X size={8} />}
          {running ? "Stop" : "Close"}
        </button>
      </div>
      <pre
        ref={preRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-[6rem] flex-1 overflow-auto whitespace-pre-wrap break-words bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[11px] leading-snug text-[var(--color-text)]"
      >
        {gap && <span className="opacity-60">[earlier output scrolled out of the buffer]{"\n"}</span>}
        {shown || (running ? <span className="opacity-50">(no output yet)</span> : "")}
      </pre>
      <form
        className="flex items-center gap-1 border-t border-[var(--color-border)] px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span className="font-mono text-xs text-[var(--color-text-muted)]">›</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!running}
          placeholder={running ? "Type into the terminal and press Enter" : "Process has exited"}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] disabled:opacity-50"
        />
      </form>
    </div>
  );
}
