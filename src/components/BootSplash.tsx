import { useEffect, useState } from "react";

/** Total time the splash is on screen, fade included. Kept under a second: this
 *  is cover for a slow first frame, not a title sequence. */
const HOLD_MS = 620;
const FADE_MS = 260;

/** The "M" from the window icon. */
const MARK = "M22 78 L22 30 L50 58 L78 30 L78 78";

/**
 * Once per launch, not once per mount. `<App>` mounts twice under StrictMode in
 * development, and a splash that replayed on the second mount would be a
 * flicker — the exact thing it exists to remove.
 */
let shown = false;

/**
 * The launch cover (0.12.3).
 *
 * The window is painted by the OS well before the app knows what it should look
 * like: the palette and font size are restored from a cache before the first
 * paint (see the pre-paint script in `index.html`), but the chat list, the zone
 * list and the background canvas all arrive over IPC afterwards, so the first
 * moment of every launch was visibly the app assembling itself.
 *
 * So it is covered by the app's own mark being drawn — the "M" from the window
 * icon, in the user's accent, with a glow, a sheen and (with glass on) a glass
 * tile — over the window's own backdrop. The splash paints no background: while
 * it is up the rest of the app is hidden (styles.css, "Boot splash"), so what
 * shows behind the mark *is* the backdrop the app sits on, gradient, drift and
 * see-through window included, and leaving can only reveal that same background.
 * It dismisses itself, and any click, tap or keypress dismisses it immediately:
 * nobody should ever be made to watch this twice.
 */
export function BootSplash() {
  const [state, setState] = useState<"in" | "out" | "gone">(() => (shown ? "gone" : "in"));

  // `shown` is set when the splash leaves, not when the timers start: StrictMode
  // runs this effect, its cleanup, then the effect again, and a guard set on the
  // first run skipped the second — leaving no timer, and the splash up until a
  // click.
  useEffect(() => {
    if (shown) return;
    const toFade = window.setTimeout(() => setState("out"), HOLD_MS);
    const toGone = window.setTimeout(() => { shown = true; setState("gone"); }, HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(toFade);
      window.clearTimeout(toGone);
    };
  }, []);

  // Skipping is the same for a click, a tap or a key: whatever the user did, they
  // are here and the cover is in their way.
  useEffect(() => {
    if (state === "gone") return;
    const skip = () => { shown = true; setState("gone"); };
    window.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);
    return () => {
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
    };
  }, [state]);

  if (state === "gone") return null;

  return (
    <div
      className="mz-splash fixed inset-0 z-[100] flex items-center justify-center"
      data-state={state}
      aria-hidden
    >
      <div className="mz-splash-halo" />
      <div className="relative flex flex-col items-center gap-4">
        <div className="mz-splash-tile">
          {/* pathLength=100 so the stylesheet's dash lengths are percentages of
              the stroke rather than a length measured off this path. */}
          <svg viewBox="0 0 100 100" className="mz-splash-mark h-20 w-20">
            <path d={MARK} pathLength={100} strokeWidth="11" />
            <path d={MARK} pathLength={100} strokeWidth="5" className="mz-splash-sheen" />
          </svg>
        </div>
        <div
          className="mz-fade-in mz-delay-120 text-xs font-semibold tracking-[0.2em]"
          style={{ color: "var(--color-text-muted)" }}
        >
          MULTIZONE
        </div>
      </div>
    </div>
  );
}
