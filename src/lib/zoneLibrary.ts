/**
 * Zone library helpers. The library itself is a folder of JSON files on disk
 * (see commands/library.rs); these helpers handle the app-side logic: seeding
 * the curated presets, installing an entry as a live zone, and snapshotting a
 * zone back into the library.
 */
import * as api from "@/lib/tauri";
import type { LibraryEntry, Zone } from "@/lib/types";
import { DEFAULT_ZONES } from "@/lib/defaultZones";

/** Bump when the shipped curated set changes so existing installs re-seed the
 * library (idempotent — stable ids overwrite, user snapshots are untouched). */
export const CURATED_LIBRARY_VERSION = 2;

/** Stable, content-independent id for a curated entry so re-seeding overwrites
 * the same file instead of creating duplicates. */
function curatedId(name: string): string {
  return "curated-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** The curated presets, derived from DEFAULT_ZONES, as library entries. */
export function curatedEntries(): LibraryEntry[] {
  return DEFAULT_ZONES.map((z) => ({
    id: curatedId(z.name),
    name: z.name,
    curated: true,
    icon: z.icon,
    accentColor: z.accentColor,
    model: null, // bound to the user's default provider/model on install
    systemPrompt: z.systemPrompt,
    temperature: z.temperature,
    maxTokens: null,
    topP: null,
    toolsEnabled: JSON.stringify(z.tools),
    toolConfig: "{}",
    thinkingEnabled: false,
    includeThinkingInContext: false,
    description: z.description,
    author: z.author ?? "MultiZone Team",
    source: z.source ?? "Curated",
    version: z.version ?? "v1.0.0",
    examples: z.examples ?? [],
    curatedTeam: z.preinstall !== false,
    createdAt: 0,
  }));
}

/** Write the curated presets into the on-disk library (idempotent — stable ids
 * mean repeated calls overwrite rather than duplicate). */
export async function seedCuratedLibrary(): Promise<void> {
  for (const entry of curatedEntries()) {
    try {
      await api.upsertLibraryEntry(entry);
    } catch (e) {
      console.error(`failed to seed library entry "${entry.name}":`, e);
    }
  }
}

/** Pick a zone name not already taken, suffixing " (2)", " (3)", … if needed. */
export function uniqueZoneName(name: string, existingNames: string[]): string {
  const taken = new Set(existingNames);
  if (!taken.has(name)) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} ${Date.now()}`;
}

/**
 * Install a library entry as a live zone, bound to the given provider + model.
 * The entry's own model is preferred when set (a user snapshot), otherwise the
 * caller's resolved default model is used. Name collisions are de-duplicated.
 */
export async function installEntry(
  entry: LibraryEntry,
  providerId: string,
  model: string,
  existingNames: string[],
): Promise<Zone> {
  return api.upsertZone({
    name: uniqueZoneName(entry.name, existingNames),
    providerId,
    model: entry.model?.trim() || model,
    systemPrompt: entry.systemPrompt,
    temperature: entry.temperature,
    maxTokens: entry.maxTokens,
    topP: entry.topP,
    toolsEnabled: entry.toolsEnabled,
    toolConfig: entry.toolConfig,
    thinkingEnabled: entry.thinkingEnabled,
    includeThinkingInContext: entry.includeThinkingInContext,
    icon: entry.icon,
    accentColor: entry.accentColor,
  });
}

/** Snapshot a live zone into the library as a user (non-curated) entry. */
export async function saveZoneToLibrary(zone: Zone): Promise<LibraryEntry> {
  return api.upsertLibraryEntry({
    id: "", // backend assigns a fresh id
    name: zone.name,
    curated: false,
    icon: zone.icon,
    accentColor: zone.accentColor,
    model: zone.model || null,
    systemPrompt: zone.systemPrompt,
    temperature: zone.temperature,
    maxTokens: zone.maxTokens,
    topP: zone.topP,
    toolsEnabled: zone.toolsEnabled,
    toolConfig: zone.toolConfig,
    thinkingEnabled: zone.thinkingEnabled,
    includeThinkingInContext: zone.includeThinkingInContext,
    description: null,
    author: "You",
    source: "Saved by you",
    version: "v1.0.0",
    examples: [],
    curatedTeam: false,
    createdAt: 0,
  });
}

/** Parse an imported JSON blob (an exported zone or library entry) into a
 * non-curated library entry and save it. Tolerates partial/foreign shapes. */
export async function importEntryFromJson(text: string, fallbackName: string): Promise<LibraryEntry> {
  let raw: Record<string, any> = {};
  try {
    raw = JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error("Not valid JSON");
  }
  const toolsEnabled =
    typeof raw.toolsEnabled === "string"
      ? raw.toolsEnabled
      : Array.isArray(raw.tools)
      ? JSON.stringify(raw.tools)
      : Array.isArray(raw.toolsEnabled)
      ? JSON.stringify(raw.toolsEnabled)
      : "[]";
  return api.upsertLibraryEntry({
    id: "",
    name: (raw.name || fallbackName || "Imported Zone").toString().slice(0, 60),
    curated: false,
    icon: raw.icon ?? "Box",
    accentColor: raw.accentColor ?? "#7c5cff",
    model: raw.model ?? null,
    systemPrompt: raw.systemPrompt ?? raw.system ?? null,
    temperature: typeof raw.temperature === "number" ? raw.temperature : 0.7,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : null,
    topP: typeof raw.topP === "number" ? raw.topP : null,
    toolsEnabled,
    toolConfig: typeof raw.toolConfig === "string" ? raw.toolConfig : "{}",
    thinkingEnabled: !!raw.thinkingEnabled,
    includeThinkingInContext: !!raw.includeThinkingInContext,
    description: raw.description ?? null,
    author: raw.author ?? "Imported",
    source: raw.source ?? "Imported file",
    version: raw.version ?? "v1.0.0",
    examples: Array.isArray(raw.examples) ? raw.examples.map(String) : [],
    curatedTeam: false,
    createdAt: 0,
  });
}
