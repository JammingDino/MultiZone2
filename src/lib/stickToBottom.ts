/**
 * Whether the chat thread follows new content to the bottom ("pinned"), and
 * whether to offer "Jump to latest".
 *
 * Pinned is the reader's intent, not a reading of the geometry. The old thread
 * re-derived it from every scroll event — `pinned = distance < 60px` — and
 * that is wrong both ways: content growth, a pane resize or a hidden pane all
 * fire scroll events that read as "not at the bottom" (a stray Jump button),
 * while the first frames of a smooth wheel scroll upward are still inside 60px
 * and read as "at the bottom" (re-pinned, and the next token yanks the reader
 * back down). So here only an explicit upward gesture unpins, and a scroll
 * event can only ever re-pin.
 */

export const NEAR_BOTTOM_PX = 60;

export interface ScrollGeom {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export const distanceFromBottom = (g: ScrollGeom) => g.scrollHeight - g.scrollTop - g.clientHeight;

/** A pane zoomed away or collapsed measures 0 tall; nothing it reports means anything. */
const hidden = (g: ScrollGeom) => g.clientHeight <= 0;

/**
 * The reader asked to go up: wheel up, a finger dragging down, ↑/PgUp/Home, a
 * grab of the scrollbar. Nothing above to go to (a short chat, or already at
 * the top) leaves it pinned, so an idle flick doesn't stop the next reply from
 * being followed.
 */
export function afterUpIntent(pinned: boolean, g: ScrollGeom): boolean {
  if (hidden(g) || g.scrollTop <= 0) return pinned;
  return false;
}

/**
 * A scroll event — the reader's, ours, or the layout's; it can't say which.
 * Re-pins when the view has come down to near the bottom. It has to be moving
 * down: a smooth scroll *up* spends its first frames inside the threshold too.
 */
export function afterScroll(pinned: boolean, prev: ScrollGeom, g: ScrollGeom): boolean {
  if (pinned || hidden(g)) return pinned;
  return g.scrollTop > prev.scrollTop && distanceFromBottom(g) <= NEAR_BOTTOM_PX;
}

/** Letting go of the scrollbar near the bottom means "follow" again. */
export function afterRelease(pinned: boolean, g: ScrollGeom): boolean {
  if (pinned || hidden(g)) return pinned;
  return distanceFromBottom(g) <= NEAR_BOTTOM_PX;
}

export function showJump(pinned: boolean, g: ScrollGeom): boolean {
  return !pinned && !hidden(g) && distanceFromBottom(g) > NEAR_BOTTOM_PX;
}
