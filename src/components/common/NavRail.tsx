import type { ReactNode } from "react";

/**
 * The left rail of a workspace panel — Settings and Configure Zones (0.18.1).
 *
 * They were two rails for one pattern: Settings a quiet list of icon + label
 * rows, Configure Zones a tinted column of bordered buttons and 28px zone
 * tiles. Clicking from one to the other looked like changing apps. One rail,
 * written once.
 *
 * On a narrow screen the rail becomes a horizontally scrolling strip along the
 * top (0.17.3) — the one part of the panel that has to stay reachable from
 * every pane, kept visible without a second navigation concept to learn.
 */
export function NavRail({ children }: { children: ReactNode }) {
  return (
    <nav className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--color-border)] p-2 text-sm narrow:w-full narrow:flex-none narrow:flex-row narrow:overflow-x-auto narrow:overflow-y-hidden narrow:border-r-0 narrow:border-b">
      {children}
    </nav>
  );
}

/** A heading in the rail. Hidden in the narrow strip, where it would read as another tab. */
export function NavGroup({ label }: { label: string }) {
  return (
    <div className="mt-3 px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] first:mt-0 narrow:hidden">
      {label}
    </div>
  );
}

/** Row classes, exported for rows that carry more than an icon and a label. */
export function navItemClass(active: boolean): string {
  return `flex w-full items-center gap-2 rounded px-2 py-1.5 text-left narrow:w-auto narrow:shrink-0 narrow:whitespace-nowrap narrow:px-3 narrow:py-2 ${
    active
      ? "bg-[var(--color-panel-hover)] text-[var(--color-text)]"
      : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
  }`;
}

export function NavItem({
  active, icon, label, onClick,
}: {
  active: boolean; icon: ReactNode; label: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} className={navItemClass(active)}>
      {icon}
      {label}
    </button>
  );
}
