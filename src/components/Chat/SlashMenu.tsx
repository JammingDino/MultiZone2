import { useEffect, useMemo, useState } from "react";
import { Terminal, FileText, Loader2 } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import type { McpPrompt, McpResource } from "@/lib/types";

/**
 * MCP prompts and resources in the composer (0.15.3).
 *
 * We spoke `tools/list` and `tools/call` and nothing else, so a server offering
 * a dozen prompt templates and fifty documents offered this app none of them.
 * Two more protocol calls each buy a whole surface:
 *
 * - **Prompts are slash commands.** A server-authored prompt template is
 *   already the thing a slash command is; typing `/` lists them.
 * - **Resources are attachable context.** Picking one reads it and drops the
 *   text into the composer, *visibly* — a resource that arrived as a hidden
 *   part would be context the user is sending without being able to see it,
 *   which is the thing this app tries not to do elsewhere either.
 */

type Entry =
  | { kind: "prompt"; serverId: string; serverName: string; prompt: McpPrompt }
  | { kind: "resource"; serverId: string; serverName: string; resource: McpResource };

function entryKey(e: Entry): string {
  return e.kind === "prompt"
    ? `p:${e.serverId}:${e.prompt.name}`
    : `r:${e.serverId}:${e.resource.uri}`;
}

function entryLabel(e: Entry): string {
  return e.kind === "prompt" ? e.prompt.name : e.resource.name;
}

function entryDetail(e: Entry): string | null {
  return e.kind === "prompt" ? e.prompt.description : e.resource.description;
}

/**
 * The slash query, or null when the composer is not asking for one.
 *
 * Only a `/` in the first column counts. A path halfway through a sentence is
 * not a command, and this app's conversations are full of them.
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  // A space means the command was already chosen and this is prose now.
  return rest.includes(" ") || rest.includes("\n") ? null : rest;
}

export function SlashMenu({
  query,
  onPick,
  onClose,
}: {
  query: string;
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  const servers = useApp((s) => s.mcpServers);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);

  // Only enabled servers, and only once per open — `prompts/list` and
  // `resources/list` reach a live process, so this is not something to do on
  // every keystroke.
  const enabledIds = useMemo(
    () => servers.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name })),
    [servers],
  );

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    Promise.all(
      enabledIds.map(async ({ id, name }) => {
        const [prompts, resources] = await Promise.all([
          api.listMcpPrompts(id).catch(() => []),
          api.listMcpResources(id).catch(() => []),
        ]);
        return [
          ...prompts.map((prompt): Entry => ({ kind: "prompt", serverId: id, serverName: name, prompt })),
          ...resources.map((resource): Entry => ({ kind: "resource", serverId: id, serverName: name, resource })),
        ];
      }),
    )
      .then((lists) => {
        if (!cancelled) setEntries(lists.flat());
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabledIds]);

  const results = useMemo(() => {
    const all = entries ?? [];
    const q = query.toLowerCase();
    if (!q) return all.slice(0, 30);
    return all
      .filter((e) => {
        const hay = `${entryLabel(e)} ${entryDetail(e) ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 30);
  }, [entries, query]);

  useEffect(() => setCursor(0), [query]);

  async function choose(e: Entry) {
    try {
      const text =
        e.kind === "prompt"
          ? await api.getMcpPrompt(e.serverId, e.prompt.name)
          : await api.readMcpResource(e.serverId, e.resource.uri);
      onPick(text);
    } catch (err) {
      console.error(err);
      onClose();
    }
  }

  // Arrow keys and Enter are handled by the composer, which owns focus — it
  // calls back in through these. Exposed on the window-less element via data
  // attributes would be worse; a ref callback keeps it explicit.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (results.length === 0) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setCursor((c) => (c + 1) % results.length);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setCursor((c) => (c - 1 + results.length) % results.length);
      } else if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        void choose(results[cursor]);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
    }
    // Capture, so it wins over the composer's own Enter-to-send.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!busy && results.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-full max-w-md overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
      {busy && entries === null ? (
        <p className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={12} className="animate-spin" /> Asking your MCP servers…
        </p>
      ) : (
        results.map((e, i) => (
          <button
            key={entryKey(e)}
            onMouseMove={() => setCursor(i)}
            onClick={() => void choose(e)}
            className={`flex w-full items-start gap-2 px-3 py-1.5 text-left transition ${
              i === cursor ? "bg-[var(--color-panel-hover)]" : ""
            }`}
          >
            <span className="mt-0.5 shrink-0 text-[var(--color-text-muted)]">
              {e.kind === "prompt" ? <Terminal size={13} /> : <FileText size={13} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="truncate text-sm">{entryLabel(e)}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {e.serverName}
                </span>
              </span>
              {entryDetail(e) && (
                <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                  {entryDetail(e)}
                </span>
              )}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
