/**
 * Whether anyone can see the window, and whether it has the focus.
 *
 * Anything that repaints or polls on its own clock reads this to do less when
 * nobody is looking. `hidden` comes from the page's own visibility, which the
 * backend drives on the desktop: hiding to the tray or minimising sets the
 * webview invisible (see `background.rs`), so `document.hidden` turns true.
 * `focused` is the ordinary window focus — the app behind another window is
 * still on screen, just not being worked in.
 */

export interface AppActivity {
  hidden: boolean;
  focused: boolean;
}

type Listener = (a: AppActivity) => void;

const listeners = new Set<Listener>();

function read(): AppActivity {
  return {
    hidden: document.visibilityState === "hidden",
    // hasFocus rather than the blur event alone: a click into an embedded
    // iframe (an HTML report) blurs the window but keeps the document focused.
    focused: document.hasFocus(),
  };
}

let current: AppActivity = read();

function update() {
  const next = read();
  if (next.hidden === current.hidden && next.focused === current.focused) return;
  current = next;
  for (const fn of [...listeners]) fn(current);
}

document.addEventListener("visibilitychange", update);
window.addEventListener("focus", update);
window.addEventListener("blur", update);

export function appActivity(): AppActivity {
  return current;
}

/** Subscribe to changes. Returns the unsubscribe function. */
export function onAppActivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
