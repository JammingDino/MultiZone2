import { useEffect, useReducer, useRef } from "react";
import { setStreamTickBase, subscribeStreamTick } from "./streamTick";
import { step } from "./streamReveal";
import { useApp } from "@/store/app";

/**
 * The part of a streaming text to show now. Repaints on the app-wide stream
 * tick rather than on every token — the tick is shared (see streamTick.ts) so
 * several zones answering at once repaint together in one render pass.
 *
 * With smoothing on (0.18.3) it also paces the text: characters are revealed
 * at a rate that follows the backlog (`step` in streamReveal.ts), so bursts
 * and pauses in the model's output become an even flow, and the reveal keeps
 * going after the stream ends until it has caught up.
 *
 * When there is nothing left to reveal it returns `source` itself rather than
 * a copy. A copy can go stale: consuming components are reused across chat
 * switches (turns and text blocks are keyed by index), which once left the
 * previous chat's answer under the new chat's prompt. For the same reason a
 * `source` that does not continue what is on screen starts fully shown.
 */
export function useThrottledStreaming(source: string, streaming: boolean): string {
  const smoothMs = useApp((s) => s.appSettings.streamSmoothingMs ?? 0);
  const unit = useApp((s) => s.appSettings.streamUnit ?? "char");
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const r = useRef({ pos: source.length, shown: source, at: 0 });
  const latest = useRef(source);
  latest.current = source;
  if (!source.startsWith(r.current.shown)) r.current = { pos: source.length, shown: source, at: 0 };

  const live = streaming || r.current.shown.length < source.length;

  useEffect(() => {
    if (!live) return;
    setStreamTickBase(smoothMs > 0 ? 33 : 60);
    r.current.at = performance.now();
    return subscribeStreamTick(() => {
      const s = r.current;
      const src = latest.current;
      const now = performance.now();
      const { pos, end } = step(src, s.pos, s.shown.length, now - s.at, smoothMs, unit);
      s.at = now;
      s.pos = pos;
      if (end !== s.shown.length || !src.startsWith(s.shown)) {
        s.shown = src.slice(0, end);
        repaint();
      }
    });
  }, [live, smoothMs, unit]);

  return live ? r.current.shown : source;
}
