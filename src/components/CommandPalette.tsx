import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  MessageSquare,
  Layers,
  Settings as SettingsIcon,
  FolderKanban,
  Sparkles,
  Plus,
  PanelLeft,
  Keyboard,
  CornerDownLeft,
} from "lucide-react";
import { useApp } from "@/store/app";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { getZoneIcon } from "@/lib/zoneIcons";
import * as api from "@/lib/tauri";

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
};

/**
 * Subsequence match, the standard palette contract: the query's characters must
 * appear in order but not adjacently, so "nwc" finds "New chat" and "zonlib"
 * finds "Zone library".
 *
 * Returns a score (lower is better) or null for no match. Consecutive runs and
 * matches at a word boundary score better, which is what makes a short query
 * put the obvious answer first instead of whichever item happened to be built
 * earliest.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    // Distance from the previous match is the gap we skipped over.
    score += found - prevMatch - 1;
    // A match at the start of a word is worth more than one mid-word.
    const atBoundary = found === 0 || /[\s\-_/:]/.test(t[found - 1] ?? "");
    if (atBoundary) score -= 2;
    prevMatch = found;
    ti = found + 1;
  }
  // Prefer shorter targets when the match is otherwise equal, so "chat" ranks
  // "New chat" above "Show / hide the sidebar in a chat".
  return score + t.length * 0.01;
}

export function CommandPalette() {
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
  const activeChatId = useApp((s) => s.activeChatId);

  useDismissOnEscape(open, close);

  // A palette always opens empty — it is a fresh question every time, and a
  // stale query is one the user has to clear before they can start.
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // The input mounts with the overlay; focus on the next frame so it exists.
      const id = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(id);
    }
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
      { id: "act:zones", label: "Zone library", detail: "Configure zones", group: "Actions", icon: <Layers size={14} />, run: go(() => s.openZoneLibrary()) },
      { id: "act:projects", label: "Manage projects", group: "Actions", icon: <FolderKanban size={14} />, run: go(() => s.openProjectsPanel()) },
      { id: "act:sidebar", label: "Show / hide the sidebar", group: "Actions", icon: <PanelLeft size={14} />, run: go(s.toggleSidebar) },
      { id: "act:keys", label: "Keyboard shortcuts", group: "Actions", icon: <Keyboard size={14} />, run: go(s.openShortcutsHelp) },
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
        detail: z.model,
        group: "Zones",
        icon: <ZoneIcon size={14} />,
        run: go(async () => {
          const chat = await api.createChat(z.id, null);
          await s.refreshChats();
          await s.setActiveChat(chat.id);
        }),
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

    return out;
  }, [open, chats, zones, projects, skills, activeChatId, close]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return items.slice(0, 60);
    return items
      .map((it) => {
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
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={close}
    >
      <div
        className="flex max-h-[64vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
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
