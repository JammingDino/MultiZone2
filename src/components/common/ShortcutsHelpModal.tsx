import { Modal, ModalTitle } from "./Modal";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
const MOD = isMac ? "⌘" : "Ctrl";

type ShortcutGroup = {
  title: string;
  items: { keys: string[]; description: string }[];
};

const GROUPS: ShortcutGroup[] = [
  {
    title: "Messaging",
    items: [
      { keys: ["Enter"], description: "Send message" },
      { keys: [MOD, "Enter"], description: "Send message (when \"send on Ctrl+Enter\" is set in Settings)" },
      { keys: [MOD, "Enter"], description: "Save an in-progress message edit" },
      { keys: ["Esc"], description: "Cancel a message edit, or close an open popover/menu" },
    ],
  },
  {
    title: "Scrolling",
    items: [
      { keys: ["↑", "↓", "PgUp", "PgDn", "Home", "End"], description: "Scroll the chat (unpins auto-scroll-to-bottom while streaming)" },
    ],
  },
  {
    title: "Lists & fields",
    items: [
      { keys: ["Enter"], description: "Confirm a rename or inline text field" },
      { keys: ["Esc"], description: "Cancel a rename, or close a combobox" },
    ],
  },
  {
    title: "Diagrams",
    items: [
      { keys: [MOD, "Click"], description: "Pan/zoom interaction inside a Mermaid diagram" },
    ],
  },
  {
    title: "Help",
    items: [
      { keys: ["?"], description: "Open this shortcuts reference" },
    ],
  },
];

export function ShortcutsHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} header={<ModalTitle>Keyboard Shortcuts</ModalTitle>} className="h-[560px] w-[480px]">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-6">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                {group.title}
              </h3>
              <div className="flex flex-col gap-2">
                {group.items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-[var(--color-text)]">{item.description}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {item.keys.map((k, j) => (
                        <kbd
                          key={j}
                          className="rounded border border-[var(--color-border)] bg-[var(--color-panel-hover)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-muted)]"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
