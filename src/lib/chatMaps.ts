/**
 * The store keeps a dozen-plus maps keyed by chat id (`messagesByChat`,
 * `streamingByChat`, ...). A deleted chat's entries used to stay in all of them
 * for the life of the window, its whole message list included. This finds every
 * `*ByChat` map by name, so a map added later is covered without a list here.
 *
 * Takes the ids that were deleted, not the ids still alive: a chat list fetched
 * just before a new chat was created must not wipe that chat's fresh state.
 *
 * Returns only the maps that lost an entry, so an unchanged state stays
 * unchanged and nothing re-renders.
 */
export function pruneChatMaps(state: object, deleted: Set<string>): Record<string, Record<string, unknown>> {
  if (deleted.size === 0) return {};
  const changed: Record<string, Record<string, unknown>> = {};
  for (const [key, map] of Object.entries(state)) {
    if (!key.endsWith("ByChat") || !map || typeof map !== "object" || Array.isArray(map)) continue;
    const gone = Object.keys(map).filter((id) => deleted.has(id));
    if (gone.length === 0) continue;
    const next = { ...(map as Record<string, unknown>) };
    for (const id of gone) delete next[id];
    changed[key] = next;
  }
  return changed;
}
