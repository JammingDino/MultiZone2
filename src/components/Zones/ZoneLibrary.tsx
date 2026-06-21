import { useEffect, useState } from "react";
import { X, Download, Trash2, Loader2, Check, Sparkles, Bookmark } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import type { LibraryEntry } from "@/lib/types";
import { getZoneIcon } from "@/lib/zoneIcons";
import { installEntry, saveZoneToLibrary } from "@/lib/zoneLibrary";
import { ALL_TOOLS } from "@/lib/types";

/**
 * Browsable zone library: curated presets shipped with the app plus the user's
 * own "Save to library" snapshots. Install an entry to create a live zone.
 */
export function ZoneLibrary() {
  const closeZoneLibrary = useApp((s) => s.closeZoneLibrary);
  const zones = useApp((s) => s.zones);
  const providers = useApp((s) => s.providers);
  const defaultProviderId = useApp((s) => s.appSettings.defaultProviderId);
  const refreshZones = useApp((s) => s.refreshZones);

  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installedId, setInstalledId] = useState<string | null>(null);
  const [savePicker, setSavePicker] = useState(false);

  const quickProvider = providers.find((p) => p.id === (defaultProviderId ?? providers[0]?.id)) ?? null;
  const quickModel = quickProvider?.defaultModel?.trim() || null;
  const canInstall = !!quickProvider; // a provider is required; model falls back to entry/provider default

  async function load() {
    setLoading(true);
    try {
      setEntries(await api.listLibraryEntries());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function onInstall(entry: LibraryEntry) {
    if (!quickProvider) return;
    setBusyId(entry.id);
    try {
      await installEntry(entry, quickProvider.id, quickModel ?? "", zones.map((z) => z.name));
      await refreshZones();
      setInstalledId(entry.id);
      setTimeout(() => setInstalledId((v) => (v === entry.id ? null : v)), 1800);
    } catch (e) {
      console.error(e);
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(entry: LibraryEntry) {
    setBusyId(entry.id);
    try {
      await api.deleteLibraryEntry(entry.id);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function onSaveZone(zoneId: string) {
    const zone = zones.find((z) => z.id === zoneId);
    setSavePicker(false);
    if (!zone) return;
    try {
      await saveZoneToLibrary(zone);
      await load();
    } catch (e) {
      console.error(e);
    }
  }

  const curated = entries.filter((e) => e.curated);
  const saved = entries.filter((e) => !e.curated);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeZoneLibrary}>
      <div
        className="flex h-[700px] w-[960px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex h-12 items-center justify-between border-b border-[var(--color-border)] px-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles size={16} className="text-[var(--color-accent)]" />
            Zone Library
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => setSavePicker((v) => !v)}
                disabled={zones.length === 0}
                className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                title={zones.length === 0 ? "No zones to save yet" : "Save one of your zones to the library"}
              >
                <Bookmark size={12} /> Save a zone…
              </button>
              {savePicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSavePicker(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 max-h-72 min-w-[200px] overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
                    {zones.map((z) => {
                      const Icon = getZoneIcon(z.icon);
                      return (
                        <button
                          key={z.id}
                          onClick={() => onSaveZone(z.id)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
                        >
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded" style={{ background: z.accentColor ?? "var(--color-accent)" }}>
                            <Icon size={10} color="white" />
                          </span>
                          <span className="truncate">{z.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <button onClick={closeZoneLibrary} className="rounded p-1 hover:bg-[var(--color-panel-hover)]">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {!canInstall && (
            <div className="mb-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
              Add a provider in Settings to install zones from the library.
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-16 text-[var(--color-text-muted)]">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : (
            <>
              <Section title="Curated">
                {curated.length === 0 ? (
                  <Empty>No curated presets.</Empty>
                ) : (
                  <Grid>
                    {curated.map((e) => (
                      <LibraryCard
                        key={e.id}
                        entry={e}
                        busy={busyId === e.id}
                        installed={installedId === e.id}
                        canInstall={canInstall}
                        onInstall={() => onInstall(e)}
                      />
                    ))}
                  </Grid>
                )}
              </Section>

              <Section title="Saved by you">
                {saved.length === 0 ? (
                  <Empty>Nothing saved yet — use “Save a zone…” to snapshot one of your zones here.</Empty>
                ) : (
                  <Grid>
                    {saved.map((e) => (
                      <LibraryCard
                        key={e.id}
                        entry={e}
                        busy={busyId === e.id}
                        installed={installedId === e.id}
                        canInstall={canInstall}
                        onInstall={() => onInstall(e)}
                        onDelete={() => onDelete(e)}
                      />
                    ))}
                  </Grid>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">{title}</div>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded border border-dashed border-[var(--color-border)] px-3 py-4 text-xs text-[var(--color-text-muted)]">{children}</div>;
}

function LibraryCard({
  entry,
  busy,
  installed,
  canInstall,
  onInstall,
  onDelete,
}: {
  entry: LibraryEntry;
  busy: boolean;
  installed: boolean;
  canInstall: boolean;
  onInstall: () => void;
  onDelete?: () => void;
}) {
  const Icon = getZoneIcon(entry.icon);
  const color = entry.accentColor ?? "var(--color-accent)";
  let tools: string[] = [];
  try {
    tools = JSON.parse(entry.toolsEnabled) as string[];
  } catch { /* ignore */ }
  const toolLabels = tools
    .map((id) => ALL_TOOLS.find((t) => t.id === id)?.label ?? id)
    .slice(0, 6);
  const promptPreview = (entry.systemPrompt ?? "").replace(/\s+/g, " ").trim();

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm" style={{ background: color }}>
          <Icon size={16} color="white" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" style={{ color }}>{entry.name}</div>
          <div className="line-clamp-2 text-xs text-[var(--color-text-muted)]">
            {entry.description || promptPreview || "No description."}
          </div>
        </div>
      </div>

      {toolLabels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {toolLabels.map((t) => (
            <span key={t} className="rounded-full border border-[var(--color-border)] px-1.5 py-px text-[10px] text-[var(--color-text-muted)]">
              {t}
            </span>
          ))}
          {tools.length > toolLabels.length && (
            <span className="text-[10px] text-[var(--color-text-muted)]">+{tools.length - toolLabels.length}</span>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center gap-2 pt-1">
        <button
          onClick={onInstall}
          disabled={busy || !canInstall}
          className="flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs text-white transition disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: color }}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : installed ? <Check size={12} /> : <Download size={12} />}
          {installed ? "Installed" : "Install"}
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            disabled={busy}
            title="Remove from library"
            className="rounded border border-[var(--color-border)] p-1.5 text-[var(--color-text-muted)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
