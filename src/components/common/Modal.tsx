import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { CHROME_QUIET } from "@/lib/chrome";

/**
 * The one workspace footprint. Every full panel — Settings, Configure Zones,
 * Projects/tags, Replay — is this size, so moving between them doesn't shift
 * the window's centre of gravity. It's the largest of the sizes they used to
 * be written at individually, so nothing reflows into less room than it had.
 */
const WORKSPACE_SIZE = "h-[700px] w-[980px]";

/**
 * On a phone the workspace size is not a size, it is the screen (0.17.3).
 *
 * A 980×700 panel inside a 360×800 viewport was clamped to `max-w-[96vw]` and
 * then had its contents laid out for the width it asked for, so every panel
 * scrolled sideways under a floating rounded card. Full-bleed, square corners,
 * no backdrop gap: the modal *is* the screen, which is also what a phone user
 * expects a settings screen to be.
 */
const MOBILE_SIZE = "narrow:h-full narrow:max-h-full narrow:w-full narrow:max-w-full narrow:rounded-none narrow:border-0";

/**
 * Shared modal shell (0.7.3 consistency pass). Standardises the overlay, panel
 * chrome, header height/padding, and close-button placement so every modal —
 * Settings, Zone editor, Zone library, Projects — looks and behaves the same.
 *
 * Two classes of modal, chosen with `size`:
 *
 * - `"workspace"` (the default) is a full panel you work inside. It gets
 *   {@link WORKSPACE_SIZE} — one size for all of them, defined here rather
 *   than picked per caller.
 * - `"dialog"` is an answer to a single question (update prompt, import
 *   confirmation, shortcuts sheet). It sizes to its content, so the caller
 *   supplies a width via `className` and leaves the height to grow.
 *
 * `header` is the left-hand header content (a title or a row of tabs) and the
 * body is children. Clicking the backdrop or the ✕ calls `onClose`.
 */
export function Modal({
  onClose,
  header,
  children,
  size = "workspace",
  className = "",
}: {
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
  size?: "workspace" | "dialog";
  className?: string;
}) {
  // Escape closes the modal — or, if a popover inside it is open, that popover
  // first (see useDismissOnEscape).
  useDismissOnEscape(true, onClose);

  return (
    <div
      className="mz-overlay mz-safe-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className={`flex max-h-[94vh] max-w-[96vw] flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl ${MOBILE_SIZE} ${size === "workspace" ? WORKSPACE_SIZE : ""} ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-5">
          <div className="flex min-w-0 items-center gap-2">{header}</div>
          <button
            onClick={onClose}
            aria-label="Close"
            className={`shrink-0 rounded-md p-1.5 ${CHROME_QUIET}`}
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
