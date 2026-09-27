import { Plus, Layers } from "lucide-react";
import { useApp } from "@/store/app";
import { InstalledZones, useZoneActions } from "@/components/Zones/InstalledZones";

/**
 * Settings → Zones. Zones are configured in the Configure Zones panel (the zone
 * library), which is a whole screen of its own rather than something that fits
 * in a settings pane — so this tab is the door to it, plus the list of what is
 * installed so the door is worth opening from here at all.
 *
 * That list is the same component the Configure Zones rail uses (0.12.4). It
 * used to be a second, plainer one written here — same zones, same action, two
 * looks — which is exactly the kind of split that makes an app feel like
 * several apps. Opening a zone lands in the same editor from either side too:
 * `openZoneEditor` goes through Configure Zones wherever it is called from.
 *
 * Both destinations close Settings and leave a breadcrumb (`returnTo`) instead
 * of stacking a second modal on top of it: the panel that opens shows a "Back
 * to settings" button that lands the user back on this tab.
 */
export function ZonesTab() {
  const zones = useApp((s) => s.zones);
  const openZoneLibrary = useApp((s) => s.openZoneLibrary);
  const openZoneEditor = useApp((s) => s.openZoneEditor);
  const zoneActions = useZoneActions({ onEdit: (id) => openZoneEditor(id, "settings") });

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">Zones</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openZoneEditor(null, "settings")}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <Plus size={12} /> New zone
          </button>
          <button
            onClick={() => openZoneLibrary("settings")}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <Layers size={12} /> Configure Zones
          </button>
        </div>
      </div>

      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        A zone is an assistant with its own model, prompt and tools.
      </p>

      {zones.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-text-muted)]">
          No zones yet.{" "}
          <button onClick={() => openZoneLibrary("settings")} className="text-[var(--color-accent)] hover:underline">
            Browse the library
          </button>{" "}
          or create one.
        </div>
      ) : (
        <>
          <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Installed · {zones.length}
          </div>
          <InstalledZones
            actions={zoneActions}
            onOpen={(id) => openZoneEditor(id, "settings")}
          />
          {zoneActions.menuElement}
        </>
      )}
    </>
  );
}

// ─── Providers ────────────────────────────────────────────────────────────────
