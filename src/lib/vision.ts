// Mirror of the backend `is_vision_capable` heuristic (src-tauri/src/ocr.rs).
// Used pre-send so the input bar can warn that a vision-incapable model will get
// OCR-extracted text instead of the image itself. Keep these two lists in sync.

const VISION_MARKERS = [
  // generic markers
  "vision", "-vl", "vl-", "-vl-", "multimodal",
  // open multimodal families
  "llava", "bakllava", "moondream", "minicpm-v", "internvl", "pixtral",
  "cogvlm", "smolvlm", "idefics", "fuyu", "kosmos", "paligemma", "molmo",
  "aria", "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl",
  // OpenAI multimodal
  "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "gpt-5", "o3", "o4-mini",
  // Anthropic (all Claude 3+ are multimodal)
  "claude-3", "claude-4", "claude-opus", "claude-sonnet", "claude-haiku",
  // Google
  "gemini", "gemma-3", "gemma3", "paligemma",
  // others
  "grok-vision", "grok-2-vision", "step-1v", "yi-vision", "phi-3.5-vision",
  "phi-4-multimodal", "llama-3.2", "llama3.2",
];

const EXACT_VISION_IDS = ["o1", "o1-mini", "o1-preview", "o3", "o3-mini"];

/**
 * Heuristic: can this model accept image input directly? Unrecognised models are
 * treated as text-only (returns false), matching the backend, so their images get
 * OCR'd rather than silently dropped.
 */
export function isVisionCapable(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  if (VISION_MARKERS.some((marker) => m.includes(marker))) return true;
  return EXACT_VISION_IDS.includes(m);
}
