import { Modal, ModalTitle } from "./Modal";
import { CONTEXTUAL_GROUPS, globalShortcutsGroup, type ShortcutGroup } from "@/lib/shortcuts";

const GROUPS: ShortcutGroup[] = [globalShortcutsGroup(), ...CONTEXTUAL_GROUPS];

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
