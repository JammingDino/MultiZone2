import { X } from "lucide-react";
import { ZONE_COLOR_PRESETS } from "@/lib/zoneIcons";

/**
 * The app's one colour picker: the preset swatches, then a custom-colour well
 * showing the current hex.
 *
 * Zones, projects and tags all pick a colour the same way, so they use the same
 * control. The three hand-rolled copies had drifted in small ways — one was
 * missing the hover border on the custom well, and only one offered a way back
 * to the global accent without hunting for the currently-selected swatch.
 *
 * `null` means "inherit the global accent"; `clearLabel` names what that means
 * here, since it reads differently for a zone than for a tag.
 */
export function ColorPicker({
  value,
  onChange,
  label = "Color",
  clearLabel = "Use global accent",
}: {
  value: string | null;
  onChange: (color: string | null) => void;
  label?: string;
  clearLabel?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
        <span>{label}</span>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex items-center gap-1 hover:text-[var(--color-text)]"
          >
            <X size={10} /> {clearLabel}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {ZONE_COLOR_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(value === color ? null : color)}
            className="h-6 w-6 rounded-full transition hover:scale-110"
            style={{
              background: color,
              outline: value === color ? `2px solid ${color}` : "2px solid transparent",
              outlineOffset: "2px",
            }}
            title={color}
          />
        ))}
        <div
          className="relative flex h-6 w-8 cursor-pointer items-center justify-center overflow-hidden rounded border border-[var(--color-border)] hover:border-[var(--color-accent)]"
          title="Custom color"
        >
          <input
            type="color"
            value={value ?? "#4f9cf9"}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
          <span className="pointer-events-none z-10 font-mono text-[9px] text-[var(--color-text-muted)]">
            {value ? value.slice(1, 4).toUpperCase() : "···"}
          </span>
        </div>
      </div>
    </div>
  );
}
