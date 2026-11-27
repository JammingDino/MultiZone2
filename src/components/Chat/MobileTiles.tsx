import { useEffect, useRef, type ReactNode } from "react";
import { GraduationCap, Menu, MessageSquare, Plus, Repeat, X } from "lucide-react";
import { useApp } from "@/store/app";
import { HOME_TAB, activate, chatOf, closeTab, groupOf, studyOf } from "@/lib/tabLayout";
import { phonePane } from "@/lib/mobileLayout";
import { usePlanFocus } from "@/components/Workspace/WorkspacePanel";
import { iconFor } from "@/components/Workspace/FilesPanel";
import { CHROME_QUIET } from "@/lib/chrome";
import { nameOf } from "./Tiles";

/**
 * The main column on a phone (0.21): one tab at a time, every open tab in a
 * strip above it, the chat list behind the menu button. The panes Tiles draws
 * on a wide window need room a handset does not have — and dragging to split,
 * resize handles and hover-revealed close buttons are mouse things — so the
 * phone gets the same tabs without the tiling. Picking a tab focuses its pane
 * in the layout and leaves the arrangement alone, so the window has it all
 * back when it is wide again. See lib/mobileLayout.ts.
 */
export function MobileTiles({ renderTab, renderBar }: {
  renderTab: (tab: string) => ReactNode;
  renderBar: (tab: string) => ReactNode;
}) {
  const layout = useApp((s) => s.tabLayout);
  const change = useApp((s) => s.updateTabLayout);
  const openChats = useApp((s) => s.setSidebarOpen);
  // A filed plan brings the workspace drawer out, as it brings the Plan pane
  // forward on a wide window.
  usePlanFocus(useApp((s) => s.activeChatId));
  const { tabs, active } = phonePane(layout);
  const bar = renderBar(active);

  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  // Picking a chat, a search result, a new chat or a file is what a drawer
  // was opened for: it goes once something new is on screen.
  const newChat = useApp((s) => s.newChatTimestamp);
  useEffect(() => {
    const s = useApp.getState();
    if (s.sidebarOpen) s.setSidebarOpen(false);
    if (s.workspaceOpen) s.setWorkspaceOpen(false);
  }, [active, newChat]);

  const select = (tab: string) => change((l) => {
    const g = groupOf(l, tab);
    return g ? activate(l, g.id, tab) : l;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mz-phone-bar flex shrink-0 flex-wrap border-b border-[var(--color-border)] bg-[var(--color-panel)]">
        <div className="flex h-11 min-w-[50%] flex-1 items-stretch">
          <button
            onClick={() => openChats(true)}
            aria-label="Chats"
            title="Chats"
            className={`mz-tap m-1 flex shrink-0 items-center justify-center rounded-md ${CHROME_QUIET}`}
          >
            <Menu size={18} />
          </button>
          <div ref={strip} role="tablist" aria-label="Open tabs" className="mz-phone-tabs flex min-w-0 flex-1 overflow-x-auto">
            {(tabs.length ? tabs : [HOME_TAB]).map((tab) => (
              <PhoneTab
                key={tab}
                tab={tab}
                selected={tab === active}
                onSelect={() => select(tab)}
                // The last tab on its own is the new-chat screen: nothing to close.
                onClose={tabs.length ? () => change((l) => closeTab(l, tab)) : undefined}
              />
            ))}
          </div>
        </div>
        {/* The chat's own controls — zone, context, the workspace drawer. In
            portrait a row of their own, as beside the tabs they would leave
            no room for either; on a phone on its side, where height is what
            is short, at the end of the tab row. */}
        {bar && (
          <div className="mz-phone-chatbar flex h-10 w-full items-center gap-1 overflow-x-auto border-t border-[var(--color-border)] px-2 min-[600px]:h-11 min-[600px]:w-auto min-[600px]:max-w-[50%] min-[600px]:border-t-0">
            {bar}
          </div>
        )}
      </div>
      {/* Keyed so a different tab is a different component, not the last
          one's state carried over. */}
      <div key={active} className="flex min-h-0 flex-1 flex-col">
        {renderTab(active)}
      </div>
    </div>
  );
}

function PhoneTab({ tab, selected, onSelect, onClose }: {
  tab: string;
  selected: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  const name = useApp((s) => nameOf(tab, s));
  return (
    <div
      role="tab"
      aria-selected={selected}
      className={`flex max-w-[11rem] shrink-0 items-center border-b-2 ${
        selected ? "border-[var(--color-accent)] text-[var(--color-text)]" : "border-transparent text-[var(--color-text-muted)]"
      }`}
    >
      <button onClick={onSelect} className="flex h-full min-w-0 items-center gap-1.5 pl-3 pr-2 text-xs">
        <TabIcon tab={tab} />
        <span className="truncate">{name}</span>
      </button>
      {/* Only on the tab in front: a close on every tab is a row of targets
          a thumb hits when it meant to switch. */}
      {selected && onClose && (
        <button onClick={onClose} aria-label={`Close ${name}`} className="mz-tap -ml-1 mr-0.5 flex shrink-0 items-center justify-center text-[var(--color-text-muted)]">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function TabIcon({ tab }: { tab: string }) {
  if (chatOf(tab)) return <MessageSquare size={13} className="shrink-0" />;
  if (tab === HOME_TAB) return <Plus size={13} className="shrink-0" />;
  const study = studyOf(tab);
  if (study) {
    const Icon = study.kind === "review" ? Repeat : GraduationCap;
    return <Icon size={13} className="shrink-0" style={{ color: "var(--color-accent)" }} />;
  }
  const { Icon, color } = iconFor(tab.slice(Math.max(tab.lastIndexOf("/"), tab.lastIndexOf("\\")) + 1));
  return <Icon size={13} className="shrink-0" style={{ color }} />;
}
