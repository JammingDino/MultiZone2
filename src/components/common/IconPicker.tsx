import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { getZoneIcon, ZONE_ICONS, ZONE_ICON_GROUPS } from "@/lib/zoneIcons";
import { Popover } from "@/components/common/Popover";

/**
 * The app's one icon picker.
 *
 * Zones, projects and anything else that carries an icon choose from the same
 * set, so they get the same control: a trigger showing the current icon on its
 * colour, and a popover with a search box and the grouped grid. It lives in a
 * popover rather than inline because the full grid was otherwise the tallest
 * thing on the form, for what is a one-off choice.
 *
 * Both editors used to hand-roll this and had drifted — the project editor's
 * grid was always open, had no "no results" state and styled selection
 * differently. One component means picking an icon feels the same wherever you
 * do it, and a fix lands in both places.
 */
export function IconPicker({
  value,
  onChange,
  activeColor,
  label = "Icon",
}: {
  /** Stored icon id, or null for the default. */
  value: string | null;
  onChange: (iconId: string | null) => void;
  /** Colour the selected icon is drawn on — the owner's accent. */
  activeColor: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");

  // null = show the grouped grid; an array = flat search results.
  const filtered = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    return ZONE_ICONS.filter((i) => i.label.toLowerCase().includes(q));
  }, [search]);

  const SelectedIcon = getZoneIcon(value);


  function pick(iconId: string) {
    // Clicking the current icon clears it, which is the only way back to the
    // default from inside the grid.
    onChange(iconId === value ? null : iconId);
    setOpen(false);
  }

  const grid = (icons: typeof ZONE_ICONS) => (
    <div className="grid grid-cols-10 gap-1">
      {icons.map(({ id, icon: IconComp, label: iconLabel }) => (
        <IconSwatch
          key={id}
          IconComp={IconComp}
          label={iconLabel}
          selected={value === id}
          activeColor={activeColor}
          onClick={() => pick(id)}
        />
      ))}
    </div>
  );

  return (
    <div className="relative">
      <div className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
        <span>{label}</span>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex items-center gap-1 hover:text-[var(--color-text)]"
          >
            <X size={10} /> Clear
          </button>
        )}
      </div>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded border border-[var(--color-border)] px-2 py-1 text-left hover:border-[var(--color-accent)]"
      >
        <span
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md"
          style={{ background: activeColor }}
        >
          <SelectedIcon size={15} color="white" />
        </span>
        <span className="truncate text-xs">{value ?? "Default"}</span>
        <span className="ml-auto shrink-0 text-[11px] text-[var(--color-text-muted)]">Change</span>
      </button>

      <Popover
        open={open}
        onClose={() => { setOpen(false); setSearch(""); }}
        anchorRef={buttonRef}
        matchAnchorWidth
        zIndex={90}
        className="w-[320px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-2 shadow-xl"
      >
          <div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search icons…"
              className="input mb-2 text-xs"
              autoFocus
            />
            <div className="max-h-56 overflow-y-auto rounded border border-[var(--color-border)] p-2">
              {filtered !== null ? (
                filtered.length === 0 ? (
                  <div className="py-2 text-center text-xs text-[var(--color-text-muted)]">
                    No icons found
                  </div>
                ) : (
                  grid(filtered)
                )
              ) : (
                <div className="flex flex-col gap-3">
                  {ZONE_ICON_GROUPS.map((group) => (
                    <div key={group.label}>
                      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                        {group.label}
                      </div>
                      {grid(group.icons)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
      </Popover>
    </div>
  );
}

function IconSwatch({
  IconComp,
  label,
  selected,
  activeColor,
  onClick,
}: {
  IconComp: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  selected: boolean;
  activeColor: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`flex items-center justify-center rounded p-1.5 transition ${
        selected ? "" : "hover:bg-[var(--color-panel-hover)]"
      }`}
      style={selected ? { background: activeColor } : undefined}
    >
      <IconComp size={14} color={selected ? "white" : undefined} />
    </button>
  );
}
