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
