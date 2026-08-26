/**
 * Is this a phone-shaped window? (0.17.3)
 *
 * Kept separate from `isRemoteShell()` on purpose, because they are different
 * questions with different answers. A remote client can be a second laptop at
 * full width, and a desktop window dragged narrow wants the phone's layout
 * without being one. Width decides layout; the pointer type decides target
 * sizes; neither decides the other.
 *
 * 767px is Tailwind's `md` boundary less one, so this and the `narrow:` variant
 * in styles.css flip together. They are two expressions of one line and must
 * not drift.
 */

import { useEffect, useState } from "react";

export const NARROW_QUERY = "(max-width: 767px)";

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
