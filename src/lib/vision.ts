// Mirror of the backend `is_vision_capable` heuristic (src-tauri/src/ocr.rs).
// Used pre-send so the input bar can warn that a vision-incapable model will get
// OCR-extracted text instead of the image itself. Keep these two files in sync.
//
// Real model ids bury the family name mid-string ("gemma-4-26B-A4B-it-MLX-4bit"),
// so beyond plain substring markers this also does token-level "vl" detection and
// family+version matching (any gemma ≥ 3, any llama ≥ 4, …) so new point releases
// of a known-multimodal family are caught without a list update.

const VISION_MARKERS = [
  // generic markers
  "vision", "multimodal", "omni",
  // open multimodal families
  "llava", "bakllava", "moondream", "minicpm-v", "internvl", "pixtral",
  "cogvlm", "smolvlm", "idefics", "fuyu", "kosmos", "paligemma", "molmo",
  "aria", "deepseek-ocr",
  // OpenAI multimodal
  "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "gpt-5", "o4-mini",
  // Anthropic (all Claude 3+ are multimodal; the version rule covers the rest)
  "claude-opus", "claude-sonnet", "claude-haiku", "claude-fable", "claude-mythos",
  // Google
  "gemini",
  // others
  "grok-vision", "step-1v", "yi-vision", "phi-3.5-vision",
  "phi-4-multimodal", "llama-3.2", "llama3.2",
];

/** Family + minimum version: every release at or above the version accepts
 * images, so "gemma-4-26B-…" matches without "gemma-4" itself being listed.
 * (Qwen deliberately has no rule — qwen3 text-only models exist; its vision
 * variants all carry "vl" or "omni".) */
const FAMILY_MIN_VERSION: [string, number][] = [
  ["gemma", 3],
  ["llama", 4], // llama-3.2 vision is covered by its explicit marker
  ["claude", 3],
  ["grok", 3],
];

const EXACT_VISION_IDS = ["o1", "o1-mini", "o1-preview", "o3", "o3-mini"];

/** "vl" as its own token — delimited ("qwen3-vl-8b") or directly after a digit
 * ("qwen2.5vl") — without firing on words that merely contain it ("vllm"). */
function hasVlToken(m: string): boolean {
  return /(^|[^a-z])vl(?![a-z])/.test(m);
}

/** Find `family` at a word boundary and parse the version that follows it
 * (optionally separated by -, _, space, or ., with an optional "v" prefix):
 * "gemma-4-26b" → 4, "gemma3n" → 3, "claude-4.5" → 4.5. */
function familyVersion(m: string, family: string): number | null {
  const re = new RegExp(`(^|[^a-z0-9])${family}[-_ .]?v?(\\d+(?:\\.\\d+)?)`);
  const match = re.exec(m);
  return match ? parseFloat(match[2]) : null;
}

/**
 * Heuristic: can this model accept image input directly? Unrecognised models are
 * treated as text-only (returns false), matching the backend, so their images get
 * OCR'd rather than silently dropped.
 */
export function isVisionCapable(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  if (VISION_MARKERS.some((marker) => m.includes(marker))) return true;
  if (hasVlToken(m)) return true;
  for (const [family, min] of FAMILY_MIN_VERSION) {
    const v = familyVersion(m, family);
    if (v !== null && v >= min) return true;
  }
  return EXACT_VISION_IDS.includes(m);
}

/** The user's manual per-model override map (the `visionOverrides` app setting).
 * "on" = always send images, "off" = always OCR to text; absent = auto. */
export type VisionOverrides = Record<string, "on" | "off">;

/** Override-aware capability check — what the backend will actually do. */
export function resolveVisionCapable(
  model: string | null | undefined,
  overrides: VisionOverrides | undefined,
): boolean {
  if (!model) return false;
  const ov = overrides?.[model];
  if (ov === "on") return true;
  if (ov === "off") return false;
  return isVisionCapable(model);
}
