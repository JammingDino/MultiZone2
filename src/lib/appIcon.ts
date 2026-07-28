/**
 * Repaint the window icon in the user's accent colour (1.0).
 *
 * The icon compiled into the executable is fixed — it's a resource in the
 * binary, and the Start menu / Dock entry can't follow a runtime setting. What
 * *can* follow it is the icon the running window shows: title bar, taskbar,
 * alt-tab. So the mark is redrawn on a canvas whenever the accent changes and
 * handed to `setIcon`, and someone who themes the app lilac stops looking at a
 * blue icon above it.
 *
 * The geometry mirrors `scripts/make-icon.py`, which renders the same mark to
 * the bundled PNG/ICO/ICNS at build time — the two are meant to be the same
 * drawing, so a change to either belongs in both.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Image } from "@tauri-apps/api/image";

/** Fractions of the icon's edge — see ICON_GEOMETRY in scripts/make-icon.py. */
const TILE_RADIUS = 0.2148;
const STROKE = 0.1367;
const M_LEFT = 0.2461;
const M_RIGHT = 1 - M_LEFT;
const M_TOP = 0.293;
const M_BOTTOM = 0.7266;
const M_VALLEY = 0.6055;

const BG_TOP = "#181D26";
const BG_BOTTOM = "#0D1015";

/**
 * 64px is what Windows actually samples for the taskbar and alt-tab; larger
 * costs more to push over IPC on every theme tweak for no visible gain.
 */
const ICON_SIZE = 64;

/** Mix `hex` toward white by `amount` (0..1). */
function lighten(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.round(v + (255 - v) * amount),
  );
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
}

function drawIcon(ctx: CanvasRenderingContext2D, size: number, accent: string) {
  const s = (frac: number) => frac * size;
  ctx.clearRect(0, 0, size, size);

  // Tile.
  const bg = ctx.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, BG_TOP);
  bg.addColorStop(1, BG_BOTTOM);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, s(TILE_RADIUS));
  ctx.clip();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  // Two halves of the M, drawn as separate translucent strokes so the shared
  // middle vertex builds up into a brighter seam — the overlap is the point.
  ctx.lineWidth = s(STROKE);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const left = s(M_LEFT);
  const right = s(M_RIGHT);
  const top = s(M_TOP);
  const bottom = s(M_BOTTOM);
  const valley = s(M_VALLEY);
  const mid = size / 2;

  ctx.globalAlpha = 235 / 255;
  ctx.strokeStyle = accent;
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(left, top);
  ctx.lineTo(mid, valley);
  ctx.stroke();

  ctx.globalAlpha = 200 / 255;
  ctx.strokeStyle = lighten(accent, 0.46);
  ctx.beginPath();
  ctx.moveTo(mid, valley);
  ctx.lineTo(right, top);
  ctx.lineTo(right, bottom);
  ctx.stroke();

  ctx.restore();
}

let lastAccent: string | null = null;

/**
 * Redraw and apply the window icon for `accent`. Cheap to call on every theme
 * change: repeats for an accent already applied are skipped, and everything
 * fails soft — outside the Tauri shell, or without the `set-icon` permission,
 * the app simply keeps the icon baked into the binary.
 */
export async function applyAccentToWindowIcon(accent: string): Promise<void> {
  if (!accent || accent === lastAccent) return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    drawIcon(ctx, ICON_SIZE, accent);

    const { data } = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
    const image = await Image.new(new Uint8Array(data), ICON_SIZE, ICON_SIZE);
    await getCurrentWindow().setIcon(image);
    lastAccent = accent;
  } catch (e) {
    // Not fatal — the bundled icon stays.
    console.debug("could not repaint the window icon", e);
  }
}
