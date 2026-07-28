/**
 * Settings export / import (0.9.9, reworked for 1.0).
 *
 * One JSON file that carries a MultiZone setup — providers, zones, skills, MCP
 * servers, global memories, preferences and theme — so a second machine can be
 * brought up to match without re-entering any of it by hand.
 *
 * Three rules shape what goes in and how it lands:
 *
 * - **Nothing is silently duplicated.** A row matching an existing one *by id*
 *   is an update (re-importing the same bundle edits in place). A row matching
 *   an existing one *by name* is skipped — the local copy wins, because a
 *   second provider called "OpenAI" is never what anyone wanted.
 * - **References are rewritten, not trusted.** Skipping a same-named provider
 *   would leave every imported zone pointing at a provider id this install has
 *   never heard of — a zone with a model but no provider, which fails at send
 *   time with nothing to explain it. `planSettingsImport` builds an id map and
 *   `applySettingsBundle` rewrites `providerId`, `baseZoneId`, `sttProviderId`
 *   and `ttsProviderId` through it.
 * - **Machine-local values are left out.** Filesystem paths and the local API
 *   token mean nothing on another machine (and the paths may not exist), so the
 *   importing install keeps its own. Everything excluded is listed in
 *   `LOCAL_ONLY_SETTINGS` with the reason.
 *
 * Every section is opt-in on export (`ExportSelection`) — sharing a couple of
 * providers with a colleague shouldn't also push your theme and your memories
 * at them.
 *
 * Chats, messages, projects and tags are *not* settings and are never included
 * — the markdown mirror in Settings → Data is the tool for content.
 */
import type { AppSettings, McpServerView, Memory, Provider, Skill, Zone } from "./types";
import type { ThemePrefs } from "@/store/app";
import * as api from "./tauri";

export const BUNDLE_KIND = "multizone.settings";
/** v2 added `memories`, `providerNames` and per-section export selection. */
export const BUNDLE_VERSION = 2;

/**
 * App-settings keys deliberately dropped on export. Paths are machine-local and
 * may not even exist on the other side, the seeding flags describe what *this*
 * install has already done for itself, and the API token is a local secret that
 * should be regenerated per machine.
 */
const LOCAL_ONLY_SETTINGS = [
  "defaultDirectory",      // filesystem path — each install defaults it to Downloads
  "markdownMirrorDir",     // filesystem path
  "sttInputDevice",        // a microphone that exists on this machine
  "apiToken",              // local secret; regenerate on the other machine
  "seededStarterZones",    // one-time seeding bookkeeping
  "seededLibrary",
  "seededSkills",
  "libraryCuratedVersion",
  "onboardingSkipped",     // this install's own first-run state
] as const satisfies readonly (keyof AppSettings)[];

/** A provider as exported. `apiKey` is null when keys were excluded. */
export type BundleProvider = Pick<Provider, "id" | "name" | "baseUrl" | "apiKey" | "defaultModel">;
export type BundleZone = Omit<Zone, "createdAt" | "updatedAt">;
export type BundleSkill = Pick<Skill, "id" | "name" | "description" | "content" | "enabled">;
/** Only global memories travel — project/chat-scoped ones point at content that isn't in the bundle. */
export type BundleMemory = Pick<Memory, "id" | "content">;
export interface BundleMcpServer {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  url: string | null;
  env: string | null;
  enabled: boolean;
}

export interface SettingsBundle {
  kind: typeof BUNDLE_KIND;
  version: number;
  exportedAt: string;
  /** The MultiZone version that wrote the file — informational. */
  appVersion?: string;
  /** True when provider API keys were included. */
  includesSecrets: boolean;
  appSettings: Partial<AppSettings>;
  theme: Partial<ThemePrefs>;
  providers: BundleProvider[];
  zones: BundleZone[];
  skills: BundleSkill[];
  mcpServers: BundleMcpServer[];
  memories: BundleMemory[];
  /**
   * Provider id → name for *every* provider referenced by the exported zones and
   * settings, including providers the user chose not to export. Lets the import
   * side resolve a reference by name instead of dropping it on the floor.
   */
  providerNames: Record<string, string>;
}

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * What to put in the file. Ids select individual rows; `null` means "all of
 * this kind", which keeps a full backup honest as new rows are added.
 */
export interface ExportSelection {
  preferences: boolean;
  theme: boolean;
  memories: boolean;
  includeSecrets: boolean;
  providerIds: string[] | null;
  zoneIds: string[] | null;
  skillIds: string[] | null;
  mcpServerIds: string[] | null;
}

export const DEFAULT_EXPORT_SELECTION: ExportSelection = {
  preferences: true,
  theme: true,
  memories: true,
  includeSecrets: true,
  providerIds: null,
  zoneIds: null,
  skillIds: null,
  mcpServerIds: null,
};

/** `null` selects everything; otherwise keep only the listed ids. */
function pick<T extends { id: string }>(rows: T[], ids: string[] | null): T[] {
  if (ids === null) return rows;
  const want = new Set(ids);
  return rows.filter((r) => want.has(r.id));
}

/** What a bundle contains, for the confirmation UI on both ends. */
export interface BundleCounts {
  providers: number;
  zones: number;
  skills: number;
  mcpServers: number;
  memories: number;
}

export function bundleCounts(b: SettingsBundle): BundleCounts {
  return {
    providers: b.providers.length,
    zones: b.zones.length,
    skills: b.skills.length,
    mcpServers: b.mcpServers.length,
    memories: b.memories.length,
  };
}

/** Human-readable "3 providers, 5 zones and 2 skills", skipping empty sections. */
export function describeCounts(c: BundleCounts): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many = one + "s") => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(c.providers, "provider");
  add(c.zones, "zone");
  add(c.skills, "skill");
  add(c.mcpServers, "MCP server");
  add(c.memories, "memory", "memories");
  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

/** Strip the machine-local keys out of the settings blob. */
function portableSettings(settings: AppSettings): Partial<AppSettings> {
  const out: Record<string, unknown> = { ...settings };
  for (const k of LOCAL_ONLY_SETTINGS) delete out[k];
  return out as Partial<AppSettings>;
}

/**
 * Collect the current setup into a bundle. `selection.includeSecrets` controls
 * whether provider API keys travel with it — off produces a file that is safe to
 * share, but the other machine has to re-enter every key.
 */
export async function buildSettingsBundle(
  settings: AppSettings,
  theme: ThemePrefs,
  selection: ExportSelection = DEFAULT_EXPORT_SELECTION,
  appVersion?: string,
): Promise<SettingsBundle> {
  const [allProviders, allZones, allSkills, allMcpServers, allMemories] = await Promise.all([
    api.listProviders(),
    api.listZones(),
    api.listSkills(),
    api.listMcpServers(),
    selection.memories ? api.listMemories() : Promise.resolve([] as Memory[]),
  ]);

  const providers = pick(allProviders, selection.providerIds);
  const zones = pick(allZones, selection.zoneIds);
  const skills = pick(allSkills, selection.skillIds);
  const mcpServers = pick(allMcpServers, selection.mcpServerIds);

  const appSettings = selection.preferences ? portableSettings(settings) : {};

  // Name every provider the exported rows point at, even ones left out of the
  // selection, so the far side can still resolve the reference by name.
  const providerNames: Record<string, string> = {};
  const noteProvider = (id: string | null | undefined) => {
    if (!id) return;
    const p = allProviders.find((x) => x.id === id);
    if (p) providerNames[p.id] = p.name;
  };
  for (const p of providers) providerNames[p.id] = p.name;
  for (const z of zones) noteProvider(z.providerId);
  if (selection.preferences) {
    noteProvider(settings.sttProviderId);
    noteProvider(settings.ttsProviderId);
  }

  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion,
    includesSecrets: selection.includeSecrets && providers.length > 0,
    appSettings,
    theme: selection.theme ? theme : {},
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: selection.includeSecrets ? p.apiKey : null,
      defaultModel: p.defaultModel,
    })),
    zones: zones.map(({ createdAt: _c, updatedAt: _u, ...rest }) => rest),
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      content: s.content,
      enabled: s.enabled,
    })),
    mcpServers: mcpServers.map((s: McpServerView) => ({
      id: s.id,
      name: s.name,
      transport: s.transport,
      command: s.command,
      url: s.url,
      env: s.env,
      enabled: s.enabled,
    })),
    memories: allMemories
      .filter((m) => m.scope === "global")
      .map((m) => ({ id: m.id, content: m.content })),
    providerNames,
  };
}

export function serializeSettingsBundle(bundle: SettingsBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Parse and validate a bundle file. Throws with a readable message rather than
 * letting a wrong file (a zone export, say) half-apply.
 */
export function parseSettingsBundle(raw: string): SettingsBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("That file isn't a settings export.");
  const b = parsed as Partial<SettingsBundle>;
  if (b.kind !== BUNDLE_KIND) {
    throw new Error("That file isn't a MultiZone settings export.");
  }
  if (typeof b.version !== "number" || b.version > BUNDLE_VERSION) {
    throw new Error(
      `That export was written by a newer MultiZone (format v${b.version}). Update this install first.`,
    );
  }
  return {
    kind: BUNDLE_KIND,
    version: b.version,
    exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : "",
    appVersion: typeof b.appVersion === "string" ? b.appVersion : undefined,
    includesSecrets: b.includesSecrets === true,
    appSettings: (b.appSettings ?? {}) as Partial<AppSettings>,
    theme: (b.theme ?? {}) as Partial<ThemePrefs>,
    providers: Array.isArray(b.providers) ? b.providers : [],
    zones: Array.isArray(b.zones) ? b.zones : [],
    skills: Array.isArray(b.skills) ? b.skills : [],
    mcpServers: Array.isArray(b.mcpServers) ? b.mcpServers : [],
    // v1 files predate both of these.
    memories: Array.isArray(b.memories) ? b.memories : [],
    providerNames: b.providerNames && typeof b.providerNames === "object" ? b.providerNames : {},
  };
}

// ─── Import planning ──────────────────────────────────────────────────────────

/**
 * What will happen to one incoming row:
 * - `create` — nothing local matches; it's added under its original id.
 * - `update` — a local row has the same id; it's overwritten (a re-import).
 * - `skip`   — a local row has the same name; the local one is kept untouched
 *              and every reference to the incoming row is pointed at it.
 */
export type Disposition = "create" | "update" | "skip";

export interface PlanRow<T> {
  item: T;
  disposition: Disposition;
  /** The local row this resolves to — the incoming id for `create`. */
  targetId: string;
  /** Name of the local row that caused a `skip`, for the preview UI. */
  conflictWith?: string;
}

export interface ImportPlan {
  providers: PlanRow<BundleProvider>[];
  zones: PlanRow<BundleZone>[];
  skills: PlanRow<BundleSkill>[];
  mcpServers: PlanRow<BundleMcpServer>[];
  memories: PlanRow<BundleMemory>[];
  /** Incoming provider id → the provider id this install will actually use. */
  providerIdMap: Record<string, string>;
  /** Incoming zone id → the zone id this install will actually use. */
  zoneIdMap: Record<string, string>;
  /** Names of incoming zones whose provider can't be resolved here at all. */
  unresolvedProviderZones: string[];
  includePreferences: boolean;
  includeTheme: boolean;
}

/** The local rows an import is reconciled against. */
export interface LocalSnapshot {
  providers: Provider[];
  zones: Zone[];
  skills: Skill[];
  mcpServers: McpServerView[];
  memories: Memory[];
}

export async function readLocalSnapshot(): Promise<LocalSnapshot> {
  const [providers, zones, skills, mcpServers, memories] = await Promise.all([
    api.listProviders(),
    api.listZones(),
    api.listSkills(),
    api.listMcpServers(),
    api.listMemories(),
  ]);
  return { providers, zones, skills, mcpServers, memories };
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Reconcile one incoming section against the local rows: same id wins as an
 * update, else same name is skipped in favour of the local copy, else create.
 */
function planSection<T extends { id: string }, L extends { id: string }>(
  incoming: T[],
  local: L[],
  nameOf: (row: T | L) => string,
): { rows: PlanRow<T>[]; idMap: Record<string, string> } {
  const byId = new Map(local.map((l) => [l.id, l]));
  // Tracked as plain {id, name} rather than the row type, because rows decided
  // during this loop join the table too and only these two fields are read.
  const byName = new Map(local.map((l) => [norm(nameOf(l)), { id: l.id, name: nameOf(l) }]));
  const rows: PlanRow<T>[] = [];
  const idMap: Record<string, string> = {};

  for (const item of incoming) {
    if (byId.has(item.id)) {
      rows.push({ item, disposition: "update", targetId: item.id });
      idMap[item.id] = item.id;
      continue;
    }
    const sameName = byName.get(norm(nameOf(item)));
    if (sameName) {
      rows.push({
        item,
        disposition: "skip",
        targetId: sameName.id,
        conflictWith: sameName.name,
      });
      idMap[item.id] = sameName.id;
      continue;
    }
    rows.push({ item, disposition: "create", targetId: item.id });
    idMap[item.id] = item.id;
    // A second incoming row with the same name shouldn't create a duplicate
    // either — fold it onto the one we just decided to create.
    byName.set(norm(nameOf(item)), { id: item.id, name: nameOf(item) });
  }
  return { rows, idMap };
}

/**
 * Work out what an import would do, without writing anything. Drives both the
 * confirmation UI and `applySettingsBundle`, so what the user is shown and what
 * actually happens can't drift apart.
 */
export function planSettingsImport(bundle: SettingsBundle, local: LocalSnapshot): ImportPlan {
  const providers = planSection(bundle.providers, local.providers, (r) => r.name);
  const zones = planSection(bundle.zones, local.zones, (r) => r.name);
  const skills = planSection(bundle.skills, local.skills, (r) => r.name);
  const mcpServers = planSection(bundle.mcpServers, local.mcpServers, (r) => r.name);

  // Memories have no name, so content is the identity: importing the same fact
  // twice should leave one copy.
  const localMemoryContent = new Map(
    local.memories.filter((m) => m.scope === "global").map((m) => [norm(m.content), m]),
  );
  const memoryRows: PlanRow<BundleMemory>[] = [];
  for (const m of bundle.memories) {
    const dup = localMemoryContent.get(norm(m.content));
    if (dup) {
      memoryRows.push({ item: m, disposition: "skip", targetId: dup.id, conflictWith: "an identical memory" });
    } else {
      memoryRows.push({ item: m, disposition: "create", targetId: m.id });
      localMemoryContent.set(norm(m.content), { id: m.id } as Memory);
    }
  }

  // Resolve every provider reference the zones carry. Ids that came in with the
  // bundle are already in the map; anything else is matched by the name the
  // exporter recorded, so a zone can still find its provider even when that
  // provider wasn't part of the export.
  const providerIdMap = { ...providers.idMap };
  const localProviderByName = new Map(local.providers.map((p) => [norm(p.name), p]));
  const knownProviderIds = new Set<string>([
    ...local.providers.map((p) => p.id),
    ...providers.rows.map((r) => r.targetId),
  ]);
  const unresolvedProviderZones: string[] = [];

  const resolveProvider = (id: string | null): string | null => {
    if (!id) return null;
    const mapped = providerIdMap[id];
    if (mapped && knownProviderIds.has(mapped)) return mapped;
    const name = bundle.providerNames[id];
    const byName = name ? localProviderByName.get(norm(name)) : undefined;
    if (byName) {
      providerIdMap[id] = byName.id;
      return byName.id;
    }
    return null;
  };

  for (const row of zones.rows) {
    if (row.item.providerId && resolveProvider(row.item.providerId) === null) {
      unresolvedProviderZones.push(row.item.name);
    }
  }
  for (const key of ["sttProviderId", "ttsProviderId"] as const) {
    const id = bundle.appSettings[key];
    if (typeof id === "string") resolveProvider(id);
  }

  return {
    providers: providers.rows,
    zones: zones.rows,
    skills: skills.rows,
    mcpServers: mcpServers.rows,
    memories: memoryRows,
    providerIdMap,
    zoneIdMap: zones.idMap,
    unresolvedProviderZones,
    includePreferences: Object.keys(bundle.appSettings).length > 0,
    includeTheme: Object.keys(bundle.theme).length > 0,
  };
}

/** Counts for the confirmation UI: what lands, what's left alone. */
export interface PlanSummary {
  created: BundleCounts;
  updated: BundleCounts;
  skipped: BundleCounts;
  totalSkipped: number;
}

export function summarizePlan(plan: ImportPlan): PlanSummary {
  const blank = (): BundleCounts => ({ providers: 0, zones: 0, skills: 0, mcpServers: 0, memories: 0 });
  const created = blank();
  const updated = blank();
  const skipped = blank();
  const bucket = { create: created, update: updated, skip: skipped };
  const sections: [keyof BundleCounts, PlanRow<{ id: string }>[]][] = [
    ["providers", plan.providers],
    ["zones", plan.zones],
    ["skills", plan.skills],
    ["mcpServers", plan.mcpServers],
    ["memories", plan.memories],
  ];
  for (const [key, rows] of sections) {
    for (const r of rows) bucket[r.disposition][key]++;
  }
  const totalSkipped =
    skipped.providers + skipped.zones + skipped.skills + skipped.mcpServers + skipped.memories;
  return { created, updated, skipped, totalSkipped };
}

// ─── Import ───────────────────────────────────────────────────────────────────

/** Per-section tally of what an import actually wrote, plus anything it skipped. */
export interface ImportResult extends BundleCounts {
  /** Rows left alone because a same-named local row already existed. */
  skipped: number;
  failures: string[];
  /** Zones written without a provider because none could be resolved. */
  unresolvedProviders: string[];
}

/**
 * Write a bundle into this install, following a plan from `planSettingsImport`.
 *
 * Providers go first so that zones (and the provider-keyed voice settings) land
 * on rows that already exist, and app settings go last so `baseZoneId` resolves
 * to a zone that is by then present. Every id reference is rewritten through the
 * plan's maps, so skipping a same-named provider re-points its zones at the
 * local copy rather than stranding them.
 *
 * One row failing is logged and skipped rather than aborting the rest — a
 * partial import the user can see is better than a rollback they can't.
 */
export async function applySettingsBundle(
  bundle: SettingsBundle,
  plan: ImportPlan,
  setAppSettings: (partial: Partial<AppSettings>) => Promise<void>,
  setTheme: (partial: Partial<ThemePrefs>) => Promise<void>,
): Promise<ImportResult> {
  const result: ImportResult = {
    providers: 0,
    zones: 0,
    skills: 0,
    mcpServers: 0,
    memories: 0,
    skipped: summarizePlan(plan).totalSkipped,
    failures: [],
    unresolvedProviders: [...plan.unresolvedProviderZones],
  };

  /** Providers that exist here after the provider pass — the set zones may point at. */
  const liveProviderIds = new Set<string>();

  for (const row of plan.providers) {
    if (row.disposition === "skip") {
      liveProviderIds.add(row.targetId);
      continue;
    }
    const p = row.item;
    try {
      await api.upsertProvider({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        defaultModel: p.defaultModel,
      });
      liveProviderIds.add(p.id);
      result.providers++;
    } catch (e) {
      result.failures.push(`provider "${p.name}": ${e}`);
    }
  }

  /**
   * Map an incoming provider reference onto something that exists here. A
   * provider that failed to import drops out of `liveProviderIds`, so its zones
   * are written provider-less and reported rather than pointing at nothing.
   */
  const mapProvider = (id: string | null | undefined, label: string): string | null => {
    if (!id) return null;
    const mapped = plan.providerIdMap[id] ?? id;
    if (liveProviderIds.has(mapped)) return mapped;
    if (!result.unresolvedProviders.includes(label)) result.unresolvedProviders.push(label);
    return null;
  };

  for (const row of plan.zones) {
    if (row.disposition === "skip") continue;
    const z = row.item;
    try {
      await api.upsertZone({ ...z, providerId: mapProvider(z.providerId, z.name) });
      result.zones++;
    } catch (e) {
      result.failures.push(`zone "${z.name}": ${e}`);
    }
  }

  for (const row of plan.skills) {
    if (row.disposition === "skip") continue;
    try {
      await api.upsertSkill(row.item);
      result.skills++;
    } catch (e) {
      result.failures.push(`skill "${row.item.name}": ${e}`);
    }
  }

  for (const row of plan.mcpServers) {
    if (row.disposition === "skip") continue;
    try {
      await api.upsertMcpServer(row.item);
      result.mcpServers++;
    } catch (e) {
      result.failures.push(`MCP server "${row.item.name}": ${e}`);
    }
  }

  for (const row of plan.memories) {
    if (row.disposition === "skip") continue;
    try {
      await api.upsertMemory({ id: row.item.id, scope: "global", content: row.item.content });
      result.memories++;
    } catch (e) {
      result.failures.push(`memory: ${e}`);
    }
  }

  try {
    if (plan.includeTheme) await setTheme(bundle.theme);
  } catch (e) {
    result.failures.push(`theme: ${e}`);
  }

  try {
    if (plan.includePreferences) {
      const settings: Partial<AppSettings> = { ...bundle.appSettings };
      // Rewrite the three id-valued preferences, dropping any that don't resolve
      // — a dangling base zone silently disables Quick chat.
      if (settings.baseZoneId) {
        const mapped = plan.zoneIdMap[settings.baseZoneId] ?? settings.baseZoneId;
        const live = plan.zones.some((r) => r.targetId === mapped);
        settings.baseZoneId = live ? mapped : null;
      }
      if (settings.sttProviderId) {
        settings.sttProviderId = mapProvider(settings.sttProviderId, "dictation provider");
      }
      if (settings.ttsProviderId) {
        settings.ttsProviderId = mapProvider(settings.ttsProviderId, "speech provider");
      }
      await setAppSettings(settings);
    }
  } catch (e) {
    result.failures.push(`preferences: ${e}`);
  }

  return result;
}
