import { useMemo, useRef, useState } from "react";
import type { Chat, ChatTagLink } from "@/lib/types";
import { MessageSquare, Pencil, Trash2, Sparkles, Loader2, FolderInput, FolderMinus, GitBranch, ChevronRight, ChevronDown, ShieldAlert, History, FileText, FileType } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import { getZoneIcon } from "@/lib/zoneIcons";
import { usePersistentSet } from "@/lib/uiState";
import { Popover, pointRect } from "@/components/common/Popover";
import { useChatExport } from "@/lib/useChatExport";

interface Props {
  chats: Chat[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Which project this list lives inside (null = ungrouped section). */
  projectId: string | null;
}

interface MenuState {
  chatId: string;
  x: number;
  y: number;
}

export function ChatList({ chats, activeId, onSelect, projectId }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
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
    try { await regenerateTitle(chatId, true); } catch (e) { console.error(e); }
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
    const hasKids = kids.length > 0;
    const branchesOpen = !collapsedBranches.has(chat.id);
    // A nested child is a subchat when a zone owns it, otherwise a branch.
    const subchatZone = chat.initiatedByZoneId
      ? zones.find((z) => z.id === chat.initiatedByZoneId)
      : null;
    const isSubchat = !!chat.initiatedByZoneId;
    const isBranch = depth > 0 && !isSubchat;
    const SubchatIcon = getZoneIcon(subchatZone?.icon);
    return (
      <div key={chat.id}>
        <div
          onClick={() => onSelect(chat.id)}
          onContextMenu={(e) => openMenu(e, chat.id)}
          // Indent is capped (#12): a deep sub-agent tree otherwise walked the
          // title off the right-hand edge one level at a time.
          style={{ marginLeft: Math.min(depth, 5) * 12 }}
          className={`group mx-1 my-0.5 cursor-pointer rounded px-2 py-1.5 text-sm transition-colors ${
            active
              ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] font-medium text-[var(--color-text)] shadow-[inset_2px_0_0_var(--color-accent)]"
              : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          }`}
        >
          <div className="flex items-center gap-2">
            {hasKids ? (
              <button
                onClick={(e) => { e.stopPropagation(); toggleBranches(chat.id); }}
                title={branchesOpen ? "Collapse branches" : "Expand branches"}
                className="flex-shrink-0 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                {branchesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : null}
            {isRegenerating ? (
              <Loader2 size={14} className="flex-shrink-0 animate-spin text-[var(--color-accent)]" />
            ) : isSubchat ? (
              <span
                title={subchatZone ? `Subchat driven by ${subchatZone.name}` : "Subchat"}
                className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded"
                style={{ background: subchatZone?.accentColor ?? "var(--color-panel)" }}
              >
                <SubchatIcon size={11} color={subchatZone?.accentColor ? "white" : "var(--color-text-muted)"} />
              </span>
            ) : isBranch ? (
              <GitBranch size={13} className="flex-shrink-0 text-[var(--color-text-muted)]" />
            ) : (
              <MessageSquare size={14} className="flex-shrink-0" />
            )}
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
                className="flex-1 rounded bg-[var(--color-bg)] px-1 text-sm"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate" title={chat.title}>
                {chat.title}
                {isRegenerating && (
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">renaming…</span>
                )}
              </span>
            )}
            {/* A tool call waiting on the user in a chat that isn't open. Mostly
                background sub-agents: without a marker here the request is
                invisible until it times out and auto-denies. */}
            {awaitingApproval && (
              <span title="Waiting for your approval" className="flex-shrink-0">
                <ShieldAlert size={13} className="animate-pulse text-amber-500" />
              </span>
            )}
          </div>
          {!editing && (tagsByChatId[chat.id]?.length ?? 0) > 0 && (
            <div className="mt-1 flex flex-wrap gap-1 pl-6">
              {tagsByChatId[chat.id].slice(0, 4).map((t) => (
                <span
                  key={t.tagId}
                  className="flex max-w-[90px] items-center gap-1 rounded-full px-1.5 py-px text-[10px] leading-tight"
                  style={{
                    color: t.color ?? "var(--color-text-muted)",
                    background: `color-mix(in srgb, ${t.color ?? "var(--color-text-muted)"} 14%, transparent)`,
                  }}
                  title={t.name}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: t.color ?? "var(--color-text-muted)" }} />
                  <span className="truncate">{t.name}</span>
                </span>
              ))}
              {tagsByChatId[chat.id].length > 4 && (
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  +{tagsByChatId[chat.id].length - 4}
                </span>
              )}
            </div>
          )}
        </div>
        {hasKids && branchesOpen && kids.map((k) => renderChat(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="px-1">
      {roots.map((chat) => renderChat(chat, 0))}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
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
