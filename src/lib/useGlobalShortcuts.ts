import { useEffect } from "react";
import { useApp } from "@/store/app";
import { GLOBAL_SHORTCUTS, type GlobalShortcut, type ShortcutAction } from "@/lib/shortcuts";

/** True when focus is in a text-entry surface, where plain keys are content. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || !!el?.isContentEditable;
}

/** Does this event match the shortcut's modifier + key combination? */
function matches(e: KeyboardEvent, s: GlobalShortcut): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!!s.mod !== mod) return false;
  if (!!s.shift !== e.shiftKey) return false;
  if (!!s.alt !== e.altKey) return false;
  return e.key.toLowerCase() === s.key.toLowerCase();
}

/**
 * Central keyboard-shortcut handler. Every app-wide shortcut lives in
 * `GLOBAL_SHORTCUTS`; this hook maps each to a store action so the shortcut
 * reference and the behaviour can never drift apart. Modifier-based shortcuts
 * fire even while typing in a field (Ctrl+N still opens a new chat mid-message);
 * the plain `?` help shortcut is suppressed while typing since it's a character.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    function run(action: ShortcutAction) {
      const s = useApp.getState();
      switch (action) {
        case "newChat":
          s.triggerNewChat(null);
          void s.setActiveChat(null);
          break;
        case "openSettings":
          s.settingsOpen ? s.closeSettings() : s.openSettings();
          break;
        case "toggleSidebar":
          s.toggleSidebar();
          break;
        case "openZoneLibrary":
          s.zoneLibraryOpen ? s.closeZoneLibrary() : s.openZoneLibrary();
          break;
        case "openProjects":
          s.projectsPanelOpen ? s.closeProjectsPanel() : s.openProjectsPanel();
          break;
        case "focusComposer":
          s.focusComposer();
          break;
        case "prevChat":
        case "nextChat": {
          // Navigate the flat, top-level chat list (subchats excluded — they're
          // read-only). From the home screen, step onto the nearest end.
          const list = s.chats.filter((c) => !c.parentChatId);
          if (list.length === 0) break;
          const idx = list.findIndex((c) => c.id === s.activeChatId);
          let next: number;
          if (idx === -1) {
            next = action === "nextChat" ? 0 : list.length - 1;
          } else {
            next = action === "nextChat" ? idx + 1 : idx - 1;
            if (next < 0 || next >= list.length) break; // stop at the ends
          }
          void s.setActiveChat(list[next].id);
          break;
        }
        case "toggleShortcutsHelp":
          s.shortcutsHelpOpen ? s.closeShortcutsHelp() : s.openShortcutsHelp();
          break;
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      // Plain "?" opens the reference, unless the user is typing.
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTyping(e.target)) return;
        e.preventDefault();
        useApp.getState().openShortcutsHelp();
        return;
      }
      for (const s of GLOBAL_SHORTCUTS) {
        if (matches(e, s)) {
          e.preventDefault();
          run(s.action);
          return;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
