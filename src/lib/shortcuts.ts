/**
 * Single source of truth for the app's keyboard shortcuts.
 *
 * `GLOBAL_SHORTCUTS` are handled centrally by `useGlobalShortcuts` (App.tsx)
 * and also rendered in the help modal. `CONTEXTUAL_SHORTCUTS` are behaviours
 * wired up locally (send-on-Enter, scrolling, inline-edit) — documented here so
 * the help modal lists them, but not dispatched by the global handler.
 *
 * Keeping both lists here means the reference the user sees can never drift from
 * what the app actually does.
 */

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

/** Display glyph for the primary modifier (⌘ on macOS, Ctrl elsewhere). */
export const MOD = IS_MAC ? "⌘" : "Ctrl";

/** Actions the global handler can dispatch. */
export type ShortcutAction =
  | "newChat"
  | "openSettings"
  | "toggleSidebar"
  | "openZoneLibrary"
  | "openProjects"
  | "focusComposer"
  | "openCommandPalette"
  | "prevChat"
  | "nextChat"
  | "toggleShortcutsHelp";

export type GlobalShortcut = {
  action: ShortcutAction;
  /** Requires the primary modifier (Ctrl/Cmd). */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** `KeyboardEvent.key`, matched case-insensitively. */
  key: string;
  /** Keys to render in the help modal. */
  display: string[];
  description: string;
};

export const GLOBAL_SHORTCUTS: GlobalShortcut[] = [
  { action: "newChat", mod: true, key: "n", display: [MOD, "N"], description: "New chat" },
  { action: "openSettings", mod: true, key: ",", display: [MOD, ","], description: "Open settings" },
  { action: "toggleSidebar", mod: true, key: "b", display: [MOD, "B"], description: "Show / hide the sidebar" },
  { action: "openZoneLibrary", mod: true, key: "l", display: [MOD, "L"], description: "Configure zones (zone library)" },
  { action: "openProjects", mod: true, shift: true, key: "p", display: [MOD, "Shift", "P"], description: "Manage projects" },
  // The palette takes ⌘K, which is where every app that has one puts it, and
  // composer focus moves next door to ⌘J. Worth the relearning: ⌘K reaching a
  // text field the user is usually already in was the weaker binding.
  { action: "openCommandPalette", mod: true, key: "k", display: [MOD, "K"], description: "Command palette" },
  { action: "focusComposer", mod: true, key: "j", display: [MOD, "J"], description: "Focus the message input" },
  { action: "prevChat", alt: true, key: "ArrowUp", display: ["Alt", "↑"], description: "Previous chat" },
  { action: "nextChat", alt: true, key: "ArrowDown", display: ["Alt", "↓"], description: "Next chat" },
  { action: "toggleShortcutsHelp", mod: true, key: "/", display: [MOD, "/"], description: "Open this shortcuts reference" },
];

export type ShortcutGroup = {
  title: string;
  items: { keys: string[]; description: string }[];
};

/**
 * Contextual (locally-wired) shortcuts, for documentation only. These are not
 * dispatched by the global handler — they are behaviours of specific fields or
 * views.
 */
export const CONTEXTUAL_GROUPS: ShortcutGroup[] = [
  {
    title: "Messaging",
    items: [
      { keys: ["Enter"], description: "Send message" },
      { keys: [MOD, "Enter"], description: "Send message (when \"send on Ctrl+Enter\" is set in Settings)" },
      { keys: [MOD, "Enter"], description: "Save an in-progress message edit" },
      { keys: ["Esc"], description: "Cancel a message edit" },
    ],
  },
  {
    title: "Panes",
    items: [
      { keys: [MOD, "←", "→", "↑", "↓"], description: "Move to the pane on that side (in a text field, only while it is empty)" },
      { keys: [MOD, "Shift", "←", "→", "↑", "↓"], description: "Move the pane itself to that side" },
      { keys: [MOD, "Enter"], description: "Zoom the pane to fill the window, and back (when the text box has no use for it)" },
      { keys: [MOD, "Esc"], description: "Zoom back out (where Windows does not take it for the Start menu)" },
      { keys: [MOD, "Shift", "Enter"], description: "Zoom the pane, and back" },
      { keys: [MOD, "+"], description: "Make the pane bigger (wider, or taller when it is in a column of its own)" },
      { keys: [MOD, "−"], description: "Make the pane smaller" },
      { keys: [MOD, "0"], description: "Even out the panes (the sidebar and workspace keep their width)" },
      { keys: ["F6"], description: "Go to the next pane; Shift+F6 the previous one" },
    ],
  },
  {
    title: "Tabs",
    items: [
      { keys: [MOD, "Tab"], description: `Next tab in the pane (also ${MOD}+PgDn)` },
      { keys: [MOD, "Shift", "Tab"], description: `Previous tab in the pane (also ${MOD}+PgUp)` },
      { keys: [MOD, "1–8"], description: "Go to that tab in the pane" },
      { keys: [MOD, "9"], description: "Go to the pane's last tab" },
      { keys: [MOD, "W"], description: "Close the tab (asks first for a file with unsaved changes)" },
      { keys: ["←", "→", "Home", "End"], description: "On a focused tab: move along the tabs" },
      { keys: ["Enter"], description: "On a focused tab: go into it" },
      { keys: ["Delete"], description: "On a focused tab: close it" },
      { keys: ["Shift", "F10"], description: "On a focused tab: open the pane's ⋯ menu" },
    ],
  },
  {
    title: "Scrolling",
    items: [
      { keys: ["↑", "↓", "PgUp", "PgDn", "Home", "End"], description: "Scroll the chat (unpins auto-scroll while streaming)" },
    ],
  },
  {
    title: "Settings",
    items: [
      { keys: [MOD, "F"], description: "Search every settings tab (also / outside a field); Esc clears" },
    ],
  },
  {
    title: "Lists & fields",
    items: [
      { keys: ["Enter"], description: "Confirm a rename or inline text field" },
      { keys: ["Esc"], description: "Cancel a rename" },
    ],
  },
  {
    title: "Diagrams",
    items: [
      { keys: [MOD, "Click"], description: "Pan/zoom interaction inside a Mermaid diagram" },
    ],
  },
];

/** The global shortcuts rendered as a display group for the help modal. */
export function globalShortcutsGroup(): ShortcutGroup {
  return {
    title: "App",
    items: [
      ...GLOBAL_SHORTCUTS.map((s) => ({ keys: s.display, description: s.description })),
      { keys: ["?"], description: "Open this shortcuts reference" },
      { keys: ["Esc"], description: "Close the top-most dialog, menu or popover" },
    ],
  };
}
