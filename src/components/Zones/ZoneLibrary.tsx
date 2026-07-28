import { useEffect, useMemo, useRef, useState } from "react";
import {
  X, Download, Check, Loader2, Sparkles, Bookmark, ChevronLeft, ChevronRight,
  ChevronDown, Plus, Upload, Settings as SettingsIcon, MessageSquare, Trash2, Star, Pencil, Crown,
} from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import type { LibraryEntry, Provider, Zone } from "@/lib/types";
import { ALL_TOOLS } from "@/lib/types";
import { getZoneIcon } from "@/lib/zoneIcons";
import { resolveBaseModel, resolveBaseProvider } from "@/lib/baseZone";
import { installEntry, saveZoneToLibrary, importEntryFromJson, exportZoneJson } from "@/lib/zoneLibrary";
import { ZoneForm } from "./ZoneForm";
import { Modal, ModalTitle } from "@/components/common/Modal";

type View = "library" | "detail" | "editor";

function toolLabel(id: string): string {
  return ALL_TOOLS.find((t) => t.id === id)?.label ?? id;
}
function parseTools(json: string): string[] {
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/**
 * Configure Zones / Zone Library. Left rail lists installed (live) zones; the
 * right pane browses the on-disk library — curated presets plus user snapshots
 * — with per-entry detail. Installing creates a live zone; configuring opens
 * the zone editor.
 */
export function ZoneLibrary() {
  const closeZoneLibrary = useApp((s) => s.closeZoneLibrary);
  const zones = useApp((s) => s.zones);
  const providers = useApp((s) => s.providers);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  const pageSize = useApp((s) => s.appSettings.zoneLibraryPageSize) || 6;
  const refreshZones = useApp((s) => s.refreshZones);
  const defaultZoneId = useApp((s) => s.defaultZoneId);
  const setDefaultZone = useApp((s) => s.setDefaultZone);

  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("library");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Zone being edited in the embedded editor (null = creating a new zone).
  const [editorZoneId, setEditorZoneId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [savePicker, setSavePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  // Right-click zone context menu + inline rename.
  const [zoneMenu, setZoneMenu] = useState<{ zone: Zone; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  // Newly installed library zones inherit the base zone's provider + model —
  // whatever the user already treats as their default assistant.
  const quickProvider = resolveBaseProvider(providers, zones, baseZoneId);
  const quickModel = resolveBaseModel(providers, zones, baseZoneId);
  const canInstall = !!quickProvider;

  function flash(msg: string) {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2400);
  }

  async function load() {
    setLoading(true);
    try {
      setEntries(await api.listLibraryEntries());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const installedNames = useMemo(
    () => new Set(zones.map((z) => z.name.toLowerCase())),
    [zones],
  );
  const isInstalled = (e: LibraryEntry) => installedNames.has(e.name.toLowerCase());
  const liveZoneFor = (e: LibraryEntry): Zone | undefined =>
    zones.find((z) => z.name.toLowerCase() === e.name.toLowerCase());

  // "Curated" = shipped presets you haven't installed yet (available to add).
  // "Saved by you" = your zones — anything installed, plus your imports.
  const available = entries.filter((e) => e.curated && !isInstalled(e));
  const yours = entries.filter((e) => isInstalled(e) || !e.curated);
  const totalPages = Math.max(1, Math.ceil(available.length / pageSize));
  const pageSafe = Math.min(page, totalPages - 1);
  const start = pageSafe * pageSize;
  const pageAvailable = available.slice(start, start + pageSize);

  const selected = entries.find((e) => e.id === selectedId) ?? null;
  const editorZone = editorZoneId ? zones.find((z) => z.id === editorZoneId) ?? null : null;

  function openEditor(zoneId: string | null) {
    setEditorZoneId(zoneId);
    setView("editor");
  }

  function openZoneMenu(zone: Zone, x: number, y: number) {
    setZoneMenu({ zone, x, y });
  }
  function startRename(zone: Zone) {
    setZoneMenu(null);
    setRenameValue(zone.name);
    setRenamingId(zone.id);
  }
  async function commitRename(zone: Zone) {
    const next = renameValue.trim();
    setRenamingId(null);
    if (!next || next === zone.name) return;
    try {
      await api.upsertZone({ ...zone, name: next });
      await refreshZones();
      flash(`Renamed to “${next}”`);
    } catch (e) {
      console.error(e);
    }
  }
  function onExportZone(zone: Zone) {
    setZoneMenu(null);
    exportZoneJson(zone);
    flash(`Exported “${zone.name}”`);
  }
  async function onDeleteZone(zone: Zone) {
    setZoneMenu(null);
    setBusy(true);
    try {
      await api.deleteZone(zone.id);
      await refreshZones();
      if (editorZoneId === zone.id) setView("library");
      flash(`Deleted “${zone.name}”`);
    } finally {
      setBusy(false);
    }
  }

  async function onInstall(e: LibraryEntry) {
    if (!quickProvider || busy) return;
    setBusy(true);
    try {
      const { modelFallback } = await installEntry(
        e, quickProvider.id, quickModel, zones.map((z) => z.name),
      );
      await refreshZones();
      flash(
        modelFallback
          ? `Installed “${e.name}” using ${modelFallback.used} — ${quickProvider.name} doesn't offer ${modelFallback.wanted}`
          : `Installed “${e.name}”`,
      );
    } catch (err) {
      console.error(err);
      flash(`Couldn't install “${e.name}”: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  function onConfigure(e: LibraryEntry) {
    const z = liveZoneFor(e);
    if (z) openEditor(z.id);
  }

  async function onUninstall(e: LibraryEntry) {
    const z = liveZoneFor(e);
    if (!z || busy) return;
    setBusy(true);
    try {
      await api.deleteZone(z.id);
      await refreshZones();
      flash(`Removed “${e.name}”`);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteEntry(e: LibraryEntry) {
    setBusy(true);
    try {
      await api.deleteLibraryEntry(e.id);
      await load();
      setView("library");
      flash(`Deleted “${e.name}” from library`);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveZone(zoneId: string) {
    setSavePicker(false);
    const z = zones.find((x) => x.id === zoneId);
    if (!z) return;
    try {
      await saveZoneToLibrary(z);
      await load();
      flash(`Saved “${z.name}” to library`);
    } catch (e) {
      console.error(e);
    }
  }

  async function importFile(file: File) {
    try {
      const text = await file.text();
      const name = file.name.replace(/\.json$/i, "").replace(/[-_]/g, " ");
      const e = await importEntryFromJson(text, name);
      await load();
      setAddOpen(false);
      flash(`Added “${e.name}” to library`);
    } catch (err) {
      flash(`Import failed: ${(err as Error).message}`);
    }
  }

  async function importUrl() {
    const url = urlValue.trim();
    if (!url) return;
    try {
      const res = await fetch(url);
      const text = await res.text();
      const name = url.split("/").pop()?.replace(/\.json.*$/i, "") ?? "Imported Zone";
      const e = await importEntryFromJson(text, name);
      await load();
      setAddOpen(false);
      setUrlValue("");
      flash(`Added “${e.name}” to library`);
    } catch (err) {
      flash(`Couldn't fetch that link`);
    }
  }

  function onDrop(ev: React.DragEvent) {
    ev.preventDefault();
    setDragOver(false);
    const f = ev.dataTransfer?.files?.[0];
    if (f) importFile(f);
  }

  return (
    <Modal
      onClose={closeZoneLibrary}
      className="h-[700px] w-[980px] overflow-hidden"
      header={<ModalTitle>Configure Zones</ModalTitle>}
    >
        <div className="flex min-h-0 flex-1">
          {/* LEFT RAIL */}
          <div className="flex w-56 flex-shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]/40">
            <div className="flex flex-col gap-2 p-3">
              <button
                onClick={() => openEditor(null)}
                className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed text-sm font-medium text-[var(--color-accent)] transition hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-hover)] ${
                  view === "editor" && !editorZoneId ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]" : "border-[var(--color-border)]"
                }`}
              >
                <Plus size={15} /> New Zone
              </button>
              <button
                onClick={() => setView("library")}
                className={`flex h-9 items-center justify-center gap-2 rounded-lg border text-sm font-semibold transition ${
                  view === "library" || view === "detail"
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                    : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
                }`}
              >
                <Sparkles size={15} /> Browse Library
              </button>
            </div>

            <div className="px-3.5 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Installed · {zones.length}
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-3">
              {zones.length === 0 && (
                <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">No zones installed yet.</div>
              )}
              {zones.map((z) => {
                const Icon = getZoneIcon(z.icon);
                const accent = z.accentColor ?? "var(--color-accent)";
                const active = view === "editor" && editorZoneId === z.id;
                if (renamingId === z.id) {
                  return (
                    <div key={z.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: accent }}>
                        <Icon size={15} color="white" />
                      </span>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(z)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(z);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="min-w-0 flex-1 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[13px] outline-none"
                      />
                    </div>
                  );
                }
                return (
                  <button
                    key={z.id}
                    onClick={() => openEditor(z.id)}
                    onContextMenu={(e) => { e.preventDefault(); openZoneMenu(z, e.clientX, e.clientY); }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-panel-hover)] ${active ? "bg-[var(--color-panel-hover)]" : ""}`}
                  >
                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: accent }}>
                      <Icon size={15} color="white" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="truncate text-[13px] font-medium leading-tight">{z.name}</span>
                        {z.isLeader && (
                          <Crown size={11} className="flex-shrink-0 text-amber-500" />
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{z.model}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* RIGHT PANE */}
          <div className="relative flex min-w-0 flex-1 flex-col">
            {loading ? (
              <div className="flex flex-1 items-center justify-center text-[var(--color-text-muted)]">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : view === "editor" ? (
              <EditorView
                zone={editorZone}
                providers={providers}
                isDefault={!!editorZone && defaultZoneId === editorZone.id}
                onToggleDefault={() => { if (editorZone) setDefaultZone(defaultZoneId === editorZone.id ? null : editorZone.id); }}
                onBack={() => setView("library")}
                onSaved={async () => { await refreshZones(); setView("library"); }}
                onDeleted={async () => { await refreshZones(); setView("library"); }}
              />
            ) : view === "detail" && selected ? (
              <DetailView
                entry={selected}
                installed={isInstalled(selected)}
                canInstall={canInstall}
                busy={busy}
                onBack={() => setView("library")}
                onInstall={() => onInstall(selected)}
                onConfigure={() => onConfigure(selected)}
                onUninstall={() => onUninstall(selected)}
                onDelete={() => onDeleteEntry(selected)}
              />
            ) : (
              <LibraryView
                pageAvailable={pageAvailable}
                yours={yours}
                canInstall={canInstall}
                busy={busy}
                isInstalled={isInstalled}
                onOpen={(e) => { setSelectedId(e.id); setView("detail"); }}
                onInstall={onInstall}
                onConfigure={onConfigure}
                onCardContextMenu={(e, ev) => {
                  const z = liveZoneFor(e);
                  if (z) { ev.preventDefault(); openZoneMenu(z, ev.clientX, ev.clientY); }
                }}
                page={pageSafe}
                totalPages={totalPages}
                rangeLabel={`Showing ${available.length === 0 ? 0 : start + 1}–${start + pageAvailable.length} of ${available.length} available`}
                onPrev={() => setPage((p) => Math.max(0, p - 1))}
                onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                onPage={setPage}
                addOpen={addOpen}
                onToggleAdd={() => setAddOpen((v) => !v)}
                onCloseAdd={() => setAddOpen(false)}
                urlValue={urlValue}
                onUrlInput={setUrlValue}
                onAddUrl={importUrl}
                onBrowse={() => fileRef.current?.click()}
                savePicker={savePicker}
                onToggleSave={() => setSavePicker((v) => !v)}
                zones={zones}
                onSaveZone={onSaveZone}
                dragOver={dragOver}
                onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
                onDrop={onDrop}
              />
            )}
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }}
        />

        {toast && (
          <div className="absolute bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-lg bg-[var(--color-text)] px-4 py-2 text-[12.5px] font-medium text-[var(--color-bg)] shadow-xl">
            <Check size={14} className="text-green-400" />
            {toast}
          </div>
        )}

        {zoneMenu && (
          <ZoneContextMenu
            x={zoneMenu.x}
            y={zoneMenu.y}
            onClose={() => setZoneMenu(null)}
            onEdit={() => { const z = zoneMenu.zone; setZoneMenu(null); openEditor(z.id); }}
            onRename={() => startRename(zoneMenu.zone)}
            onExport={() => onExportZone(zoneMenu.zone)}
            onDelete={() => onDeleteZone(zoneMenu.zone)}
          />
        )}
    </Modal>
  );
}

function ZoneContextMenu({
  x, y, onClose, onEdit, onRename, onExport, onDelete,
}: {
  x: number; y: number; onClose: () => void;
  onEdit: () => void; onRename: () => void; onExport: () => void; onDelete: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-[70]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="fixed z-[80] min-w-[160px] rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-2xl" style={{ left: x, top: y }}>
        <MenuItem icon={<SettingsIcon size={13} />} label="Edit" onClick={onEdit} />
        <MenuItem icon={<Pencil size={13} />} label="Rename" onClick={onRename} />
        <MenuItem icon={<Download size={13} />} label="Export JSON" onClick={onExport} />
        <div className="my-1 border-t border-[var(--color-border)]" />
        <MenuItem icon={<Trash2 size={13} />} label="Delete" onClick={onDelete} danger />
      </div>
    </>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--color-panel-hover)] ${danger ? "text-[var(--color-danger)]" : ""}`}
    >
      {icon} {label}
    </button>
  );
}

// ─── Library (grid) view ────────────────────────────────────────────────────

function LibraryView(props: {
  pageAvailable: LibraryEntry[];
  yours: LibraryEntry[];
  canInstall: boolean;
  busy: boolean;
  isInstalled: (e: LibraryEntry) => boolean;
  onOpen: (e: LibraryEntry) => void;
  onInstall: (e: LibraryEntry) => void;
  onConfigure: (e: LibraryEntry) => void;
  onCardContextMenu: (e: LibraryEntry, ev: React.MouseEvent) => void;
  page: number;
  totalPages: number;
  rangeLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onPage: (n: number) => void;
  addOpen: boolean;
  onToggleAdd: () => void;
  onCloseAdd: () => void;
  urlValue: string;
  onUrlInput: (v: string) => void;
  onAddUrl: () => void;
  onBrowse: () => void;
  savePicker: boolean;
  onToggleSave: () => void;
  zones: Zone[];
  onSaveZone: (id: string) => void;
  dragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const p = props;
  return (
    <>
      {/* header */}
      <div className="relative z-10 flex flex-shrink-0 items-start justify-between gap-4 border-b border-[var(--color-border)] px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles size={17} className="text-[var(--color-accent)]" />
            <span className="text-[16px] font-bold tracking-tight">Zone Library</span>
          </div>
          <div className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">Install a curated assistant, or import your own.</div>
        </div>
        <div className="relative flex flex-shrink-0 items-center gap-2">
          {/* Save a zone */}
          <div className="relative">
            <button
              onClick={p.onToggleSave}
              disabled={p.zones.length === 0}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[12.5px] font-medium transition hover:bg-[var(--color-panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Bookmark size={13} /> Save a zone…
            </button>
            {p.savePicker && (
              <>
                <div className="fixed inset-0 z-40" onClick={p.onToggleSave} />
                <div className="absolute right-0 top-9 z-50 max-h-72 min-w-[210px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-xl">
                  {p.zones.map((z) => {
                    const Icon = getZoneIcon(z.icon);
                    return (
                      <button key={z.id} onClick={() => p.onSaveZone(z.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]">
                        <span className="flex h-4 w-4 items-center justify-center rounded" style={{ background: z.accentColor ?? "var(--color-accent)" }}>
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
          {/* Add zones */}
          <div className="relative">
            <button
              onClick={p.onToggleAdd}
              className={`flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-semibold transition ${
                p.addOpen ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]" : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
              }`}
            >
              <Download size={13} /> Add zones <ChevronDown size={12} />
            </button>
            {p.addOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={p.onCloseAdd} />
                <div className="absolute right-0 top-10 z-50 w-[340px] rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-2xl">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-[13px] font-semibold">Add a zone to your library</span>
                    <button onClick={p.onCloseAdd} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"><X size={13} /></button>
                  </div>
                  <div
                    onDragOver={p.onDragOver}
                    onDragLeave={p.onDragLeave}
                    onDrop={p.onDrop}
                    onClick={p.onBrowse}
                    className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-3 py-4 text-center transition ${
                      p.dragOver ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10" : "border-[var(--color-border)] hover:bg-[var(--color-panel-hover)]"
                    }`}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-accent)]/15 text-[var(--color-accent)]"><Upload size={17} /></span>
                    <span className="text-[12.5px] font-medium">Drop a zone <span className="font-mono text-[11px] text-[var(--color-text-muted)]">.json</span> here</span>
                    <span className="text-[11.5px] text-[var(--color-text-muted)]">or <span className="font-medium text-[var(--color-accent)]">browse files</span></span>
                  </div>
                  <div className="my-3 flex items-center gap-2.5">
                    <div className="h-px flex-1 bg-[var(--color-border)]" />
                    <span className="text-[10px] font-semibold tracking-wider text-[var(--color-text-muted)]">OR PASTE A LINK</span>
                    <div className="h-px flex-1 bg-[var(--color-border)]" />
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={p.urlValue}
                      onChange={(e) => p.onUrlInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") p.onAddUrl(); }}
                      placeholder="https://…/zone.json"
                      className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
                    />
                    <button onClick={p.onAddUrl} className="flex h-9 items-center rounded-lg bg-[var(--color-accent)] px-4 text-[12.5px] font-semibold text-white hover:opacity-90">Add</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* scroll content */}
      <div onDragOver={p.onDragOver} onDragLeave={p.onDragLeave} onDrop={p.onDrop} className="relative flex-1 overflow-y-auto px-6 py-5">
        <SectionLabel>Curated</SectionLabel>
        {p.pageAvailable.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg)]/40 px-4 py-4 text-[12.5px] text-[var(--color-text-muted)]">
            All curated zones are installed — they're in “Saved by you” below.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3.5">
            {p.pageAvailable.map((e) => (
              <ZoneCard key={e.id} entry={e} installed={p.isInstalled(e)} canInstall={p.canInstall} busy={p.busy}
                onOpen={() => p.onOpen(e)} onInstall={() => p.onInstall(e)} onConfigure={() => p.onConfigure(e)} />
            ))}
          </div>
        )}

        <div className="mt-6"><SectionLabel>Saved by you</SectionLabel></div>
        {p.yours.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg)]/40 px-4 py-4 text-[12.5px] text-[var(--color-text-muted)]">
            Nothing here yet — install a curated zone, snapshot one with “Save a zone…”, or import a <span className="font-mono text-[11px]">.json</span>. Right-click a zone for edit / rename / export / delete.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3.5">
            {p.yours.map((e) => (
              <ZoneCard key={e.id} entry={e} installed={p.isInstalled(e)} canInstall={p.canInstall} busy={p.busy} compact
                onOpen={() => p.onOpen(e)} onInstall={() => p.onInstall(e)} onConfigure={() => p.onConfigure(e)}
                onContextMenu={(ev) => p.onCardContextMenu(e, ev)} />
            ))}
          </div>
        )}

        {p.dragOver && (
          <div className="pointer-events-none absolute inset-2.5 z-30 flex flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent)]/10 backdrop-blur-[1px]">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-accent)] text-white"><Download size={24} /></span>
            <span className="text-sm font-semibold text-[var(--color-accent)]">Drop to add a zone to your library</span>
          </div>
        )}
      </div>

      {/* pagination */}
      <div className="flex h-12 flex-shrink-0 items-center justify-between border-t border-[var(--color-border)] px-6">
        <div className="text-[11.5px] text-[var(--color-text-muted)]">{p.rangeLabel}</div>
        <div className="flex items-center gap-1.5">
          <PageBtn disabled={p.page === 0} onClick={p.onPrev}><ChevronLeft size={15} /></PageBtn>
          {Array.from({ length: p.totalPages }, (_, i) => (
            <button
              key={i}
              onClick={() => p.onPage(i)}
              className={`flex h-7 min-w-[28px] items-center justify-center rounded-md px-2 text-[12.5px] font-semibold transition ${
                i === p.page ? "bg-[var(--color-text)] text-[var(--color-bg)]" : "border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
              }`}
            >
              {i + 1}
            </button>
          ))}
          <PageBtn disabled={p.page >= p.totalPages - 1} onClick={p.onNext}><ChevronRight size={15} /></PageBtn>
        </div>
      </div>
    </>
  );
}

function PageBtn({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-hover)] disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{children}</div>;
}

function ZoneCard({
  entry, installed, canInstall, busy, compact, onOpen, onInstall, onConfigure, onContextMenu,
}: {
  entry: LibraryEntry;
  installed: boolean;
  canInstall: boolean;
  busy: boolean;
  compact?: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onConfigure: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const Icon = getZoneIcon(entry.icon);
  const accent = entry.accentColor ?? "var(--color-accent)";
  const tools = parseTools(entry.toolsEnabled);
  const shown = tools.slice(0, 3);
  const stop = (e: React.MouseEvent, fn: () => void) => { e.stopPropagation(); fn(); };

  return (
    <div
      onClick={onOpen}
      onContextMenu={onContextMenu}
      className={`relative flex cursor-pointer flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-4 transition hover:-translate-y-0.5 hover:border-[var(--color-accent)]/50 hover:shadow-lg ${compact ? "min-h-[188px]" : "min-h-[230px]"}`}
    >
      {installed && (
        <span className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10.5px] font-semibold text-green-500">
          <Check size={11} /> Installed
        </span>
      )}
      {!installed && !entry.curated && (
        <span className="absolute right-3 top-3 rounded-full bg-[var(--color-accent)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent)]">Imported</span>
      )}

      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl shadow-sm" style={{ background: accent }}>
        <Icon size={21} color="white" />
      </span>
      <div className="mb-1 text-[14px] font-semibold tracking-tight" style={{ color: accent }}>{entry.name}</div>
      <div className="text-[12px] leading-snug text-[var(--color-text-muted)]" style={{ display: "-webkit-box", WebkitLineClamp: compact ? 2 : 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {entry.description || (entry.systemPrompt ?? "").replace(/\s+/g, " ").trim() || "No description."}
      </div>

      {!compact && shown.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {shown.map((t) => (
            <span key={t} className="whitespace-nowrap rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10.5px] text-[var(--color-text-muted)]">{toolLabel(t)}</span>
          ))}
          {tools.length > 3 && <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10.5px] text-[var(--color-text-muted)]">+{tools.length - 3}</span>}
        </div>
      )}

      <div className="flex-1" />
      {installed ? (
        <button onClick={(e) => stop(e, onConfigure)} className="mt-3 flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] text-[12.5px] font-semibold transition hover:bg-[var(--color-panel-hover)]">
          <SettingsIcon size={14} /> Configure
        </button>
      ) : (
        <button
          onClick={(e) => stop(e, onInstall)}
          disabled={!canInstall || busy}
          className="mt-3 flex h-9 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: accent }}
        >
          <Download size={14} /> Install
        </button>
      )}
    </div>
  );
}

// ─── Editor view (embedded zone form) ───────────────────────────────────────

function EditorView({
  zone, providers, isDefault, onToggleDefault, onBack, onSaved, onDeleted,
}: {
  zone: Zone | null;
  providers: Provider[];
  isDefault: boolean;
  onToggleDefault: () => void;
  onBack: () => void;
  onSaved: (z: Zone) => void;
  onDeleted: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--color-border)] px-6 py-3">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]">
          <ChevronLeft size={15} /> Zone Library
        </button>
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-semibold">{zone ? "Edit zone" : "New zone"}</span>
          {zone && (
            <button
              onClick={onToggleDefault}
              title={isDefault ? "This is the default zone for new chats" : "Make this the default zone for new chats"}
              className={`flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition ${
                isDefault ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
              }`}
            >
              <Star size={13} className={isDefault ? "fill-current" : ""} /> {isDefault ? "Default" : "Make default"}
            </button>
          )}
        </div>
      </div>
      <ZoneForm zone={zone} providers={providers} onSaved={onSaved} onDeleted={onDeleted} />
    </div>
  );
}

// ─── Detail view ────────────────────────────────────────────────────────────

function DetailView({
  entry, installed, canInstall, busy, onBack, onInstall, onConfigure, onUninstall, onDelete,
}: {
  entry: LibraryEntry;
  installed: boolean;
  canInstall: boolean;
  busy: boolean;
  onBack: () => void;
  onInstall: () => void;
  onConfigure: () => void;
  onUninstall: () => void;
  onDelete: () => void;
}) {
  const Icon = getZoneIcon(entry.icon);
  const accent = entry.accentColor ?? "var(--color-accent)";
  const tools = parseTools(entry.toolsEnabled);
  const meta = [entry.author, entry.version, entry.source].filter(Boolean).join("   ·   ");

  return (
    <>
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--color-border)] px-6 py-3">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]">
          <ChevronLeft size={15} /> Zone Library
        </button>
        <div className="flex items-center gap-2">
          {!entry.curated && (
            <button onClick={onDelete} disabled={busy} className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[12.5px] font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50">
              <Trash2 size={13} /> Remove
            </button>
          )}
          {installed ? (
            <button onClick={onUninstall} disabled={busy} className="group flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3.5 text-[12.5px] font-semibold text-green-500 transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50">
              <Check size={14} /> <span className="group-hover:hidden">Installed</span><span className="hidden group-hover:inline">Uninstall</span>
            </button>
          ) : (
            <button onClick={onInstall} disabled={!canInstall || busy} className="flex h-8 items-center gap-1.5 rounded-lg px-4 text-[12.5px] font-bold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50" style={{ background: accent }}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Install zone
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-4 flex items-start gap-4">
          <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl shadow-md" style={{ background: accent }}>
            <Icon size={28} color="white" />
          </span>
          <div className="min-w-0 pt-0.5">
            <div className="text-[21px] font-bold tracking-tight">{entry.name}</div>
            {meta && <div className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">{meta}</div>}
          </div>
        </div>

        <div className="max-w-[640px] text-[14px] leading-relaxed text-[var(--color-text)]">{entry.description || "—"}</div>

        {tools.length > 0 && (
          <>
            <DetailLabel>Tools</DetailLabel>
            <div className="flex flex-wrap gap-2">
              {tools.map((t) => (
                <span key={t} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50 px-2.5 py-1 text-[12px]">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
                  {toolLabel(t)}
                </span>
              ))}
            </div>
          </>
        )}

        {entry.systemPrompt && (
          <>
            <DetailLabel>Instructions</DetailLabel>
            <div className="relative max-h-40 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-4">
              <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-[var(--color-text-muted)]">{entry.systemPrompt}</pre>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-[var(--color-panel)]" />
            </div>
          </>
        )}

        {entry.examples.length > 0 && (
          <>
            <DetailLabel>Example prompts</DetailLabel>
            <div className="flex max-w-[640px] flex-col gap-2">
              {entry.examples.map((ex, i) => (
                <div key={i} className="flex items-start gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-3 py-2.5">
                  <MessageSquare size={15} className="mt-0.5 flex-shrink-0 text-[var(--color-text-muted)]" />
                  <span className="text-[13px] leading-snug">{ex}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="mt-6 flex flex-wrap gap-x-8 gap-y-4 border-t border-[var(--color-border)] pt-4">
          <MetaCell label="Model" value={entry.model || "Default model"} mono />
          <MetaCell label="Source" value={entry.source || "—"} />
          <MetaCell label="Author" value={entry.author || "—"} />
          <MetaCell label="Version" value={entry.version || "—"} />
        </div>
      </div>
    </>
  );
}

function DetailLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 mt-6 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{children}</div>;
}

function MetaCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={`mt-1 text-[12.5px] ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
