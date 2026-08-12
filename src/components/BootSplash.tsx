import { useEffect, useState } from "react";

/** Total time the splash is on screen, fade included. Kept under a second: this
 *  is cover for a slow first frame, not a title sequence. */
const HOLD_MS = 620;
const FADE_MS = 260;

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
 * icon, in the user's accent — on the background colour the window is already
 * using, which means the splash leaving reveals a finished window rather than
 * cutting to a different one. It dismisses itself, and any click, tap or keypress
 * dismisses it immediately: nobody should ever be made to watch this twice.
 */
export function BootSplash() {
  const [state, setState] = useState<"in" | "out" | "gone">(() => (shown ? "gone" : "in"));

  useEffect(() => {
    if (shown) return;
    shown = true;
    const toFade = window.setTimeout(() => setState("out"), HOLD_MS);
    const toGone = window.setTimeout(() => setState("gone"), HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(toFade);
      window.clearTimeout(toGone);
    };
  }, []);

  // Skipping is the same for a click, a tap or a key: whatever the user did, they
  // are here and the cover is in their way.
  useEffect(() => {
    if (state === "gone") return;
    const skip = () => setState("gone");
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
      className={`fixed inset-0 z-[100] flex items-center justify-center ${
        state === "out" ? "mz-splash-out" : ""
      }`}
      style={{ background: "var(--color-bg)" }}
      aria-hidden
    >
      <div className="flex flex-col items-center gap-4">
        <svg
          viewBox="0 0 100 100"
          className="mz-splash-mark h-20 w-20"
          /* The dash length the keyframes count down from. Measured off the path
             below (four legs of ~48 and ~40 units) and rounded up, so a small
             error only ever means the stroke starts a hair further along. */
          style={{ ["--mz-splash-len" as string]: "190" }}
        >
          <path
            d="M22 78 L22 30 L50 58 L78 30 L78 78"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="11"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
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
