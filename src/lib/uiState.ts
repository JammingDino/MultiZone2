import { useCallback, useState } from "react";

/**
 * View-state persistence for ephemeral UI toggles (which project folders are
 * collapsed, which branches are folded, which subchats are expanded). These are
 * pure presentation preferences, not domain data, so they live in localStorage
 * — synchronous, per-install, and surviving app restarts without a backend
 * round-trip. Keys are namespaced under `ui.` to keep them grouped.
 */

const PREFIX = "ui.";

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, ids: string[]) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(ids));
  } catch {
    /* storage full / disabled — degrade to in-memory only */
  }
}

/**
 * A `Set<string>` of ids whose membership persists across sessions under
 * `ui.<key>`. Returns the live set plus `toggle`/`has` helpers. Use it to track
 * which items are in a non-default view state (e.g. collapsed / expanded).
 */
export function usePersistentSet(key: string): {
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  set: (id: string, present: boolean) => void;
} {
  const [ids, setIds] = useState<Set<string>>(() => new Set(read(key)));

  const persist = useCallback(
    (next: Set<string>) => {
      setIds(next);
      write(key, [...next]);
    },
    [key],
  );

  const has = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
    },
    [ids, persist],
  );

  const set = useCallback(
    (id: string, present: boolean) => {
      const next = new Set(ids);
      if (present) next.add(id);
      else next.delete(id);
      persist(next);
    },
    [ids, persist],
  );

  return { has, toggle, set };
}

/** A single boolean persisted under `ui.<key>` (default-aware). */
export function usePersistentBool(key: string, defaultValue: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? defaultValue : raw === "true";
    } catch {
      return defaultValue;
    }
  });
  const update = useCallback(
    (v: boolean) => {
      setValue(v);
      try { localStorage.setItem(PREFIX + key, String(v)); } catch { /* ignore */ }
    },
    [key],
  );
  return [value, update];
}

/**
 * A single string persisted under `ui.<key>`, constrained to a known set.
 *
 * The `allowed` list is what makes this safe to read back: localStorage is
 * user-writable and survives across versions, so a value that was legal in an
 * older build (or typed in by hand) must not be able to reach code that assumes
 * it is one of today's options.
 */
export function usePersistentChoice<T extends string>(
  key: string,
  defaultValue: T,
  allowed: readonly T[],
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key) as T | null;
      return raw !== null && allowed.includes(raw) ? raw : defaultValue;
    } catch {
      return defaultValue;
    }
  });
  const update = useCallback(
    (v: T) => {
      setValue(v);
      try { localStorage.setItem(PREFIX + key, v); } catch { /* ignore */ }
    },
    [key],
  );
  return [value, update];
}
