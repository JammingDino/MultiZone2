/**
 * Reading an approval policy back off disk (1.0.1).
 *
 * The stored shape grows with the tool set — `editAllow`/`editDeny` arrived at
 * 0.14.5, and the next category group will do the same. Anything saved before a
 * field existed comes back without it, so every read has to fill the gaps
 * against the current shape rather than trust what it parsed. The backend
 * already does this with `#[serde(default)]` on `ApprovalConfig`; this is the
 * same guarantee for the frontend, which otherwise hands `undefined` to a list
 * editor and takes the settings screen down with it.
 */
import type { ApprovalPolicy } from "./types";

/** Overrides nothing: what a zone with no policy of its own resolves to. */
export const EMPTY_APPROVALS: ApprovalPolicy = {
  categories: {},
  shellAllow: [],
  shellDeny: [],
  editAllow: [],
  editDeny: [],
};

/** Every field present, whichever version wrote the one we were given. */
export function normalizeApprovals(v: Partial<ApprovalPolicy> | null | undefined): ApprovalPolicy {
  return {
    categories: v?.categories ?? {},
    shellAllow: v?.shellAllow ?? [],
    shellDeny: v?.shellDeny ?? [],
    editAllow: v?.editAllow ?? [],
    editDeny: v?.editDeny ?? [],
  };
}

/** A zone's `approvals` column, which is the policy as a JSON string or null. */
export function parseApprovals(raw: string | null | undefined): ApprovalPolicy {
  if (!raw?.trim()) return EMPTY_APPROVALS;
  try {
    return normalizeApprovals(JSON.parse(raw) as Partial<ApprovalPolicy>);
  } catch {
    return EMPTY_APPROVALS;
  }
}

/** `null` when the zone overrides nothing, so "inherit everything" is stored as
 * the absence of a policy rather than an empty one that looks like a decision. */
export function serializeApprovals(p: ApprovalPolicy): string | null {
  const empty =
    Object.keys(p.categories).length === 0 &&
    p.shellAllow.length === 0 &&
    p.shellDeny.length === 0 &&
    p.editAllow.length === 0 &&
    p.editDeny.length === 0;
  return empty ? null : JSON.stringify(p);
}
