import { useEffect, useState } from "react";
import { Play, Pencil, Trash2, Plus } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { reportError } from "@/lib/reportError";
import type { ScheduleInput, ScheduledRun } from "@/lib/types";
import { Field, SettingSelect } from "../controls";
import { ToggleRow } from "@/components/common/Toggle";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INPUT = "w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";

/** `datetime-local` wants local wall-clock time without a zone. */
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

function describe(r: ScheduledRun): string {
  const days: number[] = r.weekdays ? JSON.parse(r.weekdays) : [];
  switch (r.repeat) {
    case "interval": return `Every ${r.intervalMinutes} min`;
    case "daily": return `Daily at ${r.timeOfDay}`;
    case "weekly": return `${days.map((d) => DAYS[d]).join(", ")} at ${r.timeOfDay}`;
    default: return "Once";
  }
}

function blank(): ScheduleInput {
  return {
    name: "",
    prompt: "",
    target: "new_chat",
    repeat: "daily",
    timeOfDay: "12:00",
    weekdays: [1, 2, 3, 4, 5],
    intervalMinutes: 60,
    runAt: Date.now() + 60 * 60_000,
    enabled: true,
  };
}

/**
 * Scheduled runs (0.18): prompts sent on a clock — into a fresh chat each
 * time, or appended to one chat. The same runs an agent creates with
 * `schedule_run` are listed and editable here.
 */
export function SchedulesTab() {
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [draft, setDraft] = useState<ScheduleInput | null>(null);
  const zones = useApp((s) => s.zones);
  const projects = useApp((s) => s.projects);
  const chats = useApp((s) => s.chats);
  const closeToTray = useApp((s) => s.appSettings.closeToTray);

  useEffect(() => {
    const load = () => api.listScheduledRuns().then(setRuns).catch(reportError("Couldn't load scheduled runs"));
    load();
    const un = api.onSchedulesChanged(load);
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);

  function edit(r: ScheduledRun) {
    setDraft({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      target: r.target,
      chatId: r.chatId,
      zoneId: r.zoneId,
      projectId: r.projectId,
      watchChatId: r.watchChatId,
      repeat: r.repeat,
      intervalMinutes: r.intervalMinutes ?? 60,
      timeOfDay: r.timeOfDay ?? "12:00",
      weekdays: r.weekdays ? JSON.parse(r.weekdays) : [1, 2, 3, 4, 5],
      runAt: r.nextRunAt ?? Date.now() + 60 * 60_000,
      enabled: r.enabled,
    });
  }

  async function save() {
    if (!draft) return;
    try {
      await api.upsertScheduledRun(draft);
      setDraft(null);
    } catch (e) {
      reportError("Couldn't save the scheduled run")(e);
    }
  }

  const set = (patch: Partial<ScheduleInput>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const chatTitle = (id: string | null) => chats.find((c) => c.id === id)?.title ?? "a deleted chat";

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Scheduled runs</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">Prompts sent on a clock. They run only while MultiZone is running{closeToTray ? " (the tray counts)" : ""}.</p>
        {!draft && (
          <button
            onClick={() => setDraft(blank())}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
          >
            <Plus size={14} /> New scheduled run
          </button>
        )}
      </section>

      {draft && (
        <section className="rounded border border-[var(--color-border)] p-3">
          <Field label="Name">
            <input className={INPUT} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Inbox sweep" />
          </Field>
          <Field label="Prompt">
            <textarea
              className={`${INPUT} min-h-[90px]`}
              value={draft.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder="Check my inbox for anything that needs a reply today and summarise it."
            />
          </Field>

          <Field label="When">
            <SettingSelect value={draft.repeat ?? "once"} onChange={(v) => set({ repeat: v })}>
              <option value="once">Once</option>
              <option value="interval">Every N minutes</option>
              <option value="daily">Every day</option>
              <option value="weekly">On certain days</option>
            </SettingSelect>
          </Field>
          {(draft.repeat === "once" || draft.repeat === "interval") && (
            <Field label={draft.repeat === "once" ? "At" : "Starting at"}>
              <input
                type="datetime-local"
                className={INPUT}
                value={toLocalInput(draft.runAt ?? Date.now())}
                onChange={(e) => set({ runAt: new Date(e.target.value).getTime() })}
              />
            </Field>
          )}
          {draft.repeat === "interval" && (
            <Field label="Every (minutes)">
              <input
                type="number"
                min={1}
                className={INPUT}
                value={draft.intervalMinutes ?? 60}
                onChange={(e) => set({ intervalMinutes: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
              />
            </Field>
          )}
          {(draft.repeat === "daily" || draft.repeat === "weekly") && (
            <Field label="Time">
              <input type="time" className={INPUT} value={draft.timeOfDay ?? "12:00"} onChange={(e) => set({ timeOfDay: e.target.value })} />
            </Field>
          )}
          {draft.repeat === "weekly" && (
            <div className="mb-2 flex flex-wrap gap-1">
              {DAYS.map((d, i) => {
                const on = draft.weekdays?.includes(i) ?? false;
                return (
                  <button
                    key={d}
                    onClick={() => set({ weekdays: on ? (draft.weekdays ?? []).filter((x) => x !== i) : [...(draft.weekdays ?? []), i] })}
                    className={`rounded border px-2 py-1 text-xs ${on ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          )}

          <Field label="Where">
            <SettingSelect value={draft.target ?? "new_chat"} onChange={(v) => set({ target: v })}>
              <option value="new_chat">Start a new chat each time</option>
              <option value="chat">Add to an existing chat</option>
            </SettingSelect>
          </Field>
          {draft.target === "chat" ? (
            <Field label="Chat">
              <SettingSelect value={draft.chatId ?? ""} onChange={(v) => set({ chatId: v || null })}>
                <option value="">— choose a chat —</option>
                {chats.filter((c) => !c.initiatedByZoneId).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </SettingSelect>
            </Field>
          ) : (
            <>
              <Field label="Zone">
                <SettingSelect value={draft.zoneId ?? ""} onChange={(v) => set({ zoneId: v || null })}>
                  <option value="">— the default —</option>
                  {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                </SettingSelect>
              </Field>
              <Field label="Project">
                <SettingSelect value={draft.projectId ?? ""} onChange={(v) => set({ projectId: v || null })}>
                  <option value="">— none —</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </SettingSelect>
              </Field>
              <Field label="Report on a chat (optional)">
                <SettingSelect value={draft.watchChatId ?? ""} onChange={(v) => set({ watchChatId: v || null })}>
                  <option value="">— none —</option>
                  {chats.filter((c) => !c.initiatedByZoneId).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </SettingSelect>
              </Field>
              <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">Each run sees that chat's latest messages.</p>
            </>
          )}
          <ToggleRow label="Enabled" checked={draft.enabled ?? true} onChange={(v) => set({ enabled: v })} />
          <div className="mt-3 flex gap-2">
            <button
              onClick={save}
              disabled={!draft.prompt.trim()}
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
            {runs.map((r) => (
              <li key={r.id} className="rounded border border-[var(--color-border)] p-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {r.name}
                      {!r.enabled && <span className="ml-2 text-[11px] font-normal text-[var(--color-text-muted)]">(off)</span>}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {describe(r)} · next {when(r.nextRunAt)} ·{" "}
                      {r.target === "chat" ? `adds to “${chatTitle(r.chatId)}”` : "new chat"}
                      {r.watchChatId && ` · reports on “${chatTitle(r.watchChatId)}”`}
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-[var(--color-text-muted)]">{r.prompt}</div>
                    {r.lastRunAt && (
                      <div className={`mt-1 text-[11px] ${r.lastError ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}>
                        Last ran {when(r.lastRunAt)}{r.lastError ? ` — failed: ${r.lastError}` : ""}
                      </div>
                    )}
                  </div>
                  <button title="Run now" onClick={() => api.runScheduledNow(r.id).catch(reportError("Couldn't start the run"))} className="rounded p-1 hover:bg-[var(--color-panel-hover)]">
                    <Play size={14} />
                  </button>
                  <button title="Edit" onClick={() => edit(r)} className="rounded p-1 hover:bg-[var(--color-panel-hover)]">
                    <Pencil size={14} />
                  </button>
                  <button title="Delete" onClick={() => api.deleteScheduledRun(r.id).catch(reportError("Couldn't delete the run"))} className="rounded p-1 hover:bg-[var(--color-panel-hover)]">
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
