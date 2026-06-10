import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

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
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter(null);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

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
        onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setFilter(null); } }}
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
      {open && list.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
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
      )}
    </div>
  );
}
