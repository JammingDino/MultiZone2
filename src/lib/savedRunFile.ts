/**
 * A saved run as one shareable file (0.15.4), and the template checks the
 * editor shows. Import-free on purpose, so `node --test` can load it directly.
 */
import type { RunParam, SavedRun } from "./types";

export const RUN_FILE_KIND = "multizone.saved-run";

/** What a run file holds. The zone travels by name: ids don't survive another install. */
export interface RunFile {
  kind: typeof RUN_FILE_KIND;
  version: 1;
  name: string;
  description: string | null;
  template: string;
  params: RunParam[];
  zone: string | null;
}

/** What `upsert_saved_run` takes. */
export interface RunInput {
  id?: string;
  name: string;
  description: string | null;
  template: string;
  params: RunParam[];
  zoneId: string | null;
}

/** Every `{{name}}` in a template, in order, once each — the same rule as `runs::placeholders`. */
export function placeholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\{\{(.*?)\}\}/gs)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Placeholders with no parameter, and parameters no placeholder uses. */
export function templateGaps(template: string, params: RunParam[]): { missing: string[]; unused: string[] } {
  const used = placeholders(template);
  const names = params.map((p) => p.name.trim()).filter(Boolean);
  return { missing: used.filter((n) => !names.includes(n)), unused: names.filter((n) => !used.includes(n)) };
}

export function runToFile(run: SavedRun, params: RunParam[], zoneName: string | null): RunFile {
  return { kind: RUN_FILE_KIND, version: 1, name: run.name, description: run.description, template: run.template, params, zone: zoneName };
}

/**
 * Read a run file into an input for a new run. The name gets " (2)" and on if
 * taken; a zone that isn't here by that name is dropped and reported, so the
 * run still imports and follows the chat's zone.
 */
export function runFromFile(
  text: string,
  zones: { id: string; name: string }[],
  takenNames: string[],
): { input: RunInput; missingZone: string | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("that file isn't JSON");
  }
  const d = data as Partial<RunFile>;
  if (!d || d.kind !== RUN_FILE_KIND) throw new Error("that file isn't a MultiZone saved run");
  if (typeof d.name !== "string" || !d.name.trim() || typeof d.template !== "string") {
    throw new Error("the run file has no name or no prompt");
  }
  const params = (Array.isArray(d.params) ? d.params : [])
    .filter((p): p is RunParam => !!p && typeof p.name === "string" && !!p.name.trim())
    .map((p) => ({
      name: p.name.trim(),
      ...(typeof p.label === "string" && p.label ? { label: p.label } : {}),
      ...(typeof p.description === "string" && p.description ? { description: p.description } : {}),
      ...(typeof p.default === "string" ? { default: p.default } : {}),
      ...(p.required ? { required: true } : {}),
    }));
  const zone = typeof d.zone === "string" && d.zone ? d.zone : null;
  const zoneId = zone ? zones.find((z) => z.name === zone)?.id ?? null : null;
  let name = d.name.trim();
  for (let i = 2; takenNames.includes(name); i++) name = `${d.name.trim()} (${i})`;
  return {
    input: { name, description: typeof d.description === "string" ? d.description : null, template: d.template, params, zoneId },
    missingZone: zone && !zoneId ? zone : null,
  };
}

/** A file name for a run: its name, slugged. */
export function runFileName(name: string): string {
  return `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "saved-run"}.run.json`;
}
