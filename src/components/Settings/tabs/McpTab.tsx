import { useEffect, useState } from "react";
import { X, Plus, Trash2, RefreshCw, Loader2, Wifi, WifiOff, Library, ChevronRight, Stethoscope, ExternalLink, Download } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import type { ConnectorCatalog, ConnectorEntry, ConnectorField, McpDiagnosis, McpServerView, McpTool } from "@/lib/types";
import { PRIMARY_ACTION } from "@/lib/chrome";
import { ErrorNote } from "@/components/common/ErrorNote";
import { reportError } from "@/lib/reportError";
import { SettingSelect } from "../controls";

const DANGER_META: Record<number, { label: string; cls: string }> = {
  0: { label: "Safe",      cls: "border-green-600/40  bg-green-600/10  text-green-500" },
  1: { label: "Moderate",  cls: "border-yellow-600/40 bg-yellow-600/10 text-yellow-500" },
  2: { label: "Dangerous", cls: "border-red-600/40    bg-red-600/10    text-red-500" },
};

function StatusPill({ status }: { status: McpServerView["status"] }) {
  const meta = {
    connected:   { icon: <Wifi size={11} />,    cls: "border-green-600/40 bg-green-600/10 text-green-500", label: "Connected" },
    error:       { icon: <WifiOff size={11} />,  cls: "border-red-600/40   bg-red-600/10   text-red-500",   label: "Error" },
    disconnected:{ icon: <WifiOff size={11} />,  cls: "border-[var(--color-border)] text-[var(--color-text-muted)]", label: "Disconnected" },
  }[status.state];
  return (
    <span
      title={status.error || undefined}
      className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}
    >
      {meta.icon} {meta.label}
    </span>
  );
}

export function McpTab() {
  const mcpServers = useApp((s) => s.mcpServers);
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);
  const [editing, setEditing] = useState<McpServerView | "new" | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [diagById, setDiagById] = useState<Record<string, McpDiagnosis>>({});

  useEffect(() => { refreshMcpServers().catch(reportError("Couldn't load MCP servers")); }, [refreshMcpServers]);

  // The launch autostart connects servers in parallel and reports each one as it
  // settles. Opening this tab while that is still in flight would otherwise show
  // stale "Disconnected" pills that never update.
  useEffect(() => {
    const un = api.onMcpStatusChanged(() => { refreshMcpServers().catch(reportError("Couldn't load MCP servers")); });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [refreshMcpServers]);

  async function connect(s: McpServerView) {
    setBusyId(s.id);
    setErrorById((e) => ({ ...e, [s.id]: "" }));
    try {
      await api.connectMcpServer(s.id);
    } catch (e) {
      setErrorById((prev) => ({ ...prev, [s.id]: String(e) }));
    } finally {
      setBusyId(null);
      await refreshMcpServers();
    }
  }

  async function disconnect(s: McpServerView) {
    await api.disconnectMcpServer(s.id);
    await refreshMcpServers();
  }

  // The diagnosis attempts the handshake itself, so it doubles as a connect —
  // refresh afterwards or the panel would show a stale "disconnected" beside a
  // report that says it connected.
  async function diagnose(s: McpServerView) {
    setBusyId(s.id);
    setErrorById((e) => ({ ...e, [s.id]: "" }));
    try {
      const report = await api.diagnoseMcpServer(s.id);
      setDiagById((d) => ({ ...d, [s.id]: report }));
    } catch (e) {
      setErrorById((prev) => ({ ...prev, [s.id]: String(e) }));
    } finally {
      setBusyId(null);
      await refreshMcpServers();
    }
  }

  async function remove(s: McpServerView) {
    if (!confirm(`Remove MCP server "${s.name}"? Its tools will be unenrolled from every zone.`)) return;
    await api.deleteMcpServer(s.id);
    await refreshMcpServers();
  }

  async function setDanger(toolId: string, level: number) {
    await api.setMcpToolDanger(toolId, level);
    await refreshMcpServers();
  }

  if (editing) {
    return (
      <McpServerEditor
        server={editing === "new" ? null : editing}
        onDone={async () => { setEditing(null); await refreshMcpServers(); }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (browsing) {
    return (
      <ConnectorCatalogPanel
        onDone={async () => { setBrowsing(false); await refreshMcpServers(); }}
        onCancel={() => setBrowsing(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="mb-1 text-sm font-medium">MCP servers</h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Local commands (stdio) or remote endpoints (SSE/HTTP). Connecting fetches the server's
          tools; give each a danger level here, then enable the ones you want per zone in the zone
          editor. They go through the same approval pipeline as built-in tools.
        </p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Every enabled server connects on launch, so its tools and their descriptions are current
          before the first message. Turn a server off with its own switch to stop it starting;
          <strong> Connect</strong> here is for reconnecting after a change or a failure.
        </p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Prefer the <strong>catalog</strong>: an entry already knows the command and the variables,
          so all it asks you for is the credential.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setBrowsing(true)}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Library size={12} /> Browse catalog
        </button>
        <button
          onClick={() => setEditing("new")}
          className="flex items-center gap-1.5 rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} /> Add manually
        </button>
      </div>

      {mcpServers.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
          No MCP servers yet.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {mcpServers.map((s) => (
            <div key={s.id} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              {/* Five actions and four badges fit a 980px panel and not a phone
                  (0.17.3). Unwrapped, the name column collapsed to nothing and
                  the buttons still ran off the right edge — the screenshot that
                  prompted this had a card showing half a Disconnect button and
                  no server name at all. */}
              <div className="flex items-start justify-between gap-3 narrow:flex-col narrow:items-stretch">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 narrow:flex-wrap">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-muted)]">
                      {s.transport}
                    </span>
                    <StatusPill status={s.status} />
                    {!s.enabled && (
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">disabled</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-text-muted)]">
                    {s.transport === "stdio" ? s.command : s.url}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 narrow:flex-wrap">
                  <button
                    onClick={() => connect(s)}
                    disabled={busyId === s.id}
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
                  >
                    {busyId === s.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    {s.status.state === "connected" ? "Refresh" : "Connect"}
                  </button>
                  <button
                    onClick={() => diagnose(s)}
                    disabled={busyId === s.id}
                    title="Run the checks in the order they can fail and report the first one that does"
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
                  >
                    <Stethoscope size={11} /> Diagnose
                  </button>
                  {s.status.state === "connected" && (
                    <button onClick={() => disconnect(s)} className="rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Disconnect</button>
                  )}
                  <button onClick={() => setEditing(s)} className="rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Edit</button>
                  <button onClick={() => remove(s)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Delete">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {errorById[s.id] && (
                <ErrorNote error={errorById[s.id]} className="mt-2 rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500" />
              )}

              {diagById[s.id] && (
                <DiagnosisPanel
                  diagnosis={diagById[s.id]}
                  onDismiss={() => setDiagById(({ [s.id]: _drop, ...rest }) => rest)}
                />
              )}

              {s.tools.length > 0 && (
                <McpToolList tools={s.tools} onSetDanger={setDanger} />
              )}
              {s.tools.length === 0 && s.status.state === "connected" && (
                <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">This server advertised no tools.</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A server's tools, folded away by default.
 *
 * A connected GitHub server advertises 47 of them, each with a description and
 * a danger dropdown — expanded, one server filled several screens and finding
 * the next one meant scrolling past all of it. The count is on the summary line,
 * which is what you want to know most of the time; the filter appears once the
 * list is long enough that scanning it is the slow part.
 */
function McpToolList({
  tools,
  onSetDanger,
}: {
  tools: McpTool[];
  onSetDanger: (toolId: string, level: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const q = filter.trim().toLowerCase();
  const shown = q
    ? tools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q),
      )
    : tools;

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        <ChevronRight size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        Tools ({tools.length})
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {tools.length > 8 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tools"
              className="input text-xs"
            />
          )}
          {shown.map((t) => (
            <McpToolRow key={t.id} tool={t} onSetDanger={(lvl) => onSetDanger(t.id, lvl)} />
          ))}
          {shown.length === 0 && (
            <div className="py-2 text-center text-[11px] text-[var(--color-text-muted)]">
              Nothing matches “{filter}”.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The report a failed connection should have given in the first place: the
 * checks in the order they can fail, the first false one, and the thing to do
 * about it. The passing checks stay visible — "npx resolved, the key is set,
 * the server itself refused us" is a different problem from "npx is missing",
 * and only the list makes that legible.
 */
function DiagnosisPanel({ diagnosis, onDismiss }: { diagnosis: McpDiagnosis; onDismiss: () => void }) {
  const tone = diagnosis.ok
    ? "border-green-600/40 bg-green-600/10"
    : "border-yellow-600/40 bg-yellow-600/10";
  return (
    <div className={`mt-2 rounded border p-2 text-[11px] ${tone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">{diagnosis.summary}</div>
        <button onClick={onDismiss} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title="Dismiss">
          <X size={11} />
        </button>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {diagnosis.checks.map((c) => (
          <li key={c.name} className="flex items-start gap-1.5">
            <span className={c.ok ? "text-green-500" : "text-red-500"}>{c.ok ? "✓" : "✕"}</span>
            <span className="min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{c.name}</span>{" "}
              <span className="whitespace-pre-wrap break-words">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {diagnosis.nextStep && (
        <div className="mt-2 border-t border-[var(--color-border)] pt-1.5">
          <span className="font-medium">Next: </span>{diagnosis.nextStep}
        </div>
      )}
      {diagnosis.docsUrl && (
        <a href={diagnosis.docsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">
          <ExternalLink size={10} /> {diagnosis.docsUrl}
        </a>
      )}
    </div>
  );
}

/**
 * The catalog: pick a connector, fill in the one thing only you have, install.
 *
 * Entries are files rather than code — the shipped ones come with the app, any
 * imported ones live in the connectors folder — so "import from a URL" is the
 * whole extensibility story and widening the set needs no release.
 */
function ConnectorCatalogPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [catalog, setCatalog] = useState<ConnectorCatalog | null>(null);
  const [chosen, setChosen] = useState<ConnectorEntry | null>(null);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  async function load() {
    try {
      setCatalog(await api.listConnectors());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => { load().catch(reportError("Couldn't load this page")); }, []);

  async function runImport() {
    if (!importUrl.trim()) return;
    setImporting(true);
    setError("");
    setNote("");
    try {
      const added = await api.importConnectors({ url: importUrl.trim() });
      setImportUrl("");
      setNote(`Imported ${added.length} ${added.length === 1 ? "entry" : "entries"}: ${added.map((e) => e.name).join(", ")}`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }

  async function removeEntry(entry: ConnectorEntry) {
    if (!confirm(`Remove the catalog entry "${entry.name}"? Servers already installed from it stay.`)) return;
    try {
      await api.deleteConnector(entry.id);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  if (chosen) {
    return (
      <ConnectorInstallForm
        entry={chosen}
        alreadyInstalled={Boolean(catalog?.installed[chosen.id])}
        onCancel={() => setChosen(null)}
        onInstalled={onDone}
      />
    );
  }

  const byCategory = new Map<string, ConnectorEntry[]>();
  for (const e of catalog?.entries ?? []) {
    const key = e.category || "Other";
    byCategory.set(key, [...(byCategory.get(key) ?? []), e]);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Connector catalog</h3>
        <button onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">← Back</button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Each entry carries the command or URL, the variables it needs, and a link to the page each
        credential comes from. Installing writes the server and stops — nothing runs or connects
        until you press Connect.
      </p>

      {!catalog ? (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : (
        [...byCategory.entries()].map(([category, entries]) => (
          <section key={category} className="flex flex-col gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{category}</div>
            {entries.map((e) => (
              <div key={e.id} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{e.name}</span>
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-muted)]">{e.transport}</span>
                      {catalog.installed[e.id] && (
                        <span className="rounded border border-green-600/40 bg-green-600/10 px-1.5 py-0.5 text-[10px] text-green-500">Installed</span>
                      )}
                      {!e.curated && (
                        <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">imported</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{e.description}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => setChosen(e)}
                      className="rounded border border-[var(--color-border)] px-2 py-1 text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    >
                      {catalog.installed[e.id] ? "Reinstall" : "Install"}
                    </button>
                    {!e.curated && (
                      <button onClick={() => removeEntry(e)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Remove this catalog entry">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </section>
        ))
      )}

      <section className="rounded border border-dashed border-[var(--color-border)] p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium"><Download size={12} /> Import entries from a URL</div>
        <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">
          A JSON file holding one entry, a list of them, or an object with an
          <span className="font-mono"> entries </span> array. One sharing an id with a shipped entry
          replaces it.
        </p>
        <div className="flex items-center gap-2">
          <input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://example.com/connectors.json"
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--color-accent)]"
          />
          <button
            onClick={runImport}
            disabled={importing || !importUrl.trim()}
            className={`shrink-0 rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
          >
            {importing ? "Importing…" : "Import"}
          </button>
        </div>
      </section>

      {note && <div className="rounded border border-green-600/40 bg-green-600/10 p-2 text-[11px] text-green-500">{note}</div>}
      {error && <ErrorNote error={error} className="rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500" />}
    </div>
  );
}

/**
 * One entry's install form: the prerequisites, then only the values the entry
 * says the user has to supply. Everything else the catalog already knows.
 */
function ConnectorInstallForm({
  entry,
  alreadyInstalled,
  onInstalled,
  onCancel,
}: {
  entry: ConnectorEntry;
  alreadyInstalled: boolean;
  onInstalled: () => void;
  onCancel: () => void;
}) {
  const fields: ConnectorField[] = [...(entry.env ?? []), ...(entry.headers ?? [])];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.default ?? ""])),
  );
  const [name, setName] = useState(entry.name);
  const [suffix, setSuffix] = useState("");
  const [replace, setReplace] = useState(alreadyInstalled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const missing = fields.filter((f) => f.required && !values[f.key]?.trim()).map((f) => f.label);

  async function install() {
    setSaving(true);
    setError("");
    try {
      await api.installConnector({
        entryId: entry.id,
        values,
        name: name.trim() || null,
        commandSuffix: suffix.trim() || null,
        replace,
      });
      onInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Install {entry.name}</h3>
        <button onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">← Back</button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">{entry.description}</p>

      {(entry.prerequisites?.length ?? 0) > 0 && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2">
          <div className="mb-1 text-[11px] font-medium">Before this can work</div>
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-[var(--color-text-muted)]">
            {entry.prerequisites?.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      {entry.docsUrl && (
        <a href={entry.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline">
          <ExternalLink size={11} /> Setup guide
        </a>
      )}

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Name in MultiZone</div>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />
      </label>

      <div className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2 font-mono text-[11px] text-[var(--color-text-muted)]">
        {entry.transport === "stdio" ? entry.command : entry.url}
      </div>

      {entry.transport === "stdio" && (
        <label className="block">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">Extra arguments <span className="opacity-60">(appended to the command)</span></div>
          <input value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="e.g. a directory the server may read" className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" />
        </label>
      )}

      {fields.map((f) => (
        <label key={f.key} className="block">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            <span>{f.label}</span>
            {!f.required && <span className="opacity-60">(optional)</span>}
            <span className="font-mono opacity-60">{f.key}</span>
          </div>
          <input
            type={f.secret ? "password" : "text"}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          />
          {f.description && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{f.description}</div>}
          {f.credentialUrl && (
            <a href={f.credentialUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline">
              <ExternalLink size={10} /> Where to get this
            </a>
          )}
        </label>
      ))}

      {alreadyInstalled && (
        <label className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Update the server already installed from this entry, rather than adding a second one
        </label>
      )}

      {error && <ErrorNote error={error} className="rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500" />}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-3">
        <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
        <button
          onClick={install}
          disabled={saving || missing.length > 0}
          title={missing.length > 0 ? `Still needs: ${missing.join(", ")}` : undefined}
          className={`rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
        >
          {saving ? "Installing…" : "Install"}
        </button>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Credentials are stored with the server in MultiZone's own database, like the rest of your
        settings. Nothing is sent anywhere until you connect.
      </p>
    </div>
  );
}

function McpToolRow({ tool, onSetDanger }: { tool: McpTool; onSetDanger: (level: number) => void }) {
  const [open, setOpen] = useState(false);
  const badge = DANGER_META[tool.dangerLevel] ?? DANGER_META[1];
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[11px] font-medium">{tool.name}</span>
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
          </div>
          {tool.description && (
            <div className="mt-0.5 line-clamp-1 text-[var(--color-text-muted)]">{tool.description}</div>
          )}
        </button>
        <select
          value={tool.dangerLevel}
          onChange={(e) => onSetDanger(Number(e.target.value))}
          className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
          title="Danger level — drives the approval prompt"
        >
          <option value={0}>Safe</option>
          <option value={1}>Moderate</option>
          <option value={2}>Dangerous</option>
        </select>
      </div>
      {open && (
        <div className="mt-2 border-t border-[var(--color-border)] pt-2">
          {tool.description && <div className="mb-2 text-[var(--color-text-muted)]">{tool.description}</div>}
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Input schema</div>
          <pre className="max-h-40 overflow-auto rounded bg-[var(--color-bg)] p-2 font-mono text-[10px] text-[var(--color-text-muted)]">
            {tool.inputSchema ? prettyJson(tool.inputSchema) : "(none)"}
          </pre>
        </div>
      )}
    </div>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function McpServerEditor({
  server,
  onDone,
  onCancel,
}: {
  server: McpServerView | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "sse">(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [env, setEnv] = useState(server?.env ?? "");
  const [headers, setHeaders] = useState(server?.headers ?? "");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);

  /** What's wrong with the form as it stands, or null when it can be written. */
  function invalid(): string | null {
    if (!name.trim()) return "A server needs a name.";
    if (transport === "stdio" && !command.trim()) return "A stdio server needs a command.";
    if (transport === "sse" && !url.trim()) return "An SSE/HTTP server needs a URL.";
    if (env.trim()) {
      try { JSON.parse(env); } catch { return "Env must be valid JSON (e.g. {\"API_KEY\":\"…\"})."; }
    }
    if (headers.trim()) {
      try { JSON.parse(headers); } catch { return "Headers must be valid JSON (e.g. {\"Authorization\":\"Bearer …\"})."; }
    }
    return null;
  }

  function payload() {
    return {
      id: server?.id,
      name: name.trim(),
      transport,
      command: transport === "stdio" ? command.trim() : null,
      url: transport === "sse" ? url.trim() : null,
      env: transport === "stdio" ? env.trim() || null : null,
      headers: transport === "sse" ? headers.trim() || null : null,
      enabled,
    };
  }

  async function onCreate() {
    const problem = invalid();
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError("");
    try {
      await api.upsertMcpServer(payload());
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // An existing server saves itself. A half-typed JSON blob is simply not
  // written — the reason says so and the last good version stays on disk.
  useEffect(() => {
    if (!server?.id) return;
    const problem = invalid();
    setError(problem ?? "");
    if (problem) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        await api.upsertMcpServer(payload());
        await refreshMcpServers();
      } catch (e) {
        setError(String(e));
      } finally { setSaving(false); }
    }, 600);
    return () => clearTimeout(timer);
  }, [server?.id, name, transport, command, url, env, headers, enabled]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{server ? "Edit MCP server" : "Add MCP server"}</h3>
        <button onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">← Back</button>
      </div>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Name</div>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" placeholder="e.g. Filesystem" />
      </label>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Transport</div>
        <SettingSelect value={transport} onChange={(v) => setTransport(v as "stdio" | "sse")}>
          <option value="stdio">stdio (local command)</option>
          <option value="sse">SSE / HTTP (remote URL)</option>
        </SettingSelect>
      </label>

      {transport === "stdio" ? (
        <>
          <label className="block">
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">Command</div>
            <input value={command} onChange={(e) => setCommand(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" placeholder="npx -y @modelcontextprotocol/server-filesystem ." />
          </label>
          <label className="block">
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">Environment variables <span className="opacity-60">(optional JSON)</span></div>
            <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" placeholder='{ "API_KEY": "…" }' />
          </label>
        </>
      ) : (
        <>
          <label className="block">
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">URL</div>
            <input value={url} onChange={(e) => setUrl(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" placeholder="https://example.com/mcp" />
          </label>
          <label className="block">
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">Headers <span className="opacity-60">(optional JSON)</span></div>
            <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={3} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" placeholder={'{ "Authorization": "Bearer \u2026" }'} />
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              Sent with every request. Almost every hosted MCP server wants an
              <span className="font-mono"> Authorization </span> header here; without one it will
              answer 401 and nothing else will work.
            </div>
          </label>
        </>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <button
          onClick={() => setEnabled((v) => !v)}
          className={`relative h-5 w-9 rounded-full transition-colors ${enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
        >
          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${enabled ? "translate-x-4" : ""}`} />
        </button>
        <span>Enabled — its tools are available to zones</span>
      </label>

      {error && (
        <ErrorNote error={error} className="rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500" />
      )}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-3">
        {server ? (
          <>
            <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">
              {saving ? "Saving…" : "Changes save as you make them"}
            </span>
            <button onClick={onDone} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Done</button>
          </>
        ) : (
          <>
            <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
            <button onClick={onCreate} disabled={saving || !name.trim()} className={`rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}>
              Add server
            </button>
          </>
        )}
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Click <span className="font-medium">Connect</span> to fetch this server's tools.
      </p>
    </div>
  );
}

// ─── Knowledge (default embedding + global KB) ──────────────────────────────────
