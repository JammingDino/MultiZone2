import { useApp } from "@/store/app";
import { isVisionCapable } from "@/lib/vision";
import { isMediaCapable, type MediaKind } from "@/lib/media";

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

/**
 * The same three-way choice for audio and video input (0.18.1), stored in
 * `audioOverrides` / `videoOverrides`. On sends the file itself; Off transcribes
 * audio and refuses video.
 */
export function MediaOverrideSelect({ model, kind }: { model: string; kind: MediaKind }) {
  const key = kind === "audio" ? "audioOverrides" : "videoOverrides";
  const overrides = useApp((s) => s.appSettings[key]);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const m = model.trim();
  const value = (m && overrides[m]) || "auto";
  const detected = isMediaCapable(m, kind);
  const noun = kind === "audio" ? "audio" : "video";

  async function onChange(next: string) {
    if (!m) return;
    const map = { ...overrides };
    if (next === "auto") delete map[m];
    else map[m] = next as "on" | "off";
    await setAppSettings({ [key]: map });
  }

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!m} className="input">
      <option value="auto">{m ? `Auto — ${detected ? "detected" : "not detected"}` : "Auto (set a model first)"}</option>
      <option value="on">On — send the {noun} itself</option>
      <option value="off">{kind === "audio" ? "Off — send a transcript" : "Off — refuse video"}</option>
    </select>
  );
}
