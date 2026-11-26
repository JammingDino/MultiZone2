import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bot, Loader2, Plug } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import type { ClaudeCodeSetup } from "@/lib/types";
import { errorText } from "@/lib/errors";

type Agent = ClaudeCodeSetup["agents"][number];
type Server = ClaudeCodeSetup["mcpServers"][number];

const keysOf = (json: string | null) => {
  try { return json ? Object.keys(JSON.parse(json)) : []; } catch { return []; }
};

/**
 * Bring over what is already set up for Claude Code (0.20.0): its sub-agents as
 * zones and its MCP servers. Shows what was found first and imports only what
 * is ticked; anything whose name is already taken here is left alone.
 */
export function ClaudeImportPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const zones = useApp((s) => s.zones);
  const providers = useApp((s) => s.providers);
  const servers = useApp((s) => s.mcpServers);
  const refreshZones = useApp((s) => s.refreshZones);
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);
  const [found, setFound] = useState<ClaudeCodeSetup | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const zoneNames = useMemo(() => new Set(zones.map((z) => z.name.toLowerCase())), [zones]);
  const serverNames = useMemo(() => new Set(servers.map((s) => s.name.toLowerCase())), [servers]);
  const agentKey = (a: Agent) => `a:${a.name}`;
  const serverKey = (s: Server) => `s:${s.name}:${s.scope}`;
  const agentTaken = (a: Agent) => zoneNames.has(a.name.toLowerCase());
  const serverTaken = (s: Server) => serverNames.has(s.name.toLowerCase());

  useEffect(() => {
    api.scanClaudeCode()
      .then((f) => {
        setFound(f);
        setPicked(new Set([
          ...f.agents.filter((a) => !agentTaken(a)).map(agentKey),
          ...f.mcpServers.filter((s) => !serverTaken(s)).map(serverKey),
        ]));
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  const toggle = (k: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  async function importPicked() {
    if (!found) return;
    setBusy(true);
    setError("");
    // A named Claude model is kept when Claude Code is a provider here;
    // otherwise the zone follows the chat like any other.
    const claude = providers.find((p) => p.baseUrl === "cli://claude");
    const failed: string[] = [];
    for (const a of found.agents.filter((a) => picked.has(agentKey(a)) && !agentTaken(a))) {
      const pin = claude && a.model && a.model !== "inherit";
      try {
        await api.upsertZone({
          name: a.name,
          providerId: pin ? claude!.id : null,
          model: pin ? a.model : "",
          systemPrompt: a.prompt || null,
          temperature: null,
          maxTokens: null,
          topP: null,
          toolsEnabled: JSON.stringify(a.tools),
          toolConfig: a.readOnly ? JSON.stringify({ read_only: true }) : "{}",
          thinkingEnabled: true,
          thinkingEffort: "medium",
          includeThinkingInContext: false,
          isLeader: false,
          icon: null,
          accentColor: null,
        });
      } catch (e) {
        failed.push(`${a.name}: ${errorText(e)}`);
      }
    }
    for (const s of found.mcpServers.filter((s) => picked.has(serverKey(s)) && !serverTaken(s))) {
      try {
        const saved = await api.upsertMcpServer({
          name: s.name,
          transport: s.transport,
          command: s.command,
          url: s.url,
          env: s.env,
          headers: s.headers,
          enabled: true,
        });
        // Best effort: a server that won't start shows its error in the list.
        await api.connectMcpServer(saved.id).catch(() => {});
      } catch (e) {
        failed.push(`${s.name}: ${errorText(e)}`);
      }
    }
    await Promise.all([refreshZones(), refreshMcpServers()]);
    setBusy(false);
    if (failed.length > 0) setError(`Some couldn't be imported — ${failed.join("; ")}`);
    else onDone();
  }

  const count = picked.size;
  const nothing = found && found.agents.length === 0 && found.mcpServers.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <button onClick={onCancel} className="flex w-fit items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">
        <ArrowLeft size={12} /> Back
      </button>
      <section>
        <h3 className="mb-1 text-sm font-medium">From Claude Code</h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Sub-agents in <code>~/.claude/agents</code> become zones, and MCP servers in <code>~/.claude.json</code> are added here.
          Skills installed for Claude Code are already offered — see Settings → Skills.
        </p>
      </section>

      {!found && !error && (
        <p className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={12} className="animate-spin" /> Looking…
        </p>
      )}
      {nothing && <p className="text-xs text-[var(--color-text-muted)]">Nothing to bring over: no sub-agents or MCP servers were found.</p>}

      {found && found.agents.length > 0 && (
        <Group title="Agents → zones" icon={<Bot size={13} />}>
          {found.agents.map((a) => (
            <Row
              key={agentKey(a)}
              checked={picked.has(agentKey(a))}
              taken={agentTaken(a) ? "already a zone" : null}
              onToggle={() => toggle(agentKey(a))}
              title={a.name}
              detail={a.description}
              tags={[a.readOnly ? "read-only" : `${a.tools.length} tools`, a.model && a.model !== "inherit" ? a.model : "follows the chat"]}
            />
          ))}
        </Group>
      )}

      {found && found.mcpServers.length > 0 && (
        <Group title="MCP servers" icon={<Plug size={13} />}>
          {found.mcpServers.map((s) => {
            const secrets = [...keysOf(s.env), ...keysOf(s.headers)];
            return (
              <Row
                key={serverKey(s)}
                checked={picked.has(serverKey(s))}
                taken={serverTaken(s) ? "already added" : null}
                onToggle={() => toggle(serverKey(s))}
                title={s.name}
                detail={s.command ?? s.url ?? ""}
                tags={[s.scope === "user" ? "all projects" : s.scope, s.transport, ...(secrets.length ? [`sets ${secrets.join(", ")}`] : [])]}
              />
            );
          })}
        </Group>
      )}

      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}

      {found && !nothing && (
        <div className="mt-auto flex justify-end gap-2 pt-2">
          <button onClick={onCancel} className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs">Cancel</button>
          <button
            onClick={importPicked}
            disabled={busy || count === 0}
            className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {busy && <Loader2 size={12} className="animate-spin" />} Import {count}
          </button>
        </div>
      )}
    </div>
  );
}

function Group({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">{icon} {title}</h4>
      {children}
    </section>
  );
}

function Row(props: { checked: boolean; taken: string | null; onToggle: () => void; title: string; detail: string; tags: string[] }) {
  return (
    <label className={`flex items-start gap-2 rounded border border-[var(--color-border)] px-2.5 py-1.5 ${props.taken ? "opacity-50" : "cursor-pointer hover:border-[var(--color-accent)]"}`}>
      <input type="checkbox" className="mt-0.5" checked={props.checked && !props.taken} disabled={!!props.taken} onChange={props.onToggle} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-sm">{props.title}</span>
          {[props.taken, ...props.tags].filter(Boolean).map((t) => (
            <span key={t} className="rounded bg-[var(--color-panel-hover)] px-1.5 text-[10px] text-[var(--color-text-muted)]">{t}</span>
          ))}
        </span>
        {props.detail && <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{props.detail}</span>}
      </span>
    </label>
  );
}
