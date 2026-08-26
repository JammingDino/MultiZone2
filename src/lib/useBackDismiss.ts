import { useEffect, useRef } from "react";

/**
 * The phone's back gesture closes the top layer (0.17.5).
 *
 * On Android, back is not a nicety — it is *the* way out of anything. The first
 * mobile build had none: every back press, from anywhere, closed the whole app,
 * because the shell's handler is `webView.canGoBack()` and a single-page app
 * that never touches history can never go back. Closing an app is a
 * catastrophic answer to "dismiss this dialog", and it is the one people hit
 * first and most often.
 *
 * So the layers put themselves in history. Opening a modal pushes an entry;
 * back pops it and closes that modal instead of leaving the app; closing it any
 * other way (the X, a tap on the backdrop, Escape) takes its entry back out so
 * the two never disagree about how deep the stack is. With no layers open, back
 * exits — which is correct, and is the only case the old behaviour got right.
 *
 * Modelled on [`useDismissOnEscape`] deliberately, down to the shape of the
 * stack: they answer the same question for two different input devices, and a
 * layer that registers with both closes on Escape *and* on back with no further
 * thought. Nesting works the same way — LIFO by open time, so a popover inside
 * a modal takes the first press and the modal takes the second.
 *
 * Harmless on the desktop: the entries are pushed either way, and nothing there
 * generates a `popstate` the user did not ask for.
 */
type Layer = { close: () => void };

const stack: Layer[] = [];

/** True while we are the ones calling `history.back()`, so the `popstate` it
 *  causes is bookkeeping rather than a press of the button. */
let unwinding = 0;

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (unwinding > 0) {
      unwinding--;
      return;
    }
    const top = stack.pop();
    // No layer means the entry belonged to something already gone. Nothing to
    // close; the next press leaves the app, which is what should happen at the
    // root of a screen with nothing open on it.
    top?.close();
  });
}

/**
 * Register a back-dismissable layer while `active` is true. `onDismiss` is read
 * through a ref, so an inline arrow function does not churn the stack.
 */
export function useBackDismiss(active: boolean, onDismiss: () => void) {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;

  useEffect(() => {
    if (!active) return;
    const layer: Layer = { close: () => cb.current() };
    stack.push(layer);
    // The entry carries no state the app reads — it exists to be popped. The
    // marker is for anyone looking at the history stack in a debugger.
    history.pushState({ mzLayer: true }, "");

    return () => {
      const i = stack.lastIndexOf(layer);
      // Already popped by a back press: the entry is gone with it, and asking
      // for another `history.back()` here would eat the caller's own screen.
      if (i === -1) return;
      stack.splice(i, 1);
      // Closed by the X, the backdrop or Escape — take the entry back out so a
      // later back press is not absorbed by a layer nobody can see.
      unwinding++;
      history.back();
    };
  }, [active]);
}
