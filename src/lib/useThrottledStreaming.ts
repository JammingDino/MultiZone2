import { useEffect, useRef, useState } from "react";
import { subscribeStreamTick } from "./streamTick";

/**
 * Throttles a streaming text source so the view reading it repaints on the
 * app-wide stream tick rather than on every token. The tick is shared (see
 * streamTick.ts) so several zones answering at once repaint together in one
 * render pass instead of each on its own timer, and the latest value is
 * flushed immediately the moment `streaming` flips to false.
 *
 * The throttled `visible` state is only ever consulted *while streaming*. When
 * idle we return `source` directly rather than a state copy of it, because a
 * copy can go stale: consuming components are reused across chat switches
 * (turns and text blocks are keyed by index), and an effect keyed on
 * `[streaming]` never re-runs when both the old and new chat are idle. That
 * left `visible` holding the previous chat's answer — the "chat history
 * mix-ups" bug, where the prompt updated (user messages are keyed by id) but
 * the answer under it did not.
 */
export function useThrottledStreaming(source: string, streaming: boolean): string {
  const [visible, setVisible] = useState(source);
  const latestRef = useRef(source);
  latestRef.current = source;

  useEffect(() => {
    if (!streaming) return;
    setVisible(latestRef.current);
    return subscribeStreamTick(() => setVisible(latestRef.current));
  }, [streaming]);

  // Idle: `source` is authoritative and always current.
  return streaming ? visible : source;
}
