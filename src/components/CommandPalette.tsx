import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  MessageSquare,
  Layers,
  Settings as SettingsIcon,
  FolderKanban,
  Sparkles,
  Plus,
  Play,
  PanelLeft,
  Keyboard,
  CornerDownLeft,
} from "lucide-react";
import { useApp } from "@/store/app";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useBackDismiss } from "@/lib/useBackDismiss";
import { useDialogFocus } from "@/lib/useDialogFocus";
import { getZoneIcon } from "@/lib/zoneIcons";
import * as api from "@/lib/tauri";
import { useZoneModel } from "@/lib/useZoneModel";
import { runParams, type SavedRun } from "@/lib/types";
import { TABS } from "@/components/Workspace/WorkspacePanel";
import { openSettingAt } from "@/components/Settings/SettingsSearch";
import { SETTINGS_INDEX } from "@/lib/settingsIndex.generated";
import { fuzzyMatch, scoreSetting } from "@/lib/settingsSearch";

const NAMES: Record<string, string> = { chat: "This chat", terminals: "Terminals", context: "Context" };
const WORKSPACE_TABS = TABS.map((t) => ({ ...t, name: NAMES[t.id] ?? t.label }));

/**
 * Command palette (0.15.1).
 *
 * Everything this app can do is a named thing behind a menu — a zone in the
 * library, a project in a panel, a skill in a settings tab, a chat in a list
 * that is now long enough to scroll. The palette is the one surface where all
 * of them are reachable by typing their name.
 *
 * Deliberately *not* message search: that is [`ChatSearch`], it hits the
 * database, and mixing "jump to a thing" with "find where something was said"
 * makes both slower to read. The palette offers to open it instead.
 */

type Item = {
  id: string;
  /** What the user types against. */
  label: string;
  /** Second line, and also matched — a zone's model, a chat's project. */
  detail?: string;
  group: string;
  icon: React.ReactNode;
  run: () => void;
  /** Its own matcher, in place of the label and detail. */
  score?: (query: string) => number | null;
};

/** The palette's match score (lower is better), or null; shared with Settings search. */
export function fuzzyScore(query: string, text: string): number | null {
  return fuzzyMatch(query, text)?.score ?? null;
}

export function CommandPalette() {
  const zoneModel = useZoneModel();
  const open = useApp((s) => s.commandPaletteOpen);
  const close = useApp((s) => s.closeCommandPalette);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const chats = useApp((s) => s.chats);
  const zones = useApp((s) => s.zones);
  const projects = useApp((s) => s.projects);
  const skills = useApp((s) => s.skills);
  const savedRuns = useApp((s) => s.savedRuns);
  const refreshSavedRuns = useApp((s) => s.refreshSavedRuns);
  const activeChatId = useApp((s) => s.activeChatId);
  // A saved run with parameters asks for them here before it starts (0.15.4).
  const [form, setForm] = useState<{ run: SavedRun; values: Record<string, string> } | null>(null);

  useDismissOnEscape(open, close);
  useBackDismiss(open, close);
  // Tab stays in the palette, and focus goes back where it was on close.
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef, open);

  // A palette always opens empty — it is a fresh question every time, and a
  // stale query is one the user has to clear before they can start.
  useEffect(() => {
    if (open) void refreshSavedRuns();
  }, [open, refreshSavedRuns]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // The input mounts with the overlay; focus on the next frame so it exists.
      const id = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(id);
    }
    // Cleared on close, not on open: a form left over would render for one
    // frame on the next open and take the focus the search box should get.
    setForm(null);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const s = useApp.getState();
    const go = (fn: () => void) => () => {
      close();
      fn();
    };
    const out: Item[] = [];

    out.push(
      { id: "act:new", label: "New chat", group: "Actions", icon: <Plus size={14} />,
        run: go(() => { s.triggerNewChat(null); void s.setActiveChat(null); }) },
      { id: "act:search", label: "Search messages", detail: "Find where something was said", group: "Actions", icon: <Search size={14} />,
        run: go(s.focusChatSearch) },
      { id: "act:settings", label: "Settings", group: "Actions", icon: <SettingsIcon size={14} />, run: go(s.openSettings) },
      { id: "act:settings-tab", label: "Show Settings as a tab", detail: "Dock it beside a chat", group: "Actions", icon: <SettingsIcon size={14} />, run: go(s.showSettingsTab) },
      { id: "act:zones", label: "Zone library", detail: "Configure zones", group: "Actions", icon: <Layers size={14} />, run: go(() => s.openZoneLibrary()) },
      { id: "act:projects", label: "Manage projects", group: "Actions", icon: <FolderKanban size={14} />, run: go(() => s.openProjectsPanel()) },
      { id: "act:sidebar", label: "Show / hide the sidebar", group: "Actions", icon: <PanelLeft size={14} />, run: go(s.toggleSidebar) },
      { id: "act:keys", label: "Keyboard shortcuts", group: "Actions", icon: <Keyboard size={14} />, run: go(s.openShortcutsHelp) },
      // Brings a closed workspace tab back, or forward if it is behind another.
      ...WORKSPACE_TABS.filter((t) => t.id !== "study").map((t) => ({
        id: `act:show:${t.id}`, label: `Show ${t.name}`, detail: t.title, group: "Actions", icon: t.icon,
        run: go(() => s.focusWorkspace(t.id)),
      })),
    );

    // Chats, most-recent first. Sub-agents and branches are included — they are
    // exactly the conversations that are hard to reach any other way — and named
    // by the chat they hang under so two "Research" rows are tellable apart.
    const titleById = new Map(chats.map((c) => [c.id, c.title]));
    for (const c of chats) {
      if (c.id === activeChatId) continue;
      const parent = c.parentChatId ? titleById.get(c.parentChatId) : null;
      const project = projects.find((p) => p.id === c.projectId)?.name;
      out.push({
        id: `chat:${c.id}`,
        label: c.title,
        detail: parent ? `in ${parent}` : project,
        group: "Chats",
        icon: <MessageSquare size={14} />,
        run: go(() => void s.setActiveChat(c.id)),
      });
    }

    // A zone in a palette means "start work here" — the one zone action worth a
    // keystroke. Editing it is the zone library, which is its own entry above.
    for (const z of zones) {
      const ZoneIcon = getZoneIcon(z.icon);
      out.push({
        id: `zone:${z.id}`,
        label: `New chat in ${z.name}`,
        detail: zoneModel(z),
        group: "Zones",
        icon: <ZoneIcon size={14} />,
        run: go(async () => {
          const chat = await api.createChat(z.id, null);
          await s.refreshChats();
          await s.setActiveChat(chat.id);
        }),
      });
    }

    // A saved run is a task worth repeating. Running it from here fills the
    // template with its defaults and opens a chat with the prompt staged — not
    // sent, because a run is kept *because* it worked once and seeing the
    // filled-in prompt is how you tell it still does.
    for (const r of savedRuns) {
      out.push({
        id: `run:${r.id}`,
        label: `Run: ${r.name}`,
        detail: r.description ?? undefined,
        group: "Saved runs",
        icon: <Play size={14} />,
        run: () => {
          const params = runParams(r);
          if (params.length === 0) return void startRun(r, {});
          setForm({ run: r, values: Object.fromEntries(params.map((p) => [p.name, p.default ?? ""])) });
        },
      });
    }

    // Skills are otherwise three clicks deep in a settings tab, and the thing
    // you actually want to do to one is turn it on or off.
    for (const sk of skills) {
      out.push({
        id: `skill:${sk.id}`,
        label: `${sk.enabled ? "Disable" : "Enable"} skill: ${sk.name}`,
        detail: sk.description ?? undefined,
        group: "Skills",
        icon: <Sparkles size={14} />,
        run: go(async () => {
          await api.setSkillEnabled(sk.id, !sk.enabled);
          await s.refreshSkills();
        }),
      });
    }

    // Every section of every Settings tab, opened scrolled to and highlighted.
    for (const e of SETTINGS_INDEX) {
      out.push({
        id: `setting:${e.tab}:${e.heading}`,
        label: `Settings › ${e.tabLabel} › ${e.heading}`,
        group: "Settings",
        icon: <SettingsIcon size={14} />,
        run: go(() => openSettingAt(e)),
        // By its section's words and options too, not only the name.
        score: (q) => scoreSetting(e, q),
      });
    }

    return out;
  }, [open, chats, zones, projects, skills, savedRuns, activeChatId, close]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return items.slice(0, 60);
    return items
      .map((it) => {
        if (it.score) {
          const s = it.score(q);
          return s === null ? null : { it, score: s };
        }
        // Score the label and the detail separately and keep the better of the
        // two, so a zone found by its model name still ranks on that match
        // rather than on a poor read of its title.
        const a = fuzzyScore(q, it.label);
        const b = it.detail ? fuzzyScore(q, it.detail) : null;
        const best = a === null ? b : b === null ? a : Math.min(a, b);
        return best === null ? null : { it, score: best + (b !== null && b < (a ?? Infinity) ? 3 : 0) };
      })
      .filter((r): r is { it: Item; score: number } => r !== null)
      .sort((x, y) => x.score - y.score)
      .slice(0, 60)
      .map((r) => r.it);
  }, [items, query]);

  useEffect(() => setCursor(0), [query]);

  // Keep the highlighted row on screen when moving through a long list.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor, results]);

  if (!open) return null;

  async function startRun(r: SavedRun, values: Record<string, string>) {
    close();
    try {
      const s = useApp.getState();
      const rendered = await api.renderSavedRun(r.id, values);
      const chat = await api.createChat(rendered.zoneId, null);
      await s.refreshChats();
      await s.setActiveChat(chat.id);
      s.setComposerDraft(rendered.prompt);
    } catch (e) {
      console.error("saved run failed", e);
    }
  }

  if (form) {
    const params = runParams(form.run);
    const blank = params.filter((p) => p.required && !form.values[p.name]?.trim()).map((p) => p.label || p.name);
    const submit = (e: React.FormEvent) => {
      e.preventDefault();
      if (!blank.length) void startRun(form.run, form.values);
    };
    return (
      <div className="mz-safe-overlay fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-[2px]" onMouseDown={close}>
        <form
          ref={panelRef as React.RefObject<HTMLFormElement & HTMLDivElement>}
          onSubmit={submit}
          onMouseDown={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={`Run ${form.run.name}`}
          className="flex max-h-[64vh] w-full max-w-xl flex-col gap-3 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-2xl"
        >
          <div className="flex items-center gap-2">
            <Play size={14} className="text-[var(--color-text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{form.run.name}</span>
          </div>
          {params.map((p, i) => (
            <label key={p.name} className="block">
              <span className="mb-1 block text-xs text-[var(--color-text-muted)]">
                {p.label || p.name}{p.required ? " *" : ""}
              </span>
              <input
                autoFocus={i === 0}
                value={form.values[p.name] ?? ""}
                onChange={(e) => setForm({ ...form, values: { ...form.values, [p.name]: e.target.value } })}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              {p.description && <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">{p.description}</span>}
            </label>
          ))}
          <div className="flex items-center gap-2">
            <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">
              {blank.length ? `Needs ${blank.join(", ")}` : "Opens a new chat with the prompt filled in, not sent."}
            </span>
            <button type="button" onClick={() => setForm(null)} className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm">
              Back
            </button>
            <button type="submit" disabled={blank.length > 0} className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50">
              Run
            </button>
          </div>
        </form>
      </div>
    );
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (results.length === 0 ? 0 : (c + 1) % results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (results.length === 0 ? 0 : (c - 1 + results.length) % results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[cursor]?.run();
    }
  }

  let lastGroup = "";

  return (
    <div
      className="mz-safe-overlay fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={close}
    >
      <div
        className="flex max-h-[64vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
          <Search size={15} className="text-[var(--color-text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Go to a chat, a zone, a setting…"
            aria-label="Command palette"
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-[var(--color-text-muted)]"
          />
        </div>

        {results.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
            Nothing matches “{query.trim()}”.
          </p>
        ) : (
          <ul ref={listRef} className="flex-1 overflow-y-auto py-1">
            {results.map((it, i) => {
              const header = it.group !== lastGroup ? it.group : null;
              lastGroup = it.group;
              const activeRow = i === cursor;
              return (
                <li key={it.id}>
                  {header && (
                    <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                      {header}
                    </p>
                  )}
                  <button
                    data-active={activeRow}
                    onMouseMove={() => setCursor(i)}
                    onClick={it.run}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition ${
                      activeRow ? "bg-[var(--color-panel-hover)]" : ""
                    }`}
                  >
                    <span className="shrink-0 text-[var(--color-text-muted)]">{it.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{it.label}</span>
                      {it.detail && (
                        <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                          {it.detail}
                        </span>
                      )}
                    </span>
                    {activeRow && (
                      <CornerDownLeft size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
