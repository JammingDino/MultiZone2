import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { Popover } from "@/components/common/Popover";

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  /** CSS class applied to the text input (e.g. the shared `.input` class). */
  className?: string;
  id?: string;
  disabled?: boolean;
}

/**
 * Free-text combobox for model names. Unlike a native <datalist>, opening the
 * menu (focus or chevron click) shows the *full* list regardless of the current
 * value; the list only narrows once the user actually types. Selecting an
 * option, or typing a name that isn't listed, both commit via `onChange`.
 */
export function ModelCombobox({ value, onChange, options, placeholder, className, id, disabled }: Props) {
  const [open, setOpen] = useState(false);
  // null = not actively filtering (show everything); string = live query.
  const [filter, setFilter] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      // The list is portalled to `body` (so a modal's scroll box can't clip
      // it), which puts it outside `wrapRef` — hence the second test.
      if (
        wrapRef.current &&
        !wrapRef.current.contains(target) &&
        !target.closest("[data-mz-popover]")
      ) {
        setOpen(false);
        setFilter(null);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Escape closes the list before it reaches any modal behind it. The input's
  // own handler covers the common case (focus is in the field); this covers
  // Escape pressed after focus has moved elsewhere.
  useDismissOnEscape(open, () => { setOpen(false); setFilter(null); });

  const list =
    filter === null || filter.trim() === ""
      ? options
      : options.filter((o) => o.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div ref={wrapRef} className="relative">
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
        style={{ paddingRight: 26 }}
        onFocus={() => { if (!disabled) { setOpen(true); setFilter(null); } }}
        onChange={(e) => { onChange(e.target.value); setFilter(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); setFilter(null); } }}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={() => { setOpen((v) => !v); setFilter(null); }}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
      >
        <ChevronDown size={14} />
      </button>
      <Popover
        open={open && list.length > 0}
        onClose={() => { setOpen(false); setFilter(null); }}
        anchorRef={wrapRef}
        matchAnchorWidth
        backdrop={false}
        zIndex={90}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
      >
        <div>
          {list.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => { onChange(opt); setFilter(null); setOpen(false); }}
              className={`block w-full truncate px-3 py-1.5 text-left text-xs hover:bg-[var(--color-panel-hover)] ${opt === value ? "text-[var(--color-accent)]" : ""}`}
              title={opt}
            >
              {opt}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
