import { create } from "zustand";

/**
 * Failures of one-off actions — open a file, reveal it, stop a run, rename a
 * chat — that have no panel of their own to show an error in.
 *
 * These used to be `.catch(console.error)`, which in a packaged app is the same
 * as not catching at all: nobody has devtools open, so the click just did
 * nothing. `reportError` keeps the log line and also puts the error on screen
 * (`ErrorToasts`), worded by `friendlyError`.
 */
export interface Reported {
  id: number;
  context: string;
  error: unknown;
}

export const useReported = create<{ items: Reported[]; dismiss: (id: number) => void }>((set) => ({
  items: [],
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

let nextId = 0;

/** A catch handler: `.catch(reportError("Couldn't open the file"))`. */
export function reportError(context: string) {
  return (e: unknown) => {
    console.error(context, e);
    const id = ++nextId;
    // Three at most: a burst of the same failure is one problem, not a wall.
    useReported.setState((s) => ({ items: [...s.items.slice(-2), { id, context, error: e }] }));
  };
}
