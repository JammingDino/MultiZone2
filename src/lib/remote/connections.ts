/**
 * The computers this phone knows (0.17.4).
 *
 * Pairing used to write one session and that was the whole model: connected, or
 * not. Two things broke on contact with real use. A phone that loses its
 * desktop had no way back except re-entering an address and a fresh code, and
 * somebody with a laptop *and* a desktop had to re-pair every time they moved
 * between them — even though both machines still held a live token for that
 * phone.
 *
 * So the phone keeps a list, and "connected" is a pointer into it. Nothing
 * about the desktop side changes: each entry is still one per-device token that
 * one machine minted and can revoke on its own.
 *
 * This is *not* a second store of app data, which the whole design refuses. It
 * holds addresses and the tokens this device was given — the phone's own
 * credentials, which have to live somewhere on the phone or there is no remote
 * client at all. No chats, no zones, nothing the desktop owns.
 */

export interface SavedConnection {
  /** The desktop's id for *this device* — unique per pairing, so it doubles as
   *  the entry's identity. */
  id: string;
  /** `http://192.168.1.5:8765` — no trailing slash. */
  baseUrl: string;
  /** The per-device token that desktop minted. Never its static token. */
  token: string;
  /** What the desktop calls this device. */
  deviceName: string;
  /** What to call the desktop in the list. Defaults to its address, because an
   *  address is at least true; the user can rename it. */
  label: string;
  lastUsedAt: number;
}

const LIST_KEY = "multizone.remote.connections";
const ACTIVE_KEY = "multizone.remote.activeConnection";
/** What 0.17.0–0.17.3 wrote. Read once and folded in, so upgrading the app does
 *  not sign the phone out of a desktop it is already paired with. */
const LEGACY_SESSION_KEY = "multizone.remote.session";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A phone with storage disabled can still be used; it just forgets the
    // desktop when the app closes. Failing the whole app over that would be a
    // worse trade than a session that does not persist.
  }
}

/** Fold a pre-0.17.4 single session into the list, once. */
function migrateLegacy(list: SavedConnection[]): SavedConnection[] {
  const legacy = read<Partial<SavedConnection> & { deviceId?: string } | null>(
    LEGACY_SESSION_KEY,
    null,
  );
  if (!legacy?.baseUrl || !legacy?.token) return list;

  const id = legacy.deviceId ?? legacy.id ?? legacy.baseUrl;
  if (!list.some((c) => c.id === id)) {
    list = [
      {
        id,
        baseUrl: legacy.baseUrl,
        token: legacy.token,
        deviceName: legacy.deviceName ?? "This device",
        label: hostOf(legacy.baseUrl),
        lastUsedAt: Date.now(),
      },
      ...list,
    ];
    write(LIST_KEY, list);
    if (!read<string | null>(ACTIVE_KEY, null)) write(ACTIVE_KEY, id);
  }
  write(LEGACY_SESSION_KEY, null);
  return list;
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Every saved computer, most recently used first. */
export function listConnections(): SavedConnection[] {
  const list = migrateLegacy(read<SavedConnection[]>(LIST_KEY, []));
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export function activeConnection(): SavedConnection | null {
  const id = read<string | null>(ACTIVE_KEY, null);
  if (!id) return null;
  return listConnections().find((c) => c.id === id) ?? null;
}

/** Add a connection (or replace one for the same desktop) and make it active. */
export function saveConnection(entry: Omit<SavedConnection, "lastUsedAt">): SavedConnection {
  const saved: SavedConnection = { ...entry, lastUsedAt: Date.now() };
  // Keyed by id *and* by address: re-pairing the same desktop mints a new
  // device id, and leaving the old row behind would show the same computer
  // twice with one dead token between them.
  const list = listConnections().filter(
    (c) => c.id !== saved.id && c.baseUrl !== saved.baseUrl,
  );
  write(LIST_KEY, [saved, ...list]);
  write(ACTIVE_KEY, saved.id);
  return saved;
}

/** Switch to a saved computer. Returns null if it is gone. */
export function activate(id: string): SavedConnection | null {
  const entry = listConnections().find((c) => c.id === id);
  if (!entry) return null;
  const touched = { ...entry, lastUsedAt: Date.now() };
  write(LIST_KEY, [touched, ...listConnections().filter((c) => c.id !== id)]);
  write(ACTIVE_KEY, id);
  return touched;
}

export function renameConnection(id: string, label: string) {
  const list = listConnections().map((c) => (c.id === id ? { ...c, label } : c));
  write(LIST_KEY, list);
}

/**
 * Forget a computer on this phone.
 *
 * Local only. The desktop still lists this device as paired until somebody
 * revokes it there, and saying otherwise would be the more dangerous lie:
 * "removed" that leaves a working token is exactly the confusion per-device
 * revocation exists to avoid. The UI says so.
 */
export function forgetConnection(id: string) {
  write(LIST_KEY, listConnections().filter((c) => c.id !== id));
  if (read<string | null>(ACTIVE_KEY, null) === id) write(ACTIVE_KEY, null);
}

/** Disconnect without forgetting — back to the list, everything kept. */
export function deactivate() {
  write(ACTIVE_KEY, null);
}
