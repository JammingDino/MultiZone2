/**
 * One timer drives every live view in the app that repaints on a stream.
 *
 * Each streaming text block used to own its own `setInterval`, so two zones
 * answering at once produced two independent, staggered flushes: twice the
 * render passes, none of them batched, and no way for either to know the other
 * existed. A single shared tick means every subscriber updates inside the same
 * task — which React coalesces into one render pass — and lets the interval
 * widen as more streams pile on, so the cost of an extra participant is a
 * slightly coarser repaint rather than a proportional drop in frame rate.
 */

/** Repaint interval with a single stream running. */
const BASE_MS = 60;
/** Added per additional concurrent stream. */
const PER_STREAM_MS = 40;
/** Coarsest we will ever get, however many zones are answering. */
const MAX_MS = 200;

type Tick = () => void;

const subscribers = new Set<Tick>();
let timer: number | undefined;
let currentMs = 0;

function intervalFor(count: number): number {
  return Math.min(BASE_MS + (count - 1) * PER_STREAM_MS, MAX_MS);
}

function reschedule() {
  const wanted = subscribers.size === 0 ? 0 : intervalFor(subscribers.size);
  if (wanted === currentMs) return;
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
  currentMs = wanted;
  if (wanted === 0) return;
  timer = window.setInterval(() => {
    // Copied because a subscriber may unsubscribe from inside its own tick.
    for (const fn of [...subscribers]) fn();
  }, wanted);
}

/** Subscribe to the shared repaint tick. Returns the unsubscribe function. */
export function subscribeStreamTick(fn: Tick): () => void {
  subscribers.add(fn);
  reschedule();
  return () => {
    subscribers.delete(fn);
    reschedule();
  };
}
