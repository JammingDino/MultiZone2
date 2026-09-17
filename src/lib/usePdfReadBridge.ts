import { useEffect } from "react";
import { readPdfPages } from "@/lib/pdf";
import * as api from "@/lib/tauri";

/**
 * Serves the backend's PDF read requests (1.0).
 *
 * `read` returns a PDF as page images, and the only PDF rasterizer in the
 * app is PDF.js — which lives here, in the window. So the backend emits a
 * request and this listener answers it: decode the bytes it sent, render or
 * extract the pages it asked for, hand back the result. See `pdf_bridge.rs` for
 * the other half, including what happens when nobody answers.
 *
 * Mounted once, app-wide: a tool call can come from any chat, and from the HTTP
 * API with no chat open at all.
 */
export function usePdfReadBridge(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    api
      .onPdfReadRequest(async (req) => {
        try {
          const result = await readPdfPages(
            base64ToBytes(req.data),
            req.spec,
            req.mode,
            req.maxPages,
          );
          await api.resolvePdfRead(req.id, result, null);
        } catch (e) {
          console.error("PDF read failed", e);
          await api
            .resolvePdfRead(req.id, null, e instanceof Error ? e.message : String(e))
            .catch(() => {});
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.warn("could not listen for PDF read requests", e));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
