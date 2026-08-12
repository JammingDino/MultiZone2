import { ChevronLeft } from "lucide-react";

/**
 * The way back out of a panel that Settings sent the user to (0.12.x).
 *
 * Zones are configurable from Settings → Zones, but the panels that do the
 * configuring — Configure Zones and the zone editor — are full screens, so
 * Settings closes and hands over rather than stacking a second modal. That
 * leaves the user one level deeper than they think they are, which is exactly
 * the situation a back button exists for. Rendered in the modal header, left of
 * the title, so it reads as a breadcrumb rather than as an action on the panel.
 */
export function BackToSettings({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Back to settings"
      className="-ml-1.5 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
    >
      <ChevronLeft size={14} />
      Settings
    </button>
  );
}
