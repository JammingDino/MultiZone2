/**
 * Is this a phone-shaped window? (0.17.3)
 *
 * Kept separate from `isRemoteShell()` on purpose, because they are different
 * questions with different answers. A remote client can be a second laptop at
 * full width, and a desktop window dragged narrow wants the phone's layout
 * without being one. Width decides layout; the pointer type decides target
 * sizes; neither decides the other — except a touchscreen too short for panes,
 * a phone on its side (0.21, see lib/mobileLayout.ts).
 *
 * The `narrow:` variant in styles.css is the same line as CSS and must flip
 * together with this.
 */

import { useEffect, useState } from "react";
import { NARROW_QUERY, phoneNow } from "./mobileLayout";

export { NARROW_QUERY };

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(phoneNow);

  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(phoneNow());
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
