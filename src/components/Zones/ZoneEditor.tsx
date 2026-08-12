import { useMemo } from "react";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import type { Zone } from "@/lib/types";
import { ZoneForm } from "./ZoneForm";
import { Modal, ModalTitle } from "@/components/common/Modal";
import { BackToSettings } from "@/components/common/BackToSettings";

export function ZoneEditor() {
  const { providers, zones, editingZoneId, closeZoneEditor, refreshZones, returnTo, returnFromZoneEditor } = useApp(
    useShallow((s) => ({
      providers: s.providers,
      zones: s.zones,
      editingZoneId: s.editingZoneId,
      closeZoneEditor: s.closeZoneEditor,
      refreshZones: s.refreshZones,
      returnTo: s.zoneEditorReturnTo,
      returnFromZoneEditor: s.returnFromZoneEditor,
    })),
  );
  const existing = useMemo(
    () => zones.find((z) => z.id === editingZoneId) ?? null,
    [zones, editingZoneId],
  );

  // Finishing here goes back where the user came from — Settings, when Settings
  // → Zones opened this editor; otherwise simply closed.
  const leave = returnTo ? returnFromZoneEditor : closeZoneEditor;

  async function onSaved(_saved: Zone) {
    await refreshZones();
    leave();
  }

  async function onDeleted() {
    await refreshZones();
    leave();
  }

  return (
    <Modal
      onClose={leave}
      className="h-[700px] w-[800px]"
      header={
        <>
          {returnTo === "settings" && <BackToSettings onClick={returnFromZoneEditor} />}
          <ModalTitle>{existing ? "Edit zone" : "New zone"}</ModalTitle>
        </>
      }
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
