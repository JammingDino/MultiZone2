// Mirror of the backend `is_media_capable` heuristic (src-tauri/src/ocr.rs).
// Used when a file is staged, to decide whether a recording or a clip goes to
// the model as itself or — for audio — as a transcript. Keep the two in sync.

export type MediaKind = "audio" | "video";

const MARKERS: Record<MediaKind, string[]> = {
  audio: [
    "omni", "audio", "voxtral", "gemini", "phi-4-multimodal", "ultravox", "minicpm-o", "gemma-3n",
    "gpt-realtime", "kimi-audio", "step-audio",
  ],
  video: [
    "omni", "gemini", "video", "minicpm-v", "minicpm-o", "internvl", "gemma-3n", "qwen2-vl",
    "qwen2.5-vl", "qwen3-vl", "qwen2.5vl", "qwen3vl", "glm-4.5v", "glm-4.1v",
  ],
};

/** Name heuristic. Unrecognised models are treated as unable. */
export function isMediaCapable(model: string | null | undefined, kind: MediaKind): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return MARKERS[kind].some((k) => m.includes(k));
}

/** Override-aware — what the backend will actually do (`audioOverrides` / `videoOverrides`). */
export function resolveMediaCapable(
  model: string | null | undefined,
  kind: MediaKind,
  overrides: Record<string, "on" | "off"> | undefined,
): boolean {
  if (!model) return false;
  const ov = overrides?.[model];
  if (ov === "on") return true;
  if (ov === "off") return false;
  return isMediaCapable(model, kind);
}
