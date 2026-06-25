/** Formatting helpers shared across the UI. */

/**
 * Format a token count compactly with unit suffixes:
 *   999 → "999", 1000 → "1k", 1200 → "1.2k", 1_000_000 → "1m".
 * Keeps one decimal place when it carries information, drops a trailing ".0".
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return trimDecimal(n / 1000) + "k";
  if (abs < 1_000_000_000) return trimDecimal(n / 1_000_000) + "m";
  return trimDecimal(n / 1_000_000_000) + "b";
}

/** One decimal place, with a trailing ".0" removed (1.0 → "1", 1.2 → "1.2"). */
function trimDecimal(v: number): string {
  return v.toFixed(1).replace(/\.0$/, "");
}
