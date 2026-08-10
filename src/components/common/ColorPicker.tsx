import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ZONE_COLOR_PRESETS } from "@/lib/zoneIcons";
import { normalizeHex } from "@/lib/color";

/**
 * A colour swatch with the hex written next to it, editable (0.11.3).
 *
 * `<input type="color">` alone opens the OS picker, which on Windows is an RGB
 * dialog — so a colour you already have as `#4f9cf9` (from a brand guide, a
 * stylesheet, the rest of this app) could only be entered by converting it to
 * three numbers by hand, and the value you had chosen was never displayed back
 * to you in the form you think of it in. The swatch stays, because dragging
 * around a colour wheel is the right tool for *finding* a colour; the field is
 * for the far commoner case of already knowing which one you want.
 *
 * Typing applies live as soon as the text is a colour, so the app repaints
 * under a pasted value the moment it is complete. Anything that isn't one is
 * marked and reverted on blur rather than being written and then rendered as
 * nothing.
 */
export function HexColorField({
  value,
  onChange,
  fallback = "#4f9cf9",
  title,
  width = "w-[72px]",
}: {
  /** The colour in force as `#rrggbb`, or `null` for "nothing chosen" — the
   *  field then sits empty and the swatch shows `fallback`. */
  value: string | null;
  onChange: (hex: string) => void;
  /** What the swatch opens on when no colour is chosen. */
  fallback?: string;
  title?: string;
  /** Width of the text field — the palette grid gives it less room. */
  width?: string;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const focused = useRef(false);

  // Follow the value while the user isn't typing: the swatch, a preset button
  // or a model changing the theme should all be reflected here. Mid-edit it
  // must not, or a half-typed `#4f9` would be rewritten under the cursor.
  useEffect(() => {
    if (!focused.current) setDraft(value ?? "");
  }, [value]);

  const parsed = normalizeHex(draft);
  // An empty field is "nothing chosen", not a mistake.
  const invalid = draft.trim() !== "" && parsed === null;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <input
        type="color"
        value={value ?? fallback}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value);
        }}
        title={title ?? "Pick a colour"}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
      />
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const hex = normalizeHex(e.target.value);
          if (hex) onChange(hex);
        }}
        onFocus={(e) => { focused.current = true; e.target.select(); }}
        onBlur={() => {
          focused.current = false;
          // An unfinished or nonsense value goes back to what is actually in
          // force — leaving `#ff` in the box would claim a colour that isn't.
          setDraft(parsed ?? value ?? "");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") { setDraft(value ?? ""); e.currentTarget.blur(); }
        }}
        spellCheck={false}
        placeholder="#rrggbb"
        title="Hex colour — # optional, three-digit shorthand accepted"
        className={`${width} shrink-0 rounded border bg-[var(--color-bg)] px-1.5 py-1 font-mono text-[11px] outline-none ${
          invalid
            ? "border-red-500/60 text-red-500"
            : "border-[var(--color-border)] focus:border-[var(--color-accent)]"
        }`}
      />
    </div>
  );
}

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
        <HexColorField
          value={value}
          onChange={onChange}
          title="Custom color"
        />
      </div>
    </div>
  );
}
