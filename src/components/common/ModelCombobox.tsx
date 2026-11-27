import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { rovingIndex } from "@/lib/keyboard";
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
 * menu (a click, the chevron, ↓) shows the *full* list regardless of the
 * current value; the list only narrows once the user actually types. Selecting
 * an option, or typing a name that isn't listed, both commit via `onChange`.
 *
 * From the keyboard (0.21) it is an ARIA combobox: focus stays in the field,
 * ↓/↑ open the list and move through it, Enter picks, Esc closes. It no
 * longer opens on focus, so tabbing through a form doesn't drop a list over
 * every model field on the way.
 */
export function ModelCombobox({ value, onChange, options, placeholder, className, id, disabled }: Props) {
  const [open, setOpen] = useState(false);
  // null = not actively filtering (show everything); string = live query.
  const [filter, setFilter] = useState<string | null>(null);
  // The highlighted option, -1 for none (Enter then keeps what was typed).
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  function close() {
    setOpen(false);
    setFilter(null);
    setActive(-1);
  }

  function openList() {
    if (disabled) return;
    setOpen(true);
    setFilter(null);
    setActive(options.indexOf(value));
  }

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
        close();
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Escape closes the list before it reaches any modal behind it. The input's
  // own handler covers the common case (focus is in the field); this covers
  // Escape pressed after focus has moved elsewhere.
  useDismissOnEscape(open, close);

  const list =
    filter === null || filter.trim() === ""
      ? options
      : options.filter((o) => o.toLowerCase().includes(filter.toLowerCase()));
  const shown = open && list.length > 0;
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    if (shown && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [shown, active]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(opt: string) {
    onChange(opt);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      openList();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown) openList();
      else setActive((i) => rovingIndex(e.key, i, list.length, "vertical") ?? i);
    } else if (e.key === "Enter" && shown) {
      // Picking from the list is the Enter; a typed name is already committed.
      if (active >= 0 && list[active]) {
        e.preventDefault();
        pick(list[active]);
      } else close();
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab" && open) {
      close();
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        value={value}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
        style={{ paddingRight: 26 }}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        onClick={() => { if (!open) openList(); }}
        onChange={(e) => { onChange(e.target.value); setFilter(e.target.value); setOpen(true); setActive(-1); }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label="Show models"
        // Focus to the field, not the chevron, so the keys work after a click.
        onMouseDown={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
        onClick={() => (open ? close() : openList())}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
      >
        <ChevronDown size={14} />
      </button>
      <Popover
        open={shown}
        onClose={close}
        anchorRef={wrapRef}
        matchAnchorWidth
        backdrop={false}
        zIndex={90}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
      >
        <div id={listId} role="listbox" aria-label="Models">
          {list.map((opt, i) => (
            <div
              key={opt}
              id={optionId(i)}
              role="option"
              aria-selected={opt === value}
              // Focus stays in the field, where the keys are.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(opt)}
              className={`block w-full cursor-pointer truncate px-3 py-1.5 text-left text-xs hover:bg-[var(--color-panel-hover)] ${
                i === active ? "bg-[var(--color-panel-hover)]" : ""
              } ${opt === value ? "text-[var(--color-accent)]" : ""}`}
              title={opt}
            >
              {opt}
            </div>
          ))}
        </div>
      </Popover>
    </div>
  );
}
