import { saveTextFile } from "@/lib/saveFile";
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
export const CURATED_LIBRARY_VERSION = 10;

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
    thinkingEnabled: z.thinking ?? true,
    includeThinkingInContext: false,
    isLeader: z.isLeader ?? false,
    description: z.description,
    author: z.author ?? "MultiZone Team",
    source: z.source ?? "Curated",
    version: z.version ?? "v1.0.0",
    examples: z.examples ?? [],
    curatedTeam: z.preinstall !== false,
    team: z.team ?? null,
    createdAt: 0,
  }));
}

/** Write the curated presets into the on-disk library (idempotent — stable ids
 * mean repeated calls overwrite rather than duplicate). Also prunes curated
 * entries that are no longer shipped (e.g. a removed preset), leaving the
 * user's own snapshots/imports untouched. */
export async function seedCuratedLibrary(): Promise<void> {
  const entries = curatedEntries();
  const liveIds = new Set(entries.map((e) => e.id));
  for (const entry of entries) {
    try {
      await api.upsertLibraryEntry(entry);
    } catch (e) {
      console.error(`failed to seed library entry "${entry.name}":`, e);
    }
  }
  // Drop curated entries that were shipped before but no longer exist.
  try {
    const existing = await api.listLibraryEntries();
    for (const e of existing) {
      if (e.curated && !liveIds.has(e.id)) {
        await api.deleteLibraryEntry(e.id).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

/**
 * The shipped team an installed zone belongs to, or null.
 *
 * A live zone carries no team field of its own — a team is a property of the
 * preset *set* a zone was installed from, not of the zone afterwards — so this
 * matches by name, the same way the library decides whether an entry is already
 * installed. Derived from the in-code curated set, so it costs no disk read and
 * every list that shows zones can label them without loading the library.
 */
let teamByZoneName: Map<string, string> | null = null;
export function zoneTeamName(name: string): string | null {
  if (!teamByZoneName) {
    teamByZoneName = new Map();
    for (const e of curatedEntries()) {
      if (e.team) teamByZoneName.set(e.name.toLowerCase(), e.team);
    }
  }
  return teamByZoneName.get(name.trim().toLowerCase()) ?? null;
}

/** Export a live zone as a JSON file to a user-chosen path (re-importable via Add zones). */
export async function exportZoneJson(zone: Zone): Promise<void> {
  const data = {
    name: zone.name,
    icon: zone.icon,
    accentColor: zone.accentColor,
    model: zone.model,
    systemPrompt: zone.systemPrompt,
    temperature: zone.temperature,
    maxTokens: zone.maxTokens,
    topP: zone.topP,
    toolsEnabled: zone.toolsEnabled,
    toolConfig: zone.toolConfig,
    thinkingEnabled: zone.thinkingEnabled,
    thinkingEffort: zone.thinkingEffort,
    includeThinkingInContext: zone.includeThinkingInContext,
    isLeader: zone.isLeader,
  };
  const slug = zone.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "zone";
  await saveTextFile(`${slug}.json`, JSON.stringify(data, null, 2), [
    { name: "JSON", extensions: ["json"] },
  ]);
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
 * Install a library entry as a live zone that follows the chat's model (0.20.0).
 *
 * A zone is a role: instructions, tools, approvals. The model is left to the
 * chat — the composer's pick, else the base zone's — so a zone installed now
 * keeps working when another provider is added, and nobody re-installs a team
 * to move it to a new model. The editor can still pin one. An entry's saved
 * model is not carried over: provider ids don't travel between installs, so it
 * could only ever be a guess.
 */
export async function installEntry(entry: LibraryEntry, existingNames: string[]): Promise<Zone> {
  return api.upsertZone({
    name: uniqueZoneName(entry.name, existingNames),
    providerId: null,
    model: "",
    systemPrompt: entry.systemPrompt,
    temperature: entry.temperature,
    maxTokens: entry.maxTokens,
    topP: entry.topP,
    toolsEnabled: entry.toolsEnabled,
    toolConfig: entry.toolConfig,
    thinkingEnabled: entry.thinkingEnabled,
    thinkingEffort: entry.thinkingEffort ?? "medium",
    includeThinkingInContext: entry.includeThinkingInContext,
    isLeader: entry.isLeader,
    icon: entry.icon,
    accentColor: entry.accentColor,
  });
}

/**
 * Install every not-yet-installed member of a team in one action, leader first.
 *
 * Sequential rather than `Promise.all`: each install has to see the names the
 * previous one took, or two members that collide with an existing zone both get
 * suffixed "(2)". Individual failures are collected rather than thrown so one
 * bad member doesn't leave the team half-installed with no report of what
 * happened.
 */
export interface TeamInstallResult {
  installed: Zone[];
  failures: { name: string; error: string }[];
}

export async function installTeam(entries: LibraryEntry[], existingNames: string[]): Promise<TeamInstallResult> {
  const ordered = [...entries].sort(
    (a, b) => Number(b.isLeader) - Number(a.isLeader) || a.name.localeCompare(b.name),
  );
  const names = [...existingNames];
  const out: TeamInstallResult = { installed: [], failures: [] };
  for (const entry of ordered) {
    try {
      const zone = await installEntry(entry, names);
      names.push(zone.name);
      out.installed.push(zone);
    } catch (e) {
      out.failures.push({ name: entry.name, error: (e as Error).message ?? String(e) });
    }
  }
  return out;
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
    thinkingEffort: zone.thinkingEffort,
    includeThinkingInContext: zone.includeThinkingInContext,
    isLeader: zone.isLeader,
    description: null,
    author: "You",
    source: "Saved by you",
    version: "v1.0.0",
    examples: [],
    curatedTeam: false,
    team: null,
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
    temperature: typeof raw.temperature === "number" ? raw.temperature : null,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : null,
    topP: typeof raw.topP === "number" ? raw.topP : null,
    toolsEnabled,
    toolConfig: typeof raw.toolConfig === "string" ? raw.toolConfig : "{}",
    thinkingEnabled: typeof raw.thinkingEnabled === "boolean" ? raw.thinkingEnabled : true,
    thinkingEffort: raw.thinkingEffort === "low" || raw.thinkingEffort === "high" ? raw.thinkingEffort : "medium",
    includeThinkingInContext: !!raw.includeThinkingInContext,
    isLeader: !!raw.isLeader,
    description: raw.description ?? null,
    author: raw.author ?? "Imported",
    source: raw.source ?? "Imported file",
    version: raw.version ?? "v1.0.0",
    examples: Array.isArray(raw.examples) ? raw.examples.map(String) : [],
    curatedTeam: false,
    team: typeof raw.team === "string" && raw.team.trim() ? raw.team.trim() : null,
    createdAt: 0,
  });
}
