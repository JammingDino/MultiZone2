/**
 * The settings switch, and the labelled row it usually sits in.
 *
 * Both lived inside SettingsModal until the update section needed one — and
 * SettingsModal imports that section, so borrowing it back would have been a
 * cycle. Nothing here is settings-specific; it is a switch.
 */

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${checked ? "translate-x-4" : ""}`}
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
