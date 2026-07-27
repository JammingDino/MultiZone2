/**
 * Resolving the app-wide default assistant (0.9.9).
 *
 * There is one setting for this — `baseZoneId`, the Quick Chat base zone. It
 * replaced a second `defaultProviderId` setting that answered the same question
 * ("what runs when no zone is chosen?") one rung lower and could disagree with
 * it. A zone already names a provider, so the provider follows from the zone;
 * with no base zone set, the first provider is the floor. The Rust side applies
 * exactly this order in `effective_zone_and_provider`.
 */
import type { Provider, Zone } from "./types";

/**
 * The provider behind the base zone, or the first provider when no base zone is
 * set (or its zone/provider has since been deleted). Null only when the user
 * has no providers at all — i.e. before onboarding.
 */
export function resolveBaseProvider(
  providers: Provider[],
  zones: Zone[],
  baseZoneId: string | null,
): Provider | null {
  const zone = zones.find((z) => z.id === baseZoneId) ?? null;
  const fromZone = zone?.providerId
    ? providers.find((p) => p.id === zone.providerId) ?? null
    : null;
  return fromZone ?? providers[0] ?? null;
}

/** The base zone itself, or null when Quick Chat falls back to a bare model. */
export function resolveBaseZone(zones: Zone[], baseZoneId: string | null): Zone | null {
  return zones.find((z) => z.id === baseZoneId) ?? null;
}

/**
 * The model a Quick Chat would actually run: the base zone's model, else the
 * fallback provider's default model. Empty string when nothing is configured
 * yet — which is what the UI checks to decide whether Quick Chat is offered.
 */
export function resolveBaseModel(
  providers: Provider[],
  zones: Zone[],
  baseZoneId: string | null,
): string {
  const zone = resolveBaseZone(zones, baseZoneId);
  if (zone?.model?.trim()) return zone.model.trim();
  return resolveBaseProvider(providers, zones, baseZoneId)?.defaultModel?.trim() ?? "";
}
