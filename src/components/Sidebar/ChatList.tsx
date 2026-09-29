import { useMemo, useRef, useState } from "react";
import type { Chat, ChatTagLink } from "@/lib/types";
import { Pencil, Trash2, Sparkles, Loader2, FolderInput, FolderMinus, ChevronRight, ShieldAlert, History, FileText, FileType, Columns2, SquarePlus } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import { usePersistentSet } from "@/lib/uiState";
import { Popover, pointRect } from "@/components/common/Popover";
import { useChatExport } from "@/lib/useChatExport";
import { reportError } from "@/lib/reportError";

interface Props {
  chats: Chat[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Which project this list lives inside (null = ungrouped section). */
  projectId: string | null;
  /** Show this many top-level chats, then a "Show N more" row. */
  limit?: number;
}

/**
 * The sidebar's one row shape (0.18.1): projects, chats, branches and the
 * "show more" line are all this height and size, so the list reads as one
 * list rather than a stack of differently-sized ones.
 */
export const SIDEBAR_ROW = "group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm transition-colors";

/** The sidebar's one disclosure glyph: points right when closed, down when open. */
export function Disclosure({ open }: { open: boolean }) {
  return (
    <ChevronRight
      size={13}
      className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    />
  );
}

interface MenuState {
  chatId: string;
  x: number;
  y: number;
}

export function ChatList({ chats, activeId, onSelect, projectId, limit }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const { projects, refreshChats, setChatTitle, regenerateTitle, setChatProject } = useApp(
    useShallow((s) => ({
      projects: s.projects,
      refreshChats: s.refreshChats,
      setChatTitle: s.setChatTitle,
      regenerateTitle: s.regenerateTitle,
      setChatProject: s.setChatProject,
    })),
  );
  const zones = useApp((s) => s.zones);
  const regenerating = useApp((s) => s.regeneratingTitles);
  const pendingApprovalByChat = useApp((s) => s.pendingApprovalByChat);
  const chatTagLinks = useApp((s) => s.chatTagLinks);
  const [movingTo, setMovingTo] = useState(false);
  // Folded branch groups persist across sessions (keyed by parent chat id).
  const collapsedBranches = usePersistentSet("collapsedBranches");
  const moveRef = useRef<HTMLDivElement>(null);
  const openReplay = useApp((s) => s.openReplay);
  const setActiveChat = useApp((s) => s.setActiveChat);
  // Bound to whichever chat the menu is open on; an empty id is harmless
  // because nothing runs until an entry is clicked.
  const { exportAs } = useChatExport(menu?.chatId ?? "");

  // Group every chat↔tag link by chat so each item can show its tag chips.
  const tagsByChatId = useMemo(() => {
    const m: Record<string, ChatTagLink[]> = {};
    for (const l of chatTagLinks) (m[l.chatId] ??= []).push(l);
    return m;
  }, [chatTagLinks]);

  // Nest branched chats under their parent. A chat is a root here if it has no
  // parent, or its parent isn't in this list (e.g. a different project section).
  const idSet = useMemo(() => new Set(chats.map((c) => c.id)), [chats]);
  const childrenByParent = useMemo(() => {
    const m: Record<string, Chat[]> = {};
    for (const c of chats) {
      if (c.parentChatId && idSet.has(c.parentChatId)) {
        (m[c.parentChatId] ??= []).push(c);
      }
    }
    return m;
  }, [chats, idSet]);
  const roots = useMemo(
    () => chats.filter((c) => !c.parentChatId || !idSet.has(c.parentChatId)),
    [chats, idSet],
  );

  function toggleBranches(chatId: string) {
    collapsedBranches.toggle(chatId);
  }

  function openMenu(e: React.MouseEvent, chatId: string) {
    e.preventDefault();
    setMovingTo(false);
    setMenu({ chatId, x: e.clientX, y: e.clientY });
  }

  function startRename(chat: Chat) {
    setEditingId(chat.id);
    setEditValue(chat.title);
    setMenu(null);
  }

  async function commitRename(chat: Chat) {
    if (editValue.trim() && editValue !== chat.title) {
      await api.renameChat(chat.id, editValue.trim());
      setChatTitle(chat.id, editValue.trim());
      await refreshChats();
    }
    setEditingId(null);
  }

  async function onDelete(chatId: string) {
    await api.deleteChat(chatId);
    await refreshChats();
    setMenu(null);
  }

  async function onRegenerate(chatId: string) {
    setMenu(null);
    // A user asking for a new title is judging the chat as it stands, so this
    // reads the whole conversation rather than just the opening message.
    try { await regenerateTitle(chatId, true); } catch (e) { reportError("Couldn't regenerate the title")(e); }
  }

  async function onMoveToProject(chatId: string, targetProjectId: string | null) {
    await setChatProject(chatId, targetProjectId);
    await refreshChats();
    setMenu(null);
  }

  const moveItems = [
    // If in a project, offer "Remove from project"
    ...(projectId !== null
      ? [{ id: null as string | null, label: "Remove from project" }]
      : []),
    // All other projects
    ...projects
      .filter((p) => p.id !== projectId)
      .map((p) => ({ id: p.id, label: p.name })),
  ];

  const renderChat = (chat: Chat, depth: number): React.ReactNode => {
    const active = chat.id === activeId;
    const editing = chat.id === editingId;
    const isRegenerating = regenerating.has(chat.id);
    const awaitingApproval = (pendingApprovalByChat[chat.id]?.length ?? 0) > 0;
    const kids = childrenByParent[chat.id] ?? [];
    const branchesOpen = !collapsedBranches.has(chat.id);
    // A nested child is a subchat when a zone owns it, otherwise a branch. No
    // icon for either (0.18.1): the split bar on its left says it hangs off the
    // chat above, in the driving zone's colour for a sub-agent.
    const subchatZone = chat.initiatedByZoneId
      ? zones.find((z) => z.id === chat.initiatedByZoneId)
      : null;
    const tagLinks = tagsByChatId[chat.id] ?? [];
    const row = (
      <div
        // Ctrl/⌘-click or middle-click opens the chat in a new tab, beside
        // what is open, the way a link does in a browser (0.18.3).
        onClick={(e) => (e.ctrlKey || e.metaKey ? void setActiveChat(chat.id, "tab") : onSelect(chat.id))}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
        onAuxClick={(e) => { if (e.button === 1) void setActiveChat(chat.id, "tab"); }}
        onContextMenu={(e) => openMenu(e, chat.id)}
        title={chat.initiatedByZoneId ? `Sub-agent${subchatZone ? ` · ${subchatZone.name}` : ""}` : undefined}
        className={`${SIDEBAR_ROW} ${
          active
            ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-text)]"
            : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
        }`}
      >
        {editing ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => commitRename(chat)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(chat);
              if (e.key === "Escape") { e.stopPropagation(); setEditingId(null); }
            }}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 rounded bg-[var(--color-bg)] px-1 text-sm"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate" title={chat.title}>
            {chat.title}
          </span>
        )}
        {isRegenerating && <Loader2 size={12} className="shrink-0 animate-spin text-[var(--color-accent)]" />}
        {/* Tags as dots, inline, so every row is the same height. */}
        {!editing && tagLinks.length > 0 && (
          <span className="flex shrink-0 gap-0.5" title={tagLinks.map((t) => t.name).join(", ")}>
            {tagLinks.slice(0, 3).map((t) => (
              <span key={t.tagId} className="h-1.5 w-1.5 rounded-full" style={{ background: t.color ?? "var(--color-text-muted)" }} />
            ))}
          </span>
        )}
        {/* A tool call waiting on the user in a chat that isn't open. Mostly
            background sub-agents: without a marker here the request is
            invisible until it times out and auto-denies. */}
        {awaitingApproval && (
          <span title="Waiting for your approval" className="shrink-0">
            <ShieldAlert size={13} className="animate-pulse text-amber-500" />
          </span>
        )}
        {kids.length > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleBranches(chat.id); }}
            title={branchesOpen ? "Hide branches and sub-agents" : "Show branches and sub-agents"}
            className="flex shrink-0 items-center gap-0.5 rounded px-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            {kids.length}
            <Disclosure open={branchesOpen} />
          </button>
        )}
      </div>
    );
    return (
      <div key={chat.id}>
        {depth > 0 ? (
          <div
            className="border-l-2 pl-1"
            style={{ borderColor: subchatZone?.accentColor ?? "var(--color-border-strong)" }}
          >
            {row}
          </div>
        ) : (
          row
        )}
        {kids.length > 0 && branchesOpen && (
          // Indent is capped (#12): a deep sub-agent tree otherwise walked the
          // title off the right-hand edge one level at a time.
          <div className={depth < 4 ? "ml-3" : ""}>{kids.map((k) => renderChat(k, depth + 1))}</div>
        )}
      </div>
    );
  };

  const shown = limit && !showAll && roots.length > limit + 1 ? roots.slice(0, limit) : roots;
  const hidden = roots.length - shown.length;

  return (
    <div className="flex flex-col gap-px">
      {shown.map((chat) => renderChat(chat, 0))}
      {(hidden > 0 || (showAll && limit && roots.length > limit + 1)) && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className={`${SIDEBAR_ROW} text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]`}
        >
          {hidden > 0 ? `Show ${hidden} more` : "Show less"}
        </button>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Open in new tab",
              icon: <SquarePlus size={14} />,
              onClick: () => { const id = menu.chatId; setMenu(null); void setActiveChat(id, "tab"); },
            },
            {
              label: "Open to the side",
              icon: <Columns2 size={14} />,
              onClick: () => { const id = menu.chatId; setMenu(null); void setActiveChat(id, "right"); },
            },
            {
              label: "Rename",
              icon: <Pencil size={14} />,
              onClick: () => {
                const chat = chats.find((c) => c.id === menu.chatId);
                if (chat) startRename(chat);
              },
            },
            {
              label: "Regenerate title",
              icon: <Sparkles size={14} />,
              onClick: () => onRegenerate(menu.chatId),
            },
            ...(moveItems.length > 0
              ? [{
                  label: movingTo ? "Move to:" : "Move to project…",
                  icon: projectId ? <FolderMinus size={14} /> : <FolderInput size={14} />,
                  onClick: () => setMovingTo((v) => !v),
                  submenu: movingTo ? moveItems.map((item) => ({
                    label: item.label,
                    onClick: () => onMoveToProject(menu.chatId, item.id),
                  })) : undefined,
                }]
              : []),
            {
              label: "View replay session",
              icon: <History size={14} />,
              onClick: () => {
                const id = menu.chatId;
                setMenu(null);
                openReplay(id);
              },
            },
            {
              label: "Export as Markdown",
              icon: <FileText size={14} />,
              onClick: () => {
                setMenu(null);
                void exportAs("md");
              },
            },
            {
              label: "Export as PDF",
              icon: <FileType size={14} />,
              onClick: () => {
                setMenu(null);
                void exportAs("pdf");
              },
            },
            {
              label: "Delete",
              icon: <Trash2 size={14} />,
              onClick: () => onDelete(menu.chatId),
              danger: true,
            },
          ]}
          moveRef={moveRef}
        />
      )}
    </div>
  );
}

function ContextMenu({
  x,
  y,
  onClose,
  items,
  moveRef,
}: {
  x: number;
  y: number;
  onClose: () => void;
  items: {
    label: string;
    icon?: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
    submenu?: { label: string; onClick: () => void }[];
  }[];
  moveRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Anchored on the click point and clamped to the window (#12): a right-click
  // near the bottom of a full sidebar used to open a menu whose last entries —
  // Delete among them — were off-screen with no way to scroll to them.
  return (
    <Popover open onClose={onClose} anchorRect={pointRect(x, y)} zIndex={40}
      className="min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
      <div>
        {items.map((item, i) => (
          <div key={i}>
            <button
              onClick={item.onClick}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)] ${
                item.danger ? "text-[var(--color-danger)]" : ""
              }`}
            >
              {item.icon}
              {item.label}
            </button>
            {item.submenu && (
              <div ref={moveRef} className="border-t border-[var(--color-border)] py-0.5">
                {item.submenu.map((sub, j) => (
                  <button
                    key={j}
                    onClick={sub.onClick}
                    className="flex w-full items-center gap-2 px-5 py-1.5 text-left text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                  >
                    {sub.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Popover>
  );
}
