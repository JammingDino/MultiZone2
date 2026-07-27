/**
 * Settings export / import (0.9.9).
 *
 * One JSON file that carries a MultiZone setup — providers, zones, skills, MCP
 * servers, preferences and theme — so a second machine can be brought up to
 * match without re-entering any of it by hand.
 *
 * Two rules shape what goes in:
 *
 * - **Ids are preserved.** Every row is re-imported under its original id, so
 *   cross-references survive the trip: a zone still points at its provider, the
 *   base zone still resolves, dictation and speech still name a real provider.
 *   Re-importing the same bundle updates in place rather than duplicating.
 * - **Machine-local values are left out.** Filesystem paths and the local API
 *   token mean nothing on another machine (and the paths may not exist), so the
 *   importing install keeps its own. Everything excluded is listed in
 *   `LOCAL_ONLY_SETTINGS` with the reason.
 *
 * Chats, messages, projects, tags and memories are *not* settings and are not
 * included — the markdown mirror in Settings → Data is the tool for content.
 */
import type { AppSettings, McpServerView, Provider, Skill, Zone } from "./types";
import type { ThemePrefs } from "@/store/app";
import * as api from "./tauri";

export const BUNDLE_KIND = "multizone.settings";
export const BUNDLE_VERSION = 1;

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
] as const satisfies readonly (keyof AppSettings)[];

/** A provider as exported. `apiKey` is null when keys were excluded. */
export type BundleProvider = Pick<Provider, "id" | "name" | "baseUrl" | "apiKey" | "defaultModel">;
export type BundleZone = Omit<Zone, "createdAt" | "updatedAt">;
export type BundleSkill = Pick<Skill, "id" | "name" | "description" | "content" | "enabled">;
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
}

/** What a bundle contains, for the confirmation UI on both ends. */
export interface BundleCounts {
  providers: number;
  zones: number;
  skills: number;
  mcpServers: number;
}

export function bundleCounts(b: SettingsBundle): BundleCounts {
  return {
    providers: b.providers.length,
    zones: b.zones.length,
    skills: b.skills.length,
    mcpServers: b.mcpServers.length,
  };
}

/** Strip the machine-local keys out of the settings blob. */
function portableSettings(settings: AppSettings): Partial<AppSettings> {
  const out: Record<string, unknown> = { ...settings };
  for (const k of LOCAL_ONLY_SETTINGS) delete out[k];
  return out as Partial<AppSettings>;
}

/**
 * Collect the current setup into a bundle. `includeSecrets` controls whether
 * provider API keys travel with it — off produces a file that is safe to share,
 * but the other machine has to re-enter every key.
 */
export async function buildSettingsBundle(
  settings: AppSettings,
  theme: ThemePrefs,
  includeSecrets: boolean,
  appVersion?: string,
): Promise<SettingsBundle> {
  const [providers, zones, skills, mcpServers] = await Promise.all([
    api.listProviders(),
    api.listZones(),
    api.listSkills(),
    api.listMcpServers(),
  ]);

  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion,
    includesSecrets: includeSecrets,
    appSettings: portableSettings(settings),
    theme,
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: includeSecrets ? p.apiKey : null,
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
  };
}

/** Per-section tally of what an import actually wrote, plus anything it skipped. */
export interface ImportResult extends BundleCounts {
  failures: string[];
}

/**
 * Write a bundle into this install.
 *
 * Providers go first so that zones (and the provider-keyed voice settings) land
 * on rows that already exist, and app settings go last so `baseZoneId` resolves
 * to a zone that is by then present. Machine-local keys are never in the bundle,
 * so the importing install keeps its own paths and API token untouched.
 *
 * One row failing is logged and skipped rather than aborting the rest — a
 * partial import the user can see is better than a rollback they can't.
 */
export async function applySettingsBundle(
  bundle: SettingsBundle,
  setAppSettings: (partial: Partial<AppSettings>) => Promise<void>,
  setTheme: (partial: Partial<ThemePrefs>) => Promise<void>,
): Promise<ImportResult> {
  const result: ImportResult = { providers: 0, zones: 0, skills: 0, mcpServers: 0, failures: [] };

  for (const p of bundle.providers) {
    try {
      await api.upsertProvider({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        defaultModel: p.defaultModel,
      });
      result.providers++;
    } catch (e) {
      result.failures.push(`provider "${p.name}": ${e}`);
    }
  }

  for (const z of bundle.zones) {
    try {
      await api.upsertZone(z);
      result.zones++;
    } catch (e) {
      result.failures.push(`zone "${z.name}": ${e}`);
    }
  }

  for (const s of bundle.skills) {
    try {
      await api.upsertSkill(s);
      result.skills++;
    } catch (e) {
      result.failures.push(`skill "${s.name}": ${e}`);
    }
  }

  for (const m of bundle.mcpServers) {
    try {
      await api.upsertMcpServer(m);
      result.mcpServers++;
    } catch (e) {
      result.failures.push(`MCP server "${m.name}": ${e}`);
    }
  }

  try {
    if (Object.keys(bundle.theme).length > 0) await setTheme(bundle.theme);
  } catch (e) {
    result.failures.push(`theme: ${e}`);
  }
  try {
    if (Object.keys(bundle.appSettings).length > 0) await setAppSettings(bundle.appSettings);
  } catch (e) {
    result.failures.push(`preferences: ${e}`);
  }

  return result;
}
