import { useEffect, useRef } from "react";

/**
 * Escape closes the top layer — one shared stack for every dismissable surface
 * in the app (modals, popovers, comboboxes, inline renames).
 *
 * Before this, Escape worked in a handful of places that each wired their own
 * key listener, and did nothing in the rest — including Settings, the zone
 * editor and the projects panel, which are the ones people most expect it in.
 * A per-surface listener also can't answer "which one should close?" when two
 * are open: a plain `window` listener on every modal would close all of them at
 * once.
 *
 * The stack is LIFO by *open time*, not by DOM depth: a layer registers when it
 * becomes active and unregisters when it closes, so whatever the user opened
 * last is what Escape closes first. A popover opened inside a modal therefore
 * closes on its own, leaving the modal up — press Escape again for the modal.
 */
type Layer = { close: () => void };

const stack: Layer[] = [];

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const top = stack[stack.length - 1];
      if (!top) return;
      e.preventDefault();
      e.stopPropagation();
      top.close();
    },
    // Bubble phase, so a field that handles Escape itself (a rename input, a
    // message edit) can stop the event before it ever reaches this handler.
    false,
  );
}

/**
 * Register a dismissable layer while `active` is true. `onDismiss` is read
 * through a ref, so passing an inline arrow function doesn't churn the stack.
 */
export function useDismissOnEscape(active: boolean, onDismiss: () => void) {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;

  useEffect(() => {
    if (!active) return;
    const layer: Layer = { close: () => cb.current() };
    stack.push(layer);
    return () => {
      const i = stack.lastIndexOf(layer);
      if (i !== -1) stack.splice(i, 1);
    };
  }, [active]);
}
