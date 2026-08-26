/**
 * The settings switch, and the labelled row it usually sits in.
 *
 * Both lived inside SettingsModal until the update section needed one — and
 * SettingsModal imports that section, so borrowing it back would have been a
 * cycle. Nothing here is settings-specific; it is a switch.
 */

/**
 * The switch.
 *
 * Its geometry is its own: a track with an absolutely positioned knob, laid out
 * from the track's height. That is worth stating because a global
 * `min-height` for touch targets stretched the track and left the knob at its
 * top edge — every switch in Settings rendered as a tall thin capsule on a
 * phone (0.17.3). It grows on a coarse pointer by changing the *whole* control,
 * knob included, rather than by having a height imposed on it from outside.
 *
 * `role="switch"` and `aria-checked` because the visual state is entirely
 * colour and position, which is nothing to a screen reader.
 */
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors coarse:h-7 coarse:w-12 ${checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 coarse:h-6 coarse:w-6 ${checked ? "translate-x-4 coarse:translate-x-5" : ""}`}
      />
    </button>
  );
}

export function ToggleRow({
  label, description, checked, onChange,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      onClick={() => onChange(!checked)}
      className="flex cursor-pointer items-center justify-between gap-3 rounded border border-[var(--color-border)] px-3 py-2.5 hover:border-[var(--color-accent)]"
    >
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {description && <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{description}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}
