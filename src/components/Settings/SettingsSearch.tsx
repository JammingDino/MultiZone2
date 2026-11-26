import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useApp } from "@/store/app";
import { SETTINGS_INDEX } from "@/lib/settingsIndex.generated";
import { groupByTab, markRuns, searchSettings, type SettingsEntry } from "@/lib/settingsSearch";

const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * Open Settings on the tab holding `entry`, unfold Advanced if it hides there,
 * and bring the section into view with a brief highlight.
 *
 * Polled rather than awaited: the tab mounts on the next render and several
 * load their data first, so the heading appears when it appears. Two seconds
 * and it gives up, leaving the user on the right tab regardless.
 */
export function openSettingAt(entry: SettingsEntry) {
  const s = useApp.getState();
  s.openSettings();
  s.setSettingsTab(entry.tab);
  let tries = 0;
  let unfolded = false;
  const step = () => {
    const root = document.querySelector<HTMLElement>(`[data-settings-content="${entry.tab}"]`);
    if (root) {
      const h3s = [...root.querySelectorAll("h3")];
      const h3 = h3s.find((h) => norm(h.textContent) === entry.heading) ?? h3s.find((h) => norm(h.textContent).startsWith(entry.heading));
      if (h3) return reveal(sectionOf(h3, root));
      if (entry.advanced && !unfolded) {
        const toggle = [...root.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')].find((b) =>
          norm(b.textContent).startsWith("Advanced"),
        );
        if (toggle) {
          toggle.click();
          unfolded = true;
        }
      }
    }
    if (++tries < 40) window.setTimeout(step, 50);
  };
  window.setTimeout(step, 0);
}

/** The same walk the index generator does: the largest box holding only this heading. */
function sectionOf(h3: HTMLElement, root: HTMLElement): HTMLElement {
  let el = h3;
  while (el.parentElement && el.parentElement !== root && el.parentElement.querySelectorAll("h3").length === 1) {
    el = el.parentElement;
  }
  return el;
}

function reveal(el: HTMLElement) {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.setAttribute("data-settings-target", "");
  el.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
  // Focus follows, so Tab continues from the setting rather than the search box.
  el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  el.classList.remove("mz-settings-flash");
  void el.offsetWidth; // restart the animation when the same section is picked twice
  el.classList.add("mz-settings-flash");
  window.setTimeout(() => el.classList.remove("mz-settings-flash"), 1800);
}

function Marked({ text, marks }: { text: string; marks: number[] }) {
  return (
    <>
      {markRuns(text, marks).map((r, i) =>
        r.hit ? (
          <mark key={i} className="bg-transparent font-semibold text-[var(--color-accent)]">
            {r.text}
          </mark>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.tagName === "SELECT" || !!el?.isContentEditable;
}

/**
 * Search across every Settings tab (0.21). Returns the field, for the modal's
 * header, and the results, which stand in for the open tab while there is a
 * query — Settings renders one tab at a time, so the index comes from
 * scripts/gen-settings-index.mjs rather than from the page.
 */
export function useSettingsSearch() {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => groupByTab(searchSettings(SETTINGS_INDEX, query)), [query]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const q = query.trim();

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    document.getElementById(`settings-hit-${cursor}`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, flat]);

  // Ctrl+F, or "/" outside a field, as on a web page or a docs site.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const find = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f";
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target);
      if (!find && !slash) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function pick(i: number) {
    const hit = flat[i];
    if (!hit) return;
    setQuery("");
    openSettingAt(hit.entry);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = flat.length;
      if (n) setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" && flat[cursor]) {
      e.preventDefault();
      pick(cursor);
    } else if (e.key === "Escape" && query) {
      // Clears first; the next Escape closes Settings as it always has.
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    }
  }

  // A touchscreen would open its keyboard over the page just for visiting it.
  const autoFocus = typeof window !== "undefined" && !window.matchMedia("(pointer: coarse)").matches;

  const field = (
    <div className="relative ml-2 w-60 narrow:w-36">
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search settings"
        aria-label="Search settings"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!!q}
        aria-controls="settings-search-results"
        aria-activedescendant={q && flat[cursor] ? `settings-hit-${cursor}` : undefined}
        spellCheck={false}
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-7 pr-7 text-[13px] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)]"
      />
      {query && (
        <button
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );

  let i = -1;
  const results = q ? (
    <div className="flex-1 overflow-y-auto p-5">
      <p className="sr-only" aria-live="polite">
        {flat.length === 0 ? "No settings match" : `${flat.length} ${flat.length === 1 ? "setting matches" : "settings match"}`}
      </p>
      {flat.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">No setting matches “{q}”.</p>
      ) : (
        <div id="settings-search-results" role="listbox" aria-label="Matching settings" className="flex max-w-2xl flex-col gap-4">
          {groups.map((g) => (
            <div key={g.tab} role="group" aria-labelledby={`settings-group-${g.tab}`}>
              <p id={`settings-group-${g.tab}`} className="mb-1 px-2 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                {g.tabLabel}
              </p>
              {g.hits.map((h) => {
                const idx = ++i;
                const active = idx === cursor;
                return (
                  <div
                    key={h.entry.heading}
                    id={`settings-hit-${idx}`}
                    role="option"
                    aria-selected={active}
                    onMouseMove={() => setCursor(idx)}
                    // Keep focus in the field, so the keyboard carries on working.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(idx)}
                    className={`cursor-pointer rounded-md px-2 py-1.5 ${active ? "bg-[var(--color-panel-hover)]" : ""}`}
                  >
                    <span className="block text-sm">
                      <Marked text={h.entry.heading} marks={h.headingMarks} />
                      {h.entry.advanced && <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">in Advanced</span>}
                    </span>
                    {h.detail && (
                      <span className="block truncate text-xs text-[var(--color-text-muted)]">
                        <Marked text={h.detail} marks={h.detailMarks} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  ) : null;

  return { field, results, clear: () => setQuery("") };
}
