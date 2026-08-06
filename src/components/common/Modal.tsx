import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";

/**
 * Shared modal shell (0.7.3 consistency pass). Standardises the overlay, panel
 * chrome, header height/padding, and close-button placement so every modal —
 * Settings, Zone editor, Zone library, Projects — looks and behaves the same.
 *
 * Callers supply the panel size via `className` (e.g. `h-[700px] w-[800px]`),
 * the left-hand header content via `header` (a title or a row of tabs), and the
 * body as children. Clicking the backdrop or the ✕ calls `onClose`.
 */
export function Modal({
  onClose,
  header,
  children,
  className = "",
}: {
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  // Escape closes the modal — or, if a popover inside it is open, that popover
  // first (see useDismissOnEscape).
  useDismissOnEscape(true, onClose);

  return (
    <div
      className="mz-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className={`flex max-h-[94vh] max-w-[96vw] flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-5">
          <div className="flex min-w-0 items-center gap-2">{header}</div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1.5 text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Standard modal title text, so headings match across modals. */
export function ModalTitle({ children }: { children: ReactNode }) {
  return <h2 className="truncate text-[15px] font-semibold">{children}</h2>;
}
