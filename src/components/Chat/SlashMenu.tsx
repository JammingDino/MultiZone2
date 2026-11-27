import { useEffect, useMemo, useState } from "react";
import { Terminal, FileText, Loader2, Sparkles, ClipboardList, Play } from "lucide-react";
import { useSkillCommands } from "./PromptHighlight";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import type { McpPrompt, McpResource, SavedRun } from "@/lib/types";
import { reportError } from "@/lib/reportError";

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
  | { kind: "builtin"; name: string; description: string }
  | { kind: "skill"; name: string; description: string }
  | { kind: "prompt"; serverId: string; serverName: string; prompt: McpPrompt }
  | { kind: "resource"; serverId: string; serverName: string; resource: McpResource }
  | { kind: "run"; run: SavedRun };

function entryKey(e: Entry): string {
  if (e.kind === "builtin") return `b:${e.name}`;
  if (e.kind === "skill") return `s:${e.name}`;
  if (e.kind === "run") return `run:${e.run.id}`;
  return e.kind === "prompt"
    ? `p:${e.serverId}:${e.prompt.name}`
    : `r:${e.serverId}:${e.resource.uri}`;
}

function entryLabel(e: Entry): string {
  if (e.kind === "builtin" || e.kind === "skill") return e.name;
  if (e.kind === "run") return e.run.name;
  return e.kind === "prompt" ? e.prompt.name : e.resource.name;
}

function entryDetail(e: Entry): string | null {
  if (e.kind === "builtin" || e.kind === "skill") return e.description || null;
  if (e.kind === "run") return e.run.description;
  return e.kind === "prompt" ? e.prompt.description : e.resource.description;
}

export function SlashMenu({
  query,
  onPick,
  onClose,
  builtins = [],
}: {
  query: string;
  onPick: (text: string) => void;
  onClose: () => void;
  /** The app's own commands (`/plan`), listed before the skills. */
  builtins?: { name: string; description: string }[];
}) {
  const servers = useApp((s) => s.mcpServers);
  const editorial = useApp((s) => s.theme.messageStyle === "editorial");
  // Skills first (0.20.1): picking one puts `/name` in the prompt, and it runs
  // when the message is sent. MCP prompts and resources expand where they are.
  const skills = useSkillCommands().list;
  const savedRuns = useApp((s) => s.savedRuns);
  const refreshSavedRuns = useApp((s) => s.refreshSavedRuns);
  useEffect(() => void refreshSavedRuns(), [refreshSavedRuns]);
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
    const all: Entry[] = [
      ...builtins.map((b): Entry => ({ kind: "builtin", ...b })),
      // A skill that shares a built-in's name is shadowed by it.
      ...skills
        .filter((k) => !builtins.some((b) => b.name === k.name.toLowerCase()))
        .map((k): Entry => ({ kind: "skill", name: k.name, description: k.description })),
      // Saved runs (0.20.1) expand like MCP prompts: the filled-in template,
      // with its defaults, visible in the composer before it is sent.
      ...savedRuns.map((run): Entry => ({ kind: "run", run })),
      ...(entries ?? []),
    ];
    const q = query.toLowerCase();
    if (!q) return all.slice(0, 30);
    return all
      .filter((e) => {
        const hay = `${entryLabel(e)} ${entryDetail(e) ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 30);
  }, [entries, skills, savedRuns, query, builtins]);

  useEffect(() => setCursor(0), [query]);

  async function choose(e: Entry) {
    if (e.kind === "builtin" || e.kind === "skill") {
      onPick(`/${e.name} `);
      return;
    }
    try {
      const text =
        e.kind === "run"
          ? (await api.renderSavedRun(e.run.id)).prompt
          : e.kind === "prompt"
          ? await api.getMcpPrompt(e.serverId, e.prompt.name)
          : await api.readMcpResource(e.serverId, e.resource.uri);
      onPick(text);
    } catch (err) {
      reportError(e.kind === "run" ? "Couldn't fill in that saved run" : "Couldn't fetch that from the MCP server")(err);
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

  if (results.length === 0 && (!busy || skills.length > 0)) return null;

  const asking = busy && entries === null && results.length === 0 && (
    <p className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-muted)]">
      <Loader2 size={12} className="animate-spin" /> Asking your MCP servers…
    </p>
  );
  const kindOf = (e: Entry) =>
    e.kind === "builtin" ? "command" : e.kind === "skill" ? "skill" : e.kind === "run" ? "saved run" : e.serverName;
  // Built-ins and skills go in as `/name`; MCP entries expand where they are.
  const slashed = (e: Entry) => e.kind === "builtin" || e.kind === "skill";
  const row = (e: Entry, i: number, className: string, children: React.ReactNode) => (
    <button
      key={entryKey(e)}
      onMouseMove={() => setCursor(i)}
      onClick={() => void choose(e)}
      data-selected={i === cursor || undefined}
      className={className}
    >
      {children}
    </button>
  );

  // Editorial (0.21.0): a command palette — the query and its match count on
  // top, mono rows with the match marked, and the keys in a footer.
  if (editorial) {
    return (
      <div className="mz-palette absolute bottom-full left-0 z-50 mb-2 flex max-h-72 w-full max-w-md flex-col">
        <div className="mz-palette-q">
          /{query}
          <span>{results.length} {results.length === 1 ? "match" : "matches"}</span>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {asking || results.map((e, i) => row(e, i, "mz-palette-row", (
            <>
              <span className="car" aria-hidden>›</span>
              <span className="nm"><Marked text={entryLabel(e)} query={query} /></span>
              <span className="ds">{entryDetail(e)}</span>
              <span className="kind">{kindOf(e)}</span>
            </>
          )))}
        </div>
        <div className="mz-palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd>move</span>
          <span><kbd>tab</kbd>complete</span>
          <span><kbd>esc</kbd>close</span>
        </div>
      </div>
    );
  }

  // Bubble: the selected row takes the message bubble's gradient.
  return (
    <div className="mz-slash absolute bottom-full left-0 z-50 mb-2 max-h-64 w-full max-w-md overflow-y-auto">
      {asking || results.map((e, i) => row(e, i, "mz-slash-row", (
        <>
          {e.kind === "builtin" ? <ClipboardList size={13} /> : e.kind === "skill" ? <Sparkles size={13} /> : e.kind === "run" ? <Play size={13} /> : e.kind === "prompt" ? <Terminal size={13} /> : <FileText size={13} />}
          <span className="nm">{slashed(e) ? "/" : ""}{entryLabel(e)}</span>
          <span className="ds">{entryDetail(e)}</span>
          {!slashed(e) && <span className="src">{kindOf(e)}</span>}
          {i === cursor && <kbd className="enter" aria-hidden>↵</kbd>}
        </>
      )))}
    </div>
  );
}

/** The label with the first case-insensitive match of the query marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}
