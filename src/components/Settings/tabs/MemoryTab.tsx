import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { reportError } from "@/lib/reportError";
import { NumberField } from "../controls";

export function MemoryTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const memories = useApp((s) => s.memories);
  const refreshMemories = useApp((s) => s.refreshMemories);
  const projects = useApp((s) => s.projects);
  const chats = useApp((s) => s.chats);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    refreshMemories().catch(reportError("Couldn't load memories"));
    const un = api.onMemoryUpdated(() => refreshMemories().catch(reportError("Couldn't load memories")));
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [refreshMemories]);

  const scopeLabel = (m: { scope: string; scopeId: string | null }) => {
    if (m.scope === "global") return "Global";
    if (m.scope === "project") {
      const p = projects.find((x) => x.id === m.scopeId);
      return `Project · ${p?.name ?? "unknown"}`;
    }
    const c = chats.find((x) => x.id === m.scopeId);
    return `Chat · ${c?.title ?? "unknown"}`;
  };

  async function saveEdit(id: string) {
    const m = memories.find((x) => x.id === id);
    if (!m) return;
    await api.upsertMemory({ id, scope: m.scope, scopeId: m.scopeId, content: draft });
    setEditingId(null);
    await refreshMemories();
  }

  async function remove(id: string) {
    await api.deleteMemory(id);
    await refreshMemories();
  }

  const limit = typeof appSettings.memoryScopeLimit === "number" ? appSettings.memoryScopeLimit : 50;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Memory</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">Facts zones with the <span className="font-mono">Memory</span> tool save, shown to them every turn.</p>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-text-muted)]">Max entries per scope</span>
          <NumberField value={limit} min={1} onCommit={(v) => setAppSettings({ memoryScopeLimit: v })} />
        </div>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">Oldest entries in a scope are trimmed once it exceeds this.</p>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Stored memories ({memories.length})</h3>
        {memories.length === 0 ? (
          <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
            No memories yet.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {memories.map((m) => (
              <div key={m.id} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
                    {scopeLabel(m)}
                  </span>
                  <div className="flex items-center gap-1">
                    {editingId === m.id ? (
                      <>
                        <button onClick={() => saveEdit(m.id)} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-panel-hover)]">Save</button>
                        <button onClick={() => setEditingId(null)} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => { setEditingId(m.id); setDraft(m.content); }} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Edit</button>
                    )}
                    <button onClick={() => remove(m.id)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Delete">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                {editingId === m.id ? (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
                  />
                ) : (
                  <div className="text-xs text-[var(--color-text)]">{m.content}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// The Search tab was removed at 0.12.4. It had held no settings since the
// keyless search tools landed at 1.0 — just prose explaining that there was
// nothing to configure, which is not what a Settings pane is for. The tools are
// enabled per zone in the zone editor, and a paid provider is an MCP server.

// ─── API ──────────────────────────────────────────────────────────────────────
