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

/**
 * A plain count with thousands separators: 42 → "42", 12345 → "12,345".
 *
 * Unlike {@link formatTokens}, nothing is rounded away — these are countable
 * things (requests, chats) where "12k" would hide the figure being reported.
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString();
}

/**
 * A size on disk in the unit a person would use: 0 → "0 B", 2048 → "2 KB",
 * 5_400_000 → "5.4 MB". Binary units, since that is what a filesystem reports.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // Bytes and kilobytes are never worth a decimal place.
  return `${i < 2 ? Math.round(v) : trimDecimal(v)} ${units[i]}`;
}

/** One decimal place, with a trailing ".0" removed (1.0 → "1", 1.2 → "1.2"). */
function trimDecimal(v: number): string {
  return v.toFixed(1).replace(/\.0$/, "");
}
