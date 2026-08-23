import { useEffect, useRef, useState } from "react";

/**
 * The value once it has stopped changing — the current value on mount, then
 * each later value only after `delayMs` of quiet (0.16.1).
 *
 * For renderers whose input arrives a token at a time. Block-level parsing
 * (0.9.16) stopped a long answer re-parsing itself on every tick, but it did
 * not change what happens *inside* the trailing block: an unclosed fence is
 * still a code block to CommonMark, so a diagram being streamed is handed to
 * its renderer at every intermediate length. Measured on a six-line Mermaid
 * diagram in a 321-character answer: 29 `mermaid.render` calls, 28 of them on
 * source that cannot parse yet.
 *
 * Returning the value immediately on mount is the point of the `first` ref —
 * a finished diagram, or one remounting after a theme change, must not wait
 * out a delay to appear.
 */
export function useSettledValue<T>(value: T, delayMs = 220): T {
  const [settled, setSettled] = useState(value);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return settled;
}
