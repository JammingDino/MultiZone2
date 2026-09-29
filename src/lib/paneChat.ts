import { createContext, useContext } from "react";
import { useApp } from "@/store/app";

/**
 * The chat a component is drawn inside (0.18.3). With several chats open side
 * by side, "the active chat" is only the focused one; a message in another
 * pane must still colour itself by its own chat.
 */
export const PaneChat = createContext<string | null>(null);

export function usePaneChatId(): string | null {
  const pane = useContext(PaneChat);
  const active = useApp((s) => s.activeChatId);
  return pane ?? active;
}
