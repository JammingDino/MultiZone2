import { useState } from "react";
import { X, Plus, Star, Sparkles, Loader2 } from "lucide-react";
import { useApp } from "@/store/app";
import type { Zone } from "@/lib/types";
import { getZoneIcon } from "@/lib/zoneIcons";
import { seedDefaultZones } from "@/lib/defaultZones";
import { ZoneForm } from "./ZoneForm";

export function ZonesPanel() {
  const { providers, zones, defaultZoneId, closeZonesPanel, refreshZones, setDefaultZone } =
    useApp();
  const defaultProviderId = useApp((s) => s.appSettings.defaultProviderId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNewZone, setIsNewZone] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const quickProvider = providers.find((p) => p.id === (defaultProviderId ?? providers[0]?.id)) ?? null;
  const quickModel = quickProvider?.defaultModel?.trim() || null;

  async function addStarterZones() {
    if (!quickProvider || !quickModel) return;
    setSeeding(true);
    try {
      await seedDefaultZones(quickProvider.id, quickModel, zones.map((z) => z.name));
      await refreshZones();
    } finally {
      setSeeding(false);
    }
  }

  const selectedZone = zones.find((z) => z.id === selectedId) ?? null;
  const showForm = isNewZone || selectedId !== null;

  async function onSaved(saved: Zone) {
    await refreshZones();
    setSelectedId(saved.id);
    setIsNewZone(false);
  }

  async function onDeleted() {
    await refreshZones();
    setSelectedId(null);
    setIsNewZone(false);
  }

  function selectZone(zone: Zone) {
    setSelectedId(zone.id);
    setIsNewZone(false);
  }

  function startNewZone() {
    setSelectedId(null);
    setIsNewZone(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeZonesPanel}>
      <div className="flex h-[700px] w-[960px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div className="font-medium">Configure Zones</div>
          <button
            onClick={closeZonesPanel}
            className="rounded p-1 hover:bg-[var(--color-panel-hover)]"
          >
            <X size={16} />
          </button>
        </div>

        {/* Two-pane body */}
        <div className="flex min-h-0 flex-1">
          {/* Left: zone list */}
          <div className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)]">
            <div className="border-b border-[var(--color-border)] p-2">
              <button
                onClick={startNewZone}
                className={`flex w-full items-center justify-center gap-1.5 rounded border border-dashed py-2 text-xs transition ${
                  isNewZone
                    ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                    : "border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                }`}
              >
                <Plus size={12} /> New Zone
              </button>
              <button
                onClick={addStarterZones}
                disabled={seeding || !quickModel}
                title={
                  !quickModel
                    ? "Set a default model in Settings → Providers first"
                    : "Add the built-in starter zones (skips any you already have)"
                }
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-[var(--color-border)] py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {seeding ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                Add starter zones
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-1">
              {zones.length === 0 && (
                <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">
                  No zones yet. Create one to get started.
                </div>
              )}
              {zones.map((zone) => {
                const isSelected = zone.id === selectedId && !isNewZone;
                const isDefault = zone.id === defaultZoneId;
                const ZoneIcon = getZoneIcon(zone.icon);
                const color = zone.accentColor ?? "var(--color-accent)";
                return (
                  <div
                    key={zone.id}
                    onClick={() => selectZone(zone)}
                    className={`group flex cursor-pointer items-center gap-2 px-2 py-2 transition ${
                      isSelected
                        ? "bg-[var(--color-panel-hover)]"
                        : "hover:bg-[var(--color-panel-hover)]"
                    }`}
                  >
                    {/* Zone avatar */}
                    <div
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md shadow-sm"
                      style={{ background: color }}
                    >
                      <ZoneIcon size={14} color="white" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className="truncate text-sm font-medium">{zone.name}</span>
                        {isDefault && (
                          <Star
                            size={10}
                            className="shrink-0 fill-current text-[var(--color-accent)]"
                          />
                        )}
                      </div>
                      <div className="truncate text-xs text-[var(--color-text-muted)]">
                        {zone.model}
                      </div>
                    </div>

                    {/* Default toggle — visible on hover */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDefaultZone(isDefault ? null : zone.id);
                      }}
                      title={isDefault ? "Remove as default" : "Set as default for new chats"}
                      className={`shrink-0 rounded p-0.5 transition hover:scale-110 ${
                        isDefault
                          ? "text-[var(--color-accent)]"
                          : "text-[var(--color-text-muted)] opacity-0 group-hover:opacity-60"
                      }`}
                    >
                      <Star size={11} className={isDefault ? "fill-current" : ""} />
                    </button>
                  </div>
                );
              })}
            </div>

            {defaultZoneId && (
              <div className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
                <Star size={9} className="mr-1 inline fill-current text-[var(--color-accent)]" />
                starred = default for new chats
              </div>
            )}
          </div>

          {/* Right: form or placeholder */}
          <div className="flex min-w-0 flex-1 flex-col">
            {showForm ? (
              <ZoneForm
                zone={isNewZone ? null : selectedZone}
                providers={providers}
                onSaved={onSaved}
                onDeleted={onDeleted}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[var(--color-text-muted)]">
                <div className="text-sm">Select a zone to edit, or create a new one.</div>
                <div className="text-xs">Star a zone to make it the default for new chats.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
