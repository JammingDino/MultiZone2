/**
 * Launch marks and a frame sampler, so performance is a number rather than an
 * impression.
 *
 * The 1.0.0 performance item could not be ticked because nothing had ever been
 * measured — "optimise startup time" against no baseline is a wish. This is the
 * cheapest thing that turns it into a measurement: three marks on the way up,
 * and a sampler that reports frame times during a scroll.
 *
 * Deliberately not a dependency. A Playwright harness would give better numbers
 * and cost a browser download plus a second test runner; these numbers come
 * from the real app on the real machine, which is the environment the claim is
 * about anyway.
 *
 * Everything here is inert unless switched on, so a shipped build measures
 * nothing and costs nothing:
 *
 *   localStorage.mzPerf = "1"   // then relaunch — marks print at boot
 *   __mzPerf.scroll()           // sample a scroll of the open chat
 *   __mzPerf.marks()            // reprint the launch marks
 */

export type Mark = { name: string; at: number };

const marks: Mark[] = [];
let printed = false;

/** Whether measurement is switched on for this launch. */
export function perfEnabled(): boolean {
  try {
    return localStorage.getItem("mzPerf") === "1";
  } catch {
    return false;
  }
}

/**
 * Record a point on the way up. `performance.now()` is relative to the document
 * being created, which is close enough to process start for the deltas that
 * matter here — and the absolute origin is not the interesting number, the gaps
 * between marks are.
 */
export function mark(name: string): void {
  if (!perfEnabled()) return;
  marks.push({ name, at: performance.now() });
}

function fmt(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

/** Print the marks as a table of deltas, once the app says it is interactive. */
export function printMarks(): void {
  if (!perfEnabled() || marks.length === 0) return;
  const rows = marks.map((m, i) => ({
    mark: m.name,
    at: fmt(m.at),
    since_previous: i === 0 ? "—" : fmt(m.at - marks[i - 1].at),
  }));
  // eslint-disable-next-line no-console
  console.table(rows);
  // eslint-disable-next-line no-console
  console.log(`[perf] document → interactive: ${fmt(marks[marks.length - 1].at)}`);
}

/** Called once the first useful frame is up; prints and stops collecting. */
export function markInteractive(): void {
  if (printed) return;
  printed = true;
  mark("interactive");
  // One frame later, so the mark lands after the paint rather than before it.
  requestAnimationFrame(() => requestAnimationFrame(printMarks));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/**
 * Scroll the message thread from bottom to top and report frame times.
 *
 * The number that matters is the 95th percentile: a median of 16ms with a p95
 * of 120ms is a list that stutters, and an average hides it completely. The
 * suggested threshold in TEST_STRATEGY.md is p95 under 20ms while scrolling a
 * 500-message chat.
 */
export async function sampleScroll(opts: { steps?: number; stepPx?: number } = {}) {
  const steps = opts.steps ?? 120;
  const stepPx = opts.stepPx ?? 240;

  // Whichever element actually scrolls — found rather than hard-coded, so this
  // keeps working when the thread's markup changes.
  const el = [...document.querySelectorAll<HTMLElement>("*")]
    .filter((e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 200)
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!el) {
    // eslint-disable-next-line no-console
    console.warn("[perf] no scrollable message thread found — open a chat with enough messages");
    return null;
  }

  const frames: number[] = [];
  let last = performance.now();
  let running = true;
  const tick = () => {
    if (!running) return;
    const now = performance.now();
    frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  el.scrollTop = el.scrollHeight;
  await new Promise((r) => setTimeout(r, 100));
  frames.length = 0; // discard the settling frames before the scroll starts

  for (let i = 0; i < steps; i++) {
    el.scrollTop = Math.max(0, el.scrollTop - stepPx);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    if (el.scrollTop === 0) break;
  }
  running = false;

  const sorted = [...frames].sort((a, b) => a - b);
  const result = {
    frames: frames.length,
    median: Number(percentile(sorted, 50).toFixed(1)),
    p95: Number(percentile(sorted, 95).toFixed(1)),
    worst: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
    scrollHeight: el.scrollHeight,
  };
  // eslint-disable-next-line no-console
  console.log(
    `[perf] scroll — median ${result.median}ms, p95 ${result.p95}ms, worst ${result.worst}ms ` +
      `over ${result.frames} frames (${result.scrollHeight}px of thread)`,
  );
  return result;
}

/** Attach the console handle. Called once from App. */
export function installPerfHandle(): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__mzPerf = {
    enable() {
      localStorage.setItem("mzPerf", "1");
      // eslint-disable-next-line no-console
      console.log("[perf] on — relaunch to collect launch marks");
    },
    disable() {
      localStorage.removeItem("mzPerf");
    },
    marks: printMarks,
    scroll: sampleScroll,
  };
}
