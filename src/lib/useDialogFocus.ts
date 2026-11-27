import { useEffect, useRef, type RefObject } from "react";
import { tabbables } from "@/lib/keyboard";

/**
 * A modal's hold on focus (0.21): it takes focus when it opens, Tab and
 * Shift+Tab go round its own controls instead of out to the window behind,
 * and focus goes back to where it was when it closes.
 *
 * Opening focuses the first control that is not marked `data-dialog-close`
 * (the ✕ in the corner is nobody's first choice), unless something inside
 * already took focus (an `autoFocus` field). A menu portalled out of the
 * dialog keeps its own keys: only Tab from inside the panel is wrapped.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true) {
  // Where focus was, read while rendering: by the time an effect runs, an
  // `autoFocus` field inside the dialog has already taken it.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current) openerRef.current = document.activeElement as HTMLElement | null;
  wasActive.current = active;

  useEffect(() => {
    const panel = ref.current;
    if (!active || !panel) return;
    const opener = openerRef.current;
    const raf = requestAnimationFrame(() => {
      if (panel.contains(document.activeElement)) return;
      const first = tabbables(panel).find((el) => !el.closest("[data-dialog-close]"));
      (first ?? panel).focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!panel.contains(e.target as Node)) return;
      const items = tabbables(panel);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      // By position, not index: focus can sit on something Tab skips (a
      // radio that is not the group's stop, the panel itself).
      const a = document.activeElement ?? panel;
      const after = (el: Element) => !!(a.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const wrap = e.shiftKey
        ? !items.some((el) => el !== a && !after(el)) && items[items.length - 1]
        : !items.some((el) => el !== a && after(el)) && items[0];
      if (wrap) {
        e.preventDefault();
        wrap.focus();
      }
    };
    panel.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      panel.removeEventListener("keydown", onKey);
      // Not if the user has moved on (a palette command opened something else).
      const a = document.activeElement;
      if ((!a || a === document.body || panel.contains(a)) && opener && opener !== document.body && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}
