import { useMemo, useState } from "react";
import { Crown, Download, Pencil, Settings as SettingsIcon, Star, Trash2 } from "lucide-react";
import { Popover, pointRect } from "@/components/common/Popover";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import type { Zone } from "@/lib/types";
import { getZoneIcon } from "@/lib/zoneIcons";
import { exportZoneJson, zoneTeamName } from "@/lib/zoneLibrary";

/**
 * The list of installed zones, shared by every place that shows one — the
 * Configure Zones rail and Settings → Zones (0.12.4).
 *
 * Those two used to be different components: a rich rail with coloured icons on
 * one side and a bare table of names on the other, for the same objects and the
 * same action. Sharing the list is the fix, not copying the styles across —
 * copies drift, and this one already had.
 *
 * Rows group under the team they were installed as part of, so a Response
 * Leader and the specialists it delegates to read as the set they are rather
 * than as seven unrelated entries in alphabetical order.
 */

/** One team's zones, or the leftovers when `team` is null. */
interface ZoneGroup {
  team: string | null;
  zones: Zone[];
}

function groupByTeam(zones: Zone[]): ZoneGroup[] {
  const teams = new Map<string, Zone[]>();
  const loose: Zone[] = [];
  for (const z of zones) {
    const team = zoneTeamName(z.name);
    if (!team) {
      loose.push(z);
      continue;
    }
    const list = teams.get(team) ?? [];
    list.push(z);
    teams.set(team, list);
  }
  const groups: ZoneGroup[] = [...teams.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    // Leader first inside a team — it is the one you configure the others around.
    .map(([team, members]) => ({
      team,
      zones: members.sort((a, b) => Number(b.isLeader) - Number(a.isLeader) || a.name.localeCompare(b.name)),
    }));
  if (loose.length > 0) groups.push({ team: null, zones: loose });
  return groups;
}

/**
 * Rename, export and delete for a zone, plus the right-click menu that offers
 * them. Held in a hook rather than inside the list because the library also
 * hangs this menu off its library cards, and a second copy of the state would
 * mean a rename started from a card couldn't be finished in the rail.
 */
export function useZoneActions({
  onEdit,
  onNotify,
}: {
  /** Open the zone's editor — where that lands is the caller's business. */
  onEdit: (zoneId: string) => void;
  /** Optional confirmation text, for callers that have somewhere to put it. */
  onNotify?: (message: string) => void;
}) {
  const refreshZones = useApp((s) => s.refreshZones);
  const [menu, setMenu] = useState<{ zone: Zone; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function openMenu(zone: Zone, ev: React.MouseEvent) {
    ev.preventDefault();
    setMenu({ zone, x: ev.clientX, y: ev.clientY });
  }

  function startRename(zone: Zone) {
    setMenu(null);
    setRenameValue(zone.name);
    setRenamingId(zone.id);
  }

  async function commitRename(zone: Zone) {
    const next = renameValue.trim();
    setRenamingId(null);
    if (!next || next === zone.name) return;
    try {
      await api.upsertZone({ ...zone, name: next });
      await refreshZones();
      onNotify?.(`Renamed to “${next}”`);
    } catch (e) {
      console.error(e);
    }
  }

  async function onDelete(zone: Zone) {
    setMenu(null);
    try {
      await api.deleteZone(zone.id);
      await refreshZones();
      onNotify?.(`Deleted “${zone.name}”`);
    } catch (e) {
      console.error(e);
    }
  }

  function onExport(zone: Zone) {
    setMenu(null);
    exportZoneJson(zone);
    onNotify?.(`Exported “${zone.name}”`);
  }

  const menuElement = menu ? (
    <ZoneContextMenu
      x={menu.x}
      y={menu.y}
      onClose={() => setMenu(null)}
      onEdit={() => {
        const z = menu.zone;
        setMenu(null);
        onEdit(z.id);
      }}
      onRename={() => startRename(menu.zone)}
      onExport={() => onExport(menu.zone)}
      onDelete={() => onDelete(menu.zone)}
    />
  ) : null;

  return {
    openMenu,
    menuElement,
    renamingId,
    renameValue,
    setRenameValue,
    commitRename,
    cancelRename: () => setRenamingId(null),
  };
}

export type ZoneActions = ReturnType<typeof useZoneActions>;

export function InstalledZones({
  actions,
  activeZoneId = null,
  onOpen,
  emptyText = "No zones installed yet.",
}: {
  actions: ZoneActions;
  /** Highlighted row — the zone currently open in an editor, if any. */
  activeZoneId?: string | null;
  onOpen: (zoneId: string) => void;
  emptyText?: string;
}) {
  const zones = useApp((s) => s.zones);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  const defaultZoneId = useApp((s) => s.defaultZoneId);
  const groups = useMemo(() => groupByTeam(zones), [zones]);

  if (zones.length === 0) {
    return <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">{emptyText}</div>;
  }

  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <div key={group.team ?? "__loose__"}>
          {/* Only worth a heading when there is something to tell apart: a
              install with no teams is just a list. */}
          {groups.length > 1 && (
            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              {group.team ?? "Other zones"}
            </div>
          )}
          {group.zones.map((z) => {
            const Icon = getZoneIcon(z.icon);
            const accent = z.accentColor ?? "var(--color-accent)";
            if (actions.renamingId === z.id) {
              return (
                <div key={z.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                  <span
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
                    style={{ background: accent }}
                  >
                    <Icon size={15} color="white" />
                  </span>
                  <input
                    autoFocus
                    value={actions.renameValue}
                    onChange={(e) => actions.setRenameValue(e.target.value)}
                    onBlur={() => actions.commitRename(z)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") actions.commitRename(z);
                      // Cancelling the rename is all Escape does here — it must
                      // not also close the panel behind it.
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        actions.cancelRename();
                      }
                    }}
                    className="min-w-0 flex-1 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[13px] outline-none"
                  />
                </div>
              );
            }
            return (
              <button
                key={z.id}
                onClick={() => onOpen(z.id)}
                onContextMenu={(e) => actions.openMenu(z, e)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-panel-hover)] ${
                  activeZoneId === z.id ? "bg-[var(--color-panel-hover)]" : ""
                }`}
              >
                <span
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
                  style={{ background: accent }}
                >
                  <Icon size={15} color="white" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-[13px] font-medium leading-tight">{z.name}</span>
                    {z.isLeader && (
                      <Crown
                        size={11}
                        className="flex-shrink-0 text-amber-500"
                        aria-label="Response Leader"
                      />
                    )}
                    {z.id === defaultZoneId && (
                      <Star
                        size={11}
                        className="flex-shrink-0 fill-current text-[var(--color-accent)]"
                        aria-label="Default zone for new chats"
                      />
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                    {z.model}
                    {z.id === baseZoneId && (
                      <span className="ml-1.5 rounded bg-[var(--color-panel-hover)] px-1 py-px text-[9.5px] uppercase tracking-wide">
                        base
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function ZoneContextMenu({
  x, y, onClose, onEdit, onRename, onExport, onDelete,
}: {
  x: number; y: number; onClose: () => void;
  onEdit: () => void; onRename: () => void; onExport: () => void; onDelete: () => void;
}) {
  return (
    <Popover
      open
      onClose={onClose}
      anchorRect={pointRect(x, y)}
      zIndex={70}
      className="min-w-[160px] rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-2xl"
    >
      <div>
        <MenuItem icon={<SettingsIcon size={13} />} label="Edit" onClick={onEdit} />
        <MenuItem icon={<Pencil size={13} />} label="Rename" onClick={onRename} />
        <MenuItem icon={<Download size={13} />} label="Export JSON" onClick={onExport} />
        <div className="my-1 border-t border-[var(--color-border)]" />
        <MenuItem icon={<Trash2 size={13} />} label="Delete" onClick={onDelete} danger />
      </div>
    </Popover>
  );
}

function MenuItem({
  icon, label, onClick, danger,
}: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--color-panel-hover)] ${danger ? "text-[var(--color-danger)]" : ""}`}
    >
      {icon} {label}
    </button>
  );
}
