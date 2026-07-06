import { useApp } from "@/store/app";
import { isVisionCapable } from "@/lib/vision";

/**
 * Three-way per-model override for image input — Auto / On / Off — stored in
 * the `visionOverrides` app setting keyed by the exact model name (so the same
 * model shares one setting across zones, quick chat, and one-shot overrides).
 * Auto defers to the name heuristic (lib/vision.ts); On always sends images to
 * the model; Off always converts them to text via OCR first.
 */
export function VisionOverrideSelect({ model, className }: { model: string; className?: string }) {
  const visionOverrides = useApp((s) => s.appSettings.visionOverrides);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const m = model.trim();
  const value = (m && visionOverrides[m]) || "auto";
  const detected = isVisionCapable(m);

  async function onChange(next: string) {
    if (!m) return;
    const map = { ...visionOverrides };
    if (next === "auto") delete map[m];
    else map[m] = next as "on" | "off";
    await setAppSettings({ visionOverrides: map });
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={!m}
      className={className ?? "input"}
      title="Whether attached images are sent to this model directly or converted to text via OCR first. Auto detects support from the model name — override it when detection gets your model wrong."
    >
      <option value="auto">
        {m
          ? `Auto — ${detected ? "detected as image-capable" : "not detected, images sent as OCR text"}`
          : "Auto (set a model first)"}
      </option>
      <option value="on">On — always send images to the model</option>
      <option value="off">Off — always convert images to text (OCR)</option>
    </select>
  );
}
