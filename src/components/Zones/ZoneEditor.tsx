import { useMemo } from "react";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import type { Zone } from "@/lib/types";
import { ZoneForm } from "./ZoneForm";
import { Modal, ModalTitle } from "@/components/common/Modal";

export function ZoneEditor() {
  const { providers, zones, editingZoneId, closeZoneEditor, refreshZones } = useApp(
    useShallow((s) => ({
      providers: s.providers,
      zones: s.zones,
      editingZoneId: s.editingZoneId,
      closeZoneEditor: s.closeZoneEditor,
      refreshZones: s.refreshZones,
    })),
  );
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
    <Modal
      onClose={closeZoneEditor}
      className="h-[700px] w-[800px]"
      header={<ModalTitle>{existing ? "Edit zone" : "New zone"}</ModalTitle>}
    >
      <ZoneForm
        zone={existing}
        providers={providers}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
    </Modal>
  );
}
