/**
 * Reading a colour someone typed (0.11.3).
 *
 * Every colour in the app is stored as `#rrggbb` — the theme writes them
 * straight into inline styles and the API validates them as hex — but a hex
 * colour arrives in more than one shape: with or without the `#`, in either
 * case, and often as the three-digit shorthand a CSS file was written in. All
 * of those are the same colour, and a field that accepts only one of them is a
 * field that rejects a value the user correctly pasted.
 */

/**
 * The canonical `#rrggbb` form of a typed colour, or `null` if it isn't one.
 *
 * Deliberately hex-only: named CSS colours would parse here and then have to
 * survive a round trip through a native colour swatch, which cannot show one,
 * and through the theme API, which does not accept one.
 */
export function normalizeHex(input: string): string | null {
  const body = input.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;
  if (body.length === 3) {
    return `#${[...body].map((c) => c + c).join("").toLowerCase()}`;
  }
  if (body.length === 6) return `#${body.toLowerCase()}`;
  return null;
}

/** True when the text is a colour this app can store. */
export function isHex(input: string): boolean {
  return normalizeHex(input) !== null;
}

/**
 * The same colour moved towards white (positive `amount`) or black (negative),
 * as a fraction of the distance to it. Used for the accent's hover shade.
 *
 * The theme shipped a hand-picked `--color-accent-hover` per mode, and then
 * every custom accent overwrote it with the accent itself — so the moment a
 * user picked their own colour, every filled button in the app stopped
 * reacting to the pointer. Deriving it means any accent gets a hover.
 */
export function shade(hex: string, amount: number): string {
  const c = normalizeHex(hex);
  if (!c) return hex;
  const towards = amount >= 0 ? 255 : 0;
  const f = Math.min(1, Math.abs(amount));
  const mix = (channel: number) => Math.round(channel + (towards - channel) * f);
  const parts = [1, 3, 5].map((i) => mix(parseInt(c.slice(i, i + 2), 16)));
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
