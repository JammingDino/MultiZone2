import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { usePersistentBool } from "@/lib/uiState";
import { useApp, type WorkspaceSection } from "@/store/app";

/**
 * One collapsible band of the workspace panel. Open/closed persists per
 * section; a `focusWorkspace(id)` from anywhere opens it and scrolls it into
 * view, then clears the focus so the next one is a fresh request.
 */
export function Section({
  id,
  title,
  icon,
  badge,
  actions,
  defaultOpen = true,
  children,
}: {
  id: WorkspaceSection;
  title: string;
  icon: ReactNode;
  /** A short status after the title — "2 running", "3 of 8". */
  badge?: ReactNode;
  /** Controls at the right of the header, shown even when collapsed. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistentBool(`workspace.${id}.open`, defaultOpen);
  const focus = useApp((s) => s.workspaceFocus);
  const focusWorkspace = useApp((s) => s.focusWorkspace);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focus !== id) return;
    setOpen(true);
    // After the section has rendered open, bring it into view.
    const t = window.setTimeout(() => {
      ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      focusWorkspace(null);
    }, 30);
    return () => window.clearTimeout(t);
  }, [focus, id, setOpen, focusWorkspace]);

  return (
    <section ref={ref} className="border-b border-[var(--color-border)]">
      <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-[var(--color-panel)] px-2.5 py-1.5 text-xs">
        <button
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--color-text-muted)]" />
          )}
          <span className="shrink-0 text-[var(--color-text-muted)]">{icon}</span>
          <span className="truncate font-medium text-[var(--color-text)]">{title}</span>
          {badge && <span className="truncate text-[var(--color-text-muted)]">{badge}</span>}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {open && <div className="px-2.5 pb-2.5">{children}</div>}
    </section>
  );
}
