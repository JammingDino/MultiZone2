/**
 * The remote transport (0.17.1) — the same app, driven over HTTP instead of IPC.
 *
 * The frontend has exactly one seam. Every backend call in the React app goes
 * through `src/lib/tauri.ts`, which is `invoke` for commands and `listen` for
 * events, with a short list of window-chrome exceptions. Implement those two
 * functions against HTTP + SSE and the existing app *is* the remote client: the
 * port is a transport, not a rewrite.
 *
 * Three things make that a small file rather than a large one:
 *
 * - **The route map is generated**, from the same `COVERAGE` table the Rust
 *   drift test enforces. There is no hand-written list of 145 commands here to
 *   fall out of step with the app.
 * - **Argument placement is a rule, not a table.** Path parameters are filled
 *   by name from the call's own arguments; what is left goes to the query
 *   string or the body depending on the method. That rule, and the two commands
 *   that need an exception to it, live in `mapping.ts` — pure functions, so the
 *   part most likely to be subtly wrong is the part with tests.
 * - **Events are one stream.** `GET /api/events` carries every event a window
 *   would have received, so `listen` is a filter over a subscription rather
 *   than a per-event endpoint.
 *
 * What this deliberately does not do is work offline. If the desktop cannot be
 * reached, calls fail and say so. A cache that answered while the machine at
 * home was asleep would be a second copy of the store, which is the thing this
 * whole design exists to avoid.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { GUI_ONLY, ROUTE_MAP } from "./routeMap.generated";
import {
  buildRequest,
  errorMessage,
  normalizeBaseUrl,
  parsePairingLink,
  STREAMING,
} from "./mapping";

export { normalizeBaseUrl, parsePairingLink };

// ─── The session ─────────────────────────────────────────────────────────────

/** A paired desktop this client can talk to. */
export interface RemoteSession {
  /** e.g. `http://192.168.1.5:8765` — no trailing slash. */
  baseUrl: string;
  /** The per-device token pairing minted. Never the desktop's static token. */
  token: string;
  deviceId: string;
  /** What the desktop calls this device, for the "connected to" line. */
  deviceName: string;
}

const STORAGE_KEY = "multizone.remote.session";

let session: RemoteSession | null = readStoredSession();

/**
 * Where the token lives.
 *
 * `localStorage` on the app's own origin, which on a packaged mobile shell is
 * inside the app's private data directory. That is not the platform keystore,
 * and the difference matters on a rooted or unlocked device — noted here rather
 * than quietly, because it is the one place this implementation is weaker than
 * the design it came from.
 */
function readStoredSession(): RemoteSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RemoteSession;
    if (!parsed?.baseUrl || !parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when this window is a remote for a desktop rather than the desktop. */
export function isRemote(): boolean {
  return session !== null;
}

export function currentSession(): RemoteSession | null {
  return session;
}

export function setSession(next: RemoteSession | null) {
  session = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
  // Anything mid-flight belongs to the desktop we were talking to a moment ago.
  closeEventStream();
}

/** Forget the desktop. Does not revoke on the far side — a device that cannot
 *  reach the desktop cannot ask it to forget, and pretending otherwise would
 *  leave a live token with nothing on screen to revoke. */
export function signOut() {
  setSession(null);
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

export interface PairResult {
  token: string;
  deviceId: string;
  deviceName: string;
}

/**
 * Redeem a code for this device's own token, and remember the desktop.
 *
 * The only call in this file that does not need a session, for the obvious
 * reason.
 */
export async function pair(opts: {
  baseUrl: string;
  code: string;
  name: string;
  platform: string;
}): Promise<RemoteSession> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const res = await fetch(`${baseUrl}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: opts.code, name: opts.name, platform: opts.platform }),
  });
  const body = await readBody(res);
  if (!res.ok) throw new Error(errorMessage(body, res.status));
  const grant = body as PairResult;
  const next: RemoteSession = {
    baseUrl,
    token: grant.token,
    deviceId: grant.deviceId,
    deviceName: grant.deviceName,
  };
  setSession(next);
  return next;
}

// ─── invoke ──────────────────────────────────────────────────────────────────

/**
 * Call a backend command — over IPC on the desktop, over HTTP on a remote.
 *
 * A drop-in for `@tauri-apps/api/core`'s `invoke`, which is what lets
 * `src/lib/tauri.ts` change two import lines and nothing else.
 */
export async function invoke<T>(command: string, args: Record<string, any> = {}): Promise<T> {
  if (!session) return tauriInvoke<T>(command, args);

  const guiOnly = GUI_ONLY[command];
  if (guiOnly) {
    // A better answer than a 404: the reason is already written down, and it is
    // always "this needs the machine the app is running on".
    throw new Error(`"${command}" only works on the computer itself — ${guiOnly}.`);
  }

  const binding = ROUTE_MAP[command];
  if (!binding) {
    throw new Error(`"${command}" has no route, so it cannot be used from here.`);
  }
  const { method, url, body } = buildRequest(binding, command, args, session.baseUrl);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body,
  });

  // A turn is driven by the server, not by whoever asked for it: the route
  // spawns the run and streams a copy. The events we care about arrive on
  // /api/events like every other event, so holding this response open until the
  // turn ends would only mean `sendMessage` did not resolve until the model
  // stopped talking.
  if (STREAMING.has(command)) {
    if (!res.ok) throw new Error(errorMessage(await readBody(res), res.status));
    void res.body?.cancel().catch(() => {});
    return undefined as T;
  }

  const parsed = await readBody(res);
  if (!res.ok) throw new Error(errorMessage(parsed, res.status));
  return parsed as T;
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── listen ──────────────────────────────────────────────────────────────────

type Handler = (event: { payload: any }) => void;

const handlers = new Map<string, Set<Handler>>();
let streamController: AbortController | null = null;
let streamStarted = false;

/**
 * Subscribe to an app event — over IPC on the desktop, over one SSE stream on a
 * remote.
 *
 * A drop-in for `@tauri-apps/api/event`'s `listen`. The remote side multiplexes:
 * one connection carries every event, and this dispatches by name, because
 * fifteen long-lived HTTP connections from a phone is fifteen chances for a
 * router to reap one.
 */
export function listen<T>(
  event: string,
  handler: (e: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (!session) return tauriListen<T>(event, handler);

  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(handler as Handler);
  handlers.set(event, set);
  ensureEventStream();

  return Promise.resolve(() => {
    set.delete(handler as Handler);
    if (set.size === 0) handlers.delete(event);
  });
}

/** Where the connection stands, for the "the desktop is asleep" banner. */
export type ConnectionState = "connecting" | "live" | "offline";

let connectionState: ConnectionState = "connecting";
const connectionWatchers = new Set<(s: ConnectionState) => void>();

export function onConnectionChange(fn: (s: ConnectionState) => void): () => void {
  connectionWatchers.add(fn);
  fn(connectionState);
  return () => connectionWatchers.delete(fn);
}

function setConnectionState(next: ConnectionState) {
  if (next === connectionState) return;
  connectionState = next;
  for (const fn of connectionWatchers) fn(next);
}

export function connection(): ConnectionState {
  return connectionState;
}

function closeEventStream() {
  streamController?.abort();
  streamController = null;
  streamStarted = false;
  handlers.clear();
  setConnectionState("connecting");
}

/**
 * Hold one connection to `/api/events`, reconnecting when it drops.
 *
 * `fetch` rather than `EventSource` for one reason: `EventSource` cannot set
 * headers, so the token would have to go in the query string — into every proxy
 * log and browser history entry on the way. A per-device token in a URL is a
 * per-device token somebody else can read.
 */
function ensureEventStream() {
  if (streamStarted || !session) return;
  streamStarted = true;
  void runEventStream();
}

async function runEventStream() {
  // Backs off on repeated failure — a desktop that is asleep is the expected
  // case, not an error to hammer at. Capped, so waking it up is noticed within
  // half a minute rather than whenever the backoff happens to come round.
  let delay = 1000;

  while (streamStarted && session) {
    const controller = new AbortController();
    streamController = controller;
    try {
      const res = await fetch(`${session.baseUrl}/api/events`, {
        headers: { Authorization: `Bearer ${session.token}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (res.status === 401) {
        // Revoked, or the desktop's database was replaced. Either way this
        // device is not paired any more, and retrying forever would show a
        // "connecting" spinner for a session that will never come back.
        setConnectionState("offline");
        signOut();
        return;
      }
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);

      setConnectionState("live");
      delay = 1000;
      await consumeEventStream(res.body);
    } catch {
      // Includes the ordinary case of the connection being closed by a router,
      // a sleeping laptop, or a Wi-Fi handover.
      setConnectionState("offline");
    }

    if (!streamStarted) return;
    await sleep(delay);
    delay = Math.min(delay * 2, 30_000);
  }
}

/** Parse the SSE framing: `event:` and `data:` lines, blank line ends a frame. */
async function consumeEventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      dispatchFrame(frame);
    }
  }
}

function dispatchFrame(frame: string) {
  let name = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    // `:` comment lines are the keep-alive, and are meant to be ignored.
  }
  if (data.length === 0) return;

  // "ready" and "lagged" are the stream talking about itself, not app events.
  if (name === "ready") return;
  if (name === "lagged") {
    // The client fell behind and events were dropped. Anything cached from
    // before is now suspect, so tell the app to re-read rather than let it
    // carry on believing it saw everything.
    deliver("app-data-changed", { method: "SSE", path: "/api/events" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    payload = data.join("\n");
  }
  deliver(name, payload);
}

function deliver(name: string, payload: unknown) {
  const set = handlers.get(name);
  if (!set) return;
  for (const handler of set) {
    try {
      handler({ payload });
    } catch (e) {
      // One listener throwing must not take the stream down with it.
      console.error(`remote listener for "${name}" threw`, e);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { UnlistenFn };
