import { useMemo } from "react";
import { X } from "lucide-react";
import { useApp } from "@/store/app";
import type { Zone } from "@/lib/types";
import { ZoneForm } from "./ZoneForm";

export function ZoneEditor() {
  const { providers, zones, editingZoneId, closeZoneEditor, refreshZones } = useApp();
  const existing = useMemo(
    () => zones.find((z) => z.id === editingZoneId) ?? null,
    [zones, editingZoneId],
  );

  async function onSaved(_saved: Zone) {
    await refreshZones();
    closeZoneEditor();
  }

  async function onDeleted() {
    await refreshZones();
    closeZoneEditor();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex h-[700px] w-[800px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div className="font-medium">{existing ? "Edit zone" : "New zone"}</div>
          <button
            onClick={closeZoneEditor}
            className="rounded p-1 hover:bg-[var(--color-panel-hover)]"
          >
            <X size={16} />
          </button>
        </div>
        <ZoneForm
          zone={existing}
          providers={providers}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      </div>
    </div>
  );
}
