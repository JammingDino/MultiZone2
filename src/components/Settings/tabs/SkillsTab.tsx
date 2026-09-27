import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, RefreshCw, Folder, FolderOpen, Copy, Check, FileUp, FileDown } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { saveTextFile } from "@/lib/saveFile";
import { type SkillSeed, serializeSkill, parseSkill } from "@/lib/skillFile";
import type { Skill, SkillPack } from "@/lib/types";
import { PRIMARY_ACTION } from "@/lib/chrome";
import { ErrorNote } from "@/components/common/ErrorNote";
import { reportError } from "@/lib/reportError";

export function SkillsTab() {
  const skills = useApp((s) => s.skills);
  const zones = useApp((s) => s.zones);
  const refreshSkills = useApp((s) => s.refreshSkills);
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [creating, setCreating] = useState<SkillSeed | null>(null);

  useEffect(() => { refreshSkills().catch(reportError("Couldn't load skills")); }, [refreshSkills]);

  async function importFile(file: File) {
    const raw = await file.text();
    const fallbackName = file.name.replace(/\.(md|markdown|txt)$/i, "");
    const parsed = parseSkill(raw, fallbackName);
    setEditing(null);
    setCreating(parsed);
  }

  async function toggle(s: Skill) {
    await api.setSkillEnabled(s.id, !s.enabled);
    await refreshSkills();
  }

  async function remove(s: Skill) {
    await api.deleteSkill(s.id);
    await refreshSkills();
  }

  // Skills a zone wrote itself and that the user hasn't looked at yet. Sorted to
  // the top so the review queue is the first thing on the page.
  const pendingReview = skills.filter((s) => s.authoredByZoneId && !s.enabled);
  const sortedSkills = [...skills].sort((a, b) => {
    const aPending = a.authoredByZoneId && !a.enabled ? 0 : 1;
    const bPending = b.authoredByZoneId && !b.enabled ? 0 : 1;
    return aPending - bPending || a.name.localeCompare(b.name);
  });
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? "a zone";

  if (editing || creating) {
    return (
      <SkillEditor
        skill={editing}
        seed={creating}
        onDone={async () => { setEditing(null); setCreating(null); await refreshSkills(); }}
        onCancel={() => { setEditing(null); setCreating(null); }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="mb-1 text-sm font-medium">Skills</h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          On-demand instruction sets. A zone with the <span className="font-mono">Skills</span> tool sees
          every enabled skill's description and loads the full text itself when one matches — so write
          the description as the use case that should trigger it.
        </p>
      </section>

      <div className="flex gap-2">
        <button
          onClick={() => { setEditing(null); setCreating({ name: "", description: "", content: "" }); }}
          className="flex items-center gap-1.5 rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} /> New skill
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <FileUp size={12} /> Import .md
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }}
        />
      </div>

      {/* Self-authored drafts (0.9.2): a zone wrote these itself via `create_skill`.
          They are created disabled and enter no agent's catalog until reviewed, so
          surface them here rather than letting them sit unnoticed in the list. */}
      {pendingReview.length > 0 && (
        <div className="rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 p-3 text-xs">
          <div className="font-medium">
            {pendingReview.length === 1
              ? "1 skill written by a zone is waiting for your review"
              : `${pendingReview.length} skills written by zones are waiting for your review`}
          </div>
          <div className="mt-0.5 text-[var(--color-text-muted)]">
            They are disabled — no agent can load them until you enable them below.
          </div>
        </div>
      )}

      {skills.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
          No skills yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sortedSkills.map((s) => (
            <div
              key={s.id}
              className={`rounded border bg-[var(--color-bg)] p-3 ${
                s.authoredByZoneId && !s.enabled
                  ? "border-[var(--color-accent)]/40"
                  : "border-[var(--color-border)]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {!s.enabled && (
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">disabled</span>
                    )}
                    {s.authoredByZoneId && (
                      <span
                        className="rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--color-accent)]"
                        title={`Written by the ${zoneName(s.authoredByZoneId)} zone on ${new Date(s.createdAt * 1000).toLocaleDateString()} — review before enabling`}
                      >
                        written by {zoneName(s.authoredByZoneId)}
                      </span>
                    )}
                  </div>
                  {s.description && <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{s.description}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => toggle(s)}
                    title={s.enabled ? "Enabled — click to remove from the agent catalog" : "Disabled — click to offer to agents"}
                    className={`relative h-5 w-9 rounded-full transition-colors ${s.enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
                  >
                    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${s.enabled ? "translate-x-4" : ""}`} />
                  </button>
                  <button onClick={() => { setCreating(null); setEditing(s); }} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Edit</button>
                  <button onClick={() => remove(s)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Delete">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <SkillPacksSection />
    </div>
  );
}

/**
 * Folder-backed skills (0.9.9). The ecosystem publishes skills as directories —
 * `SKILL.md` plus reference pages and scripts — installed by a CLI rather than
 * pasted in. MultiZone scans for those trees and offers them to agents next to
 * the skills written above; `load_skill` serves the sub-files, so a zone needs
 * no filesystem tools to read one.
 *
 * Read-only by design: the installer owns the tree and its `update` command
 * overwrites it, so an edit made here would vanish on the next update.
 */
function SkillPacksSection() {
  const packs = useApp((s) => s.skillPacks);
  const refreshSkillPacks = useApp((s) => s.refreshSkillPacks);
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const [root, setRoot] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const extraDirs = appSettings.skillPackDirs ?? [];

  useEffect(() => {
    refreshSkillPacks().catch(reportError("Couldn't load skill packs"));
    api.skillPacksRoot().then(setRoot).catch(reportError("Couldn't find the skill packs folder"));
  }, [refreshSkillPacks]);

  async function togglePack(pack: SkillPack) {
    const disabled = appSettings.disabledSkillPacks ?? [];
    const next = pack.enabled
      ? [...disabled, pack.name]
      : disabled.filter((n) => n.toLowerCase() !== pack.name.toLowerCase());
    await setAppSettings({ disabledSkillPacks: next });
    await refreshSkillPacks();
  }

  async function addFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    if (extraDirs.some((d) => d === selected)) return;
    await setAppSettings({ skillPackDirs: [...extraDirs, selected] });
    await refreshSkillPacks();
  }

  async function removeFolder(dir: string) {
    await setAppSettings({ skillPackDirs: extraDirs.filter((d) => d !== dir) });
    await refreshSkillPacks();
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }

  // The install line is the whole point of the help panel, so it carries the
  // real path rather than a placeholder the user has to substitute.
  const installTarget = root || "<skills folder>";

  return (
    <section className="mt-2 border-t border-[var(--color-border)] pt-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Installed skill folders</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => refreshSkillPacks().catch(reportError("Couldn't load skill packs"))}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
            title="Rescan the folders below"
          >
            <RefreshCw size={11} /> Rescan
          </button>
          <button
            onClick={() => setShowHelp((v) => !v)}
            className="rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
          >
            {showHelp ? "Hide setup" : "How to install"}
          </button>
        </div>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Skills published as a folder — <span className="font-mono">SKILL.md</span> plus reference pages
        and scripts — installed by their own CLI. They join the catalog above; edit them where they
        were installed, not here.
      </p>

      {showHelp && (
        <div className="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-xs">
          <div className="mb-2 text-[var(--color-text-muted)]">
            Install into MultiZone's skills folder, then hit Rescan. Both of these publish an
            installer to npm; anything that writes a <span className="font-mono">SKILL.md</span> folder works
            the same way.
          </div>
          <div className="mb-1 font-medium">Impeccable (frontend design)</div>
          <CopyLine
            text={`cd "${installTarget}"\nnpx impeccable install -y --providers=claude --scope=project`}
            copied={copied === "impeccable"}
            onCopy={() => copy(`cd "${installTarget}"\nnpx impeccable install -y --providers=claude --scope=project`, "impeccable")}
          />
          <div className="mb-1 mt-3 font-medium">HyperFrames (video composition)</div>
          <CopyLine
            text={`cd "${installTarget}"\nnpx hyperframes skills install`}
            copied={copied === "hyperframes"}
            onCopy={() => copy(`cd "${installTarget}"\nnpx hyperframes skills install`, "hyperframes")}
          />
          <div className="mt-3 text-[var(--color-text-muted)]">
            The installers ask which coding tool you use — the answer only decides which folder name they
            write (<span className="font-mono">.claude/skills/</span>, <span className="font-mono">.agents/skills/</span>, …).
            MultiZone reads all of them, so pick any. You can also point it at a project you have already
            installed into with "Add folder" below, instead of installing twice.
          </div>
          <div className="mt-2 text-[var(--color-text-muted)]">
            Some skills shell out to their own scripts. Those steps only run for a zone that has the
            <span className="font-mono"> Terminal</span> or <span className="font-mono">Code execution</span>{" "}
            tool and a working Node install; without them an agent gets the instructions but not the scripts.
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {root && (
          <button
            onClick={() => api.openPath(root).catch(reportError("Couldn't open the folder"))}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            title={root}
          >
            <FolderOpen size={12} /> Open skills folder
          </button>
        )}
        <button
          onClick={addFolder}
          className="flex items-center gap-1.5 rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} /> Add folder
        </button>
      </div>

      {extraDirs.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {extraDirs.map((dir) => (
            <div key={dir} className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <Folder size={11} className="shrink-0" />
              <span className="truncate font-mono">{dir}</span>
              <button
                onClick={() => removeFolder(dir)}
                className="ml-auto shrink-0 rounded p-1 hover:text-[var(--color-danger)]"
                title="Stop scanning this folder"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {packs.length === 0 ? (
        <div className="mt-3 rounded border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
          No skill folders found. Install one into the skills folder, or add a folder that already has some.
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {packs.map((pack) => (
            <div key={pack.dir} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{pack.name}</span>
                    {pack.fileCount !== null && (
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                        {pack.fileCount} {pack.fileCount === 1 ? "file" : "files"}
                      </span>
                    )}
                    {!pack.enabled && (
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">disabled</span>
                    )}
                  </div>
                  {pack.description && (
                    <div className="mt-0.5 line-clamp-3 text-xs text-[var(--color-text-muted)]">{pack.description}</div>
                  )}
                  <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={pack.dir}>
                    {pack.dir}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => togglePack(pack)}
                    title={pack.enabled ? "Enabled — click to remove from the agent catalog" : "Disabled — click to offer to agents"}
                    className={`relative h-5 w-9 rounded-full transition-colors ${pack.enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
                  >
                    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${pack.enabled ? "translate-x-4" : ""}`} />
                  </button>
                  <button
                    onClick={() => api.openPath(pack.dir).catch(reportError("Couldn't open the folder"))}
                    className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                    title="Open folder"
                  >
                    <FolderOpen size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** A copyable shell snippet in the skill-folder setup panel. */
function CopyLine({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[11px]">{text}</pre>
      <button
        onClick={onCopy}
        className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        title="Copy"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function SkillEditor({
  skill,
  seed,
  onDone,
  onCancel,
}: {
  skill: Skill | null;
  seed: SkillSeed | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(skill?.name ?? seed?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? seed?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? seed?.content ?? "");
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const refreshSkills = useApp((s) => s.refreshSkills);

  async function onCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.upsertSkill({ id: skill?.id, name: name.trim(), description: description.trim() || null, content, enabled });
      onDone();
    } finally { setSaving(false); }
  }

  // An existing skill saves itself: this is a page of prose you scroll, and a
  // Save button at the bottom of one is a Save button you leave without pressing.
  useEffect(() => {
    if (!skill?.id || !name.trim()) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        await api.upsertSkill({ id: skill.id, name: name.trim(), description: description.trim() || null, content, enabled });
        await refreshSkills();
        setSaveError(null);
      } catch (e) {
        console.error("skill autosave failed", e);
        setSaveError(e);
      } finally { setSaving(false); }
    }, 600);
    return () => clearTimeout(timer);
  }, [skill?.id, name, description, content, enabled]);

  async function onExport() {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "skill";
    // Emit name/description as YAML frontmatter so a skill exported here
    // round-trips intact through importFile() on another machine — previously
    // only `content` was written and the description was lost on import.
    await saveTextFile(`${slug}.md`, serializeSkill(name, description, content), [
      { name: "Markdown", extensions: ["md"] },
    ]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{skill ? "Edit skill" : "New skill"}</h3>
        <button onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">← Back</button>
      </div>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Name</div>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" placeholder="e.g. frontend-design" />
      </label>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">
          Description <span className="ml-1 opacity-60">(the use case that should make an agent load this skill)</span>
        </div>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" placeholder="Use when the user asks to build, design, or review a web UI / frontend component…" />
      </label>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Instructions <span className="ml-1 opacity-60">(freeform markdown, returned when the agent loads the skill)</span></div>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" />
      </label>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <button
          onClick={() => setEnabled((v) => !v)}
          className={`relative h-5 w-9 rounded-full transition-colors ${enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
        >
          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${enabled ? "translate-x-4" : ""}`} />
        </button>
        <span>Enabled — offered to agents in the skills catalog</span>
      </label>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-3">
        {skill && (
          <button onClick={onExport} className="mr-auto flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
            <FileDown size={12} /> Export
          </button>
        )}
        {skill ? (
          <>
            {saveError ? (
              <ErrorNote error={saveError} context="Not saved" className="text-[11px] text-[var(--color-danger)]" />
            ) : (
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {saving ? "Saving…" : "Changes save as you make them"}
              </span>
            )}
            <button onClick={onDone} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Done</button>
          </>
        ) : (
          <>
            <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
            <button onClick={onCreate} disabled={saving || !name.trim()} className={`rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}>
              Create skill
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── MCP (Model Context Protocol) ───────────────────────────────────────────────
