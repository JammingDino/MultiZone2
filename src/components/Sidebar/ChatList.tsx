import { useRef, useState } from "react";
import type { Chat } from "@/lib/types";
import { MessageSquare, Pencil, Trash2, Sparkles, Loader2, FolderInput, FolderMinus } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";

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
  const { projects, refreshChats, setChatTitle, regenerateTitle, setChatProject } = useApp();
  const regenerating = useApp((s) => s.regeneratingTitles);
  const [movingTo, setMovingTo] = useState(false);
  const moveRef = useRef<HTMLDivElement>(null);

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
    try { await regenerateTitle(chatId); } catch (e) { console.error(e); }
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

  return (
    <div className="px-1">
      {chats.map((chat) => {
        const active = chat.id === activeId;
        const editing = chat.id === editingId;
        const isRegenerating = regenerating.has(chat.id);
        return (
          <div
            key={chat.id}
            onClick={() => onSelect(chat.id)}
            onContextMenu={(e) => openMenu(e, chat.id)}
            className={`group mx-1 my-0.5 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${
              active
                ? "bg-[var(--color-panel-hover)] text-[var(--color-text)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            }`}
          >
            {isRegenerating ? (
              <Loader2 size={14} className="flex-shrink-0 animate-spin text-[var(--color-accent)]" />
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
                  if (e.key === "Escape") setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 rounded bg-[var(--color-bg)] px-1 text-sm"
              />
            ) : (
              <span className="flex-1 truncate">
                {chat.title}
                {isRegenerating && (
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">renaming…</span>
                )}
              </span>
            )}
          </div>
        );
      })}

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
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        className="fixed z-50 min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
        style={{ left: x, top: y }}
      >
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
    </>
  );
}
