import { useEffect, useRef, useState } from "react";
import { Download, FileUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { reportError } from "@/lib/reportError";
import { saveTextFile } from "@/lib/saveFile";
import { runParams, type RunParam, type SavedRun } from "@/lib/types";
import { runFileName, runFromFile, runToFile, templateGaps, type RunInput } from "@/lib/savedRunFile";
import { Field, SettingSelect } from "../controls";

const INPUT = "w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";
const SMALL = "min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]";

const blank = (): RunInput => ({ name: "", description: null, template: "", params: [], zoneId: null });

/**
 * Saved runs (0.15.4): a prompt with blanks — `{{name}}` placeholders, each a
 * parameter with a default — opened from ⌘K or the / menu. Written here, and
 * shared as one file. Agents manage the same runs through the API.
 */
export function SavedRunsTab() {
  const runs = useApp((s) => s.savedRuns);
  const refresh = useApp((s) => s.refreshSavedRuns);
  const zones = useApp((s) => s.zones);
  const [draft, setDraft] = useState<RunInput | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { refresh().catch(reportError("Couldn't load saved runs")); }, [refresh]);

  const set = (patch: Partial<RunInput>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setParam = (i: number, patch: Partial<RunParam>) =>
    setDraft((d) => (d ? { ...d, params: d.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) } : d));
  const zoneName = (id: string | null) => zones.find((z) => z.id === id)?.name ?? null;

  function edit(r: SavedRun) {
    setNote(null);
    setDraft({ id: r.id, name: r.name, description: r.description, template: r.template, params: runParams(r), zoneId: r.zoneId });
  }

  async function save() {
    if (!draft) return;
    try {
      // A row left without a name is a row nobody finished; it can't be filled in.
      await api.upsertSavedRun({ ...draft, params: draft.params.filter((p) => p.name.trim()).map((p) => ({ ...p, name: p.name.trim() })) });
      setDraft(null);
      await refresh();
    } catch (e) {
      reportError("Couldn't save the run")(e);
    }
  }

  async function remove(r: SavedRun) {
    try {
      await api.deleteSavedRun(r.id);
      if (draft?.id === r.id) setDraft(null);
      await refresh();
    } catch (e) {
      reportError("Couldn't delete the run")(e);
    }
  }

  async function exportRun(r: SavedRun) {
    const file = runToFile(r, runParams(r), zoneName(r.zoneId));
    await saveTextFile(runFileName(r.name), JSON.stringify(file, null, 2), [{ name: "Saved run", extensions: ["json"] }])
      .catch(reportError("Couldn't export the run"));
  }

  async function importFile(f: File) {
    try {
      const { input, missingZone } = runFromFile(await f.text(), zones, runs.map((r) => r.name));
      await api.upsertSavedRun(input);
      await refresh();
      setNote(`Imported “${input.name}”.${missingZone ? ` It named the zone “${missingZone}”, which isn't here, so it follows the chat's zone.` : ""}`);
    } catch (e) {
      setNote(`Not imported: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const gaps = draft ? templateGaps(draft.template, draft.params) : null;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Saved runs</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          A prompt with blanks to fill. Write <code>{"{{name}}"}</code> where a value goes and give it a default; open the run from ⌘K or by typing / in a chat.
        </p>
        <div className="flex flex-wrap gap-2">
          {!draft && (
            <button
              onClick={() => { setNote(null); setDraft(blank()); }}
              className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
            >
              <Plus size={14} /> New saved run
            </button>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
          >
            <FileUp size={14} /> Import…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }}
          />
        </div>
        {note && <p role="status" className="mt-2 text-xs text-[var(--color-text-muted)]">{note}</p>}
      </section>

      {draft && gaps && (
        <section className="rounded border border-[var(--color-border)] p-3">
          <Field label="Name">
            <input className={INPUT} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Release notes" />
          </Field>
          <Field label="Description (optional)">
            <input className={INPUT} value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value || null })} placeholder="Draft the notes for a tagged version" />
          </Field>
          <Field label="Prompt">
            <textarea
              className={`${INPUT} min-h-[110px] font-mono text-xs`}
              value={draft.template}
              onChange={(e) => set({ template: e.target.value })}
              placeholder={"Write the release notes for {{version}} from the commits since {{previous}}. Keep them {{tone}}."}
            />
          </Field>

          <div className="mb-1 text-xs text-[var(--color-text-muted)]">Parameters</div>
          {draft.params.length > 0 && (
            <div className="mb-2 flex flex-col gap-1.5" role="list" aria-label="Parameters">
              {draft.params.map((p, i) => (
                <div key={i} role="listitem" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto_auto] items-center gap-1.5">
                  <input className={`${SMALL} font-mono`} aria-label="Parameter name" placeholder="name" value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} />
                  <input className={SMALL} aria-label="Label" placeholder="Label" value={p.label ?? ""} onChange={(e) => setParam(i, { label: e.target.value || undefined })} />
                  <input className={SMALL} aria-label="Default" placeholder="Default" value={p.default ?? ""} onChange={(e) => setParam(i, { default: e.target.value || undefined })} />
                  <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                    <input type="checkbox" checked={!!p.required} onChange={(e) => setParam(i, { required: e.target.checked || undefined })} /> required
                  </label>
                  <button
                    aria-label={`Remove ${p.name || "parameter"}`}
                    onClick={() => set({ params: draft.params.filter((_, j) => j !== i) })}
                    className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            <button
              onClick={() => set({ params: [...draft.params, { name: "" }] })}
              className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 hover:border-[var(--color-accent)]"
            >
              <Plus size={11} /> Parameter
            </button>
            {gaps.missing.map((n) => (
              <button
                key={n}
                title="The prompt uses this blank but no parameter fills it"
                onClick={() => set({ params: [...draft.params, { name: n }] })}
                className="rounded border border-dashed border-[var(--color-accent)] px-2 py-1 font-mono text-[var(--color-accent)]"
              >
                + {`{{${n}}}`}
              </button>
            ))}
            {gaps.unused.length > 0 && (
              <span className="text-[var(--color-text-muted)]">Not in the prompt: {gaps.unused.join(", ")}</span>
            )}
          </div>

          <Field label="Zone">
            <SettingSelect value={draft.zoneId ?? ""} onChange={(v) => set({ zoneId: v || null })}>
              <option value="">— the chat's zone —</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </SettingSelect>
          </Field>
          <div className="mt-3 flex gap-2">
            <button
              onClick={save}
              disabled={!draft.name.trim() || !draft.template.trim()}
              className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              Save
            </button>
            <button onClick={() => setDraft(null)} className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm">
              Cancel
            </button>
          </div>
        </section>
      )}

      {runs.length > 0 && (
        <section>
          <ul className="flex flex-col gap-2">
            {runs.map((r) => {
              const params = runParams(r);
              const zone = zoneName(r.zoneId);
              return (
                <li key={r.id} className="rounded border border-[var(--color-border)] p-2.5">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{r.name}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">
                        {params.length ? params.map((p) => p.name).join(", ") : "no parameters"}
                        {zone && ` · ${zone}`}
                        {r.description && ` · ${r.description}`}
                      </div>
                      <div className="mt-1 line-clamp-2 font-mono text-[11px] text-[var(--color-text-muted)]">{r.template}</div>
                    </div>
                    <button title="Export as a file" aria-label={`Export ${r.name}`} onClick={() => void exportRun(r)} className="rounded p-1 hover:bg-[var(--color-panel-hover)]">
                      <Download size={14} />
                    </button>
                    <button title="Edit" aria-label={`Edit ${r.name}`} onClick={() => edit(r)} className="rounded p-1 hover:bg-[var(--color-panel-hover)]">
                      <Pencil size={14} />
                    </button>
                    <button title="Delete" aria-label={`Delete ${r.name}`} onClick={() => void remove(r)} className="rounded p-1 hover:bg-[var(--color-panel-hover)]">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
