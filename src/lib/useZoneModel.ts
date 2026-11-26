import { useApp } from "@/store/app";
import { resolveZoneRun } from "./baseZone";
import type { Zone } from "./types";

/** The model a zone runs on, for display — resolved when it follows the chat. */
export function useZoneModel(): (zone: Pick<Zone, "id" | "providerId" | "model"> | null | undefined) => string {
  const providers = useApp((s) => s.providers);
  const zones = useApp((s) => s.zones);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  return (zone) => (zone ? resolveZoneRun(zone, providers, zones, baseZoneId).model : "");
}
