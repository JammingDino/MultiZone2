/**
 * How a Tauri command call becomes an HTTP request (0.17.1).
 *
 * Split out of `transport.ts` so it can be tested without a browser: everything
 * here is a pure function of a command name and its arguments, and everything
 * that needs `fetch`, `localStorage` or a live desktop is next door.
 *
 * The whole mapping is three rules and two exceptions. That ratio is the point
 * — a per-command table of argument placements would be a second copy of the
 * API's shape, maintained by hand, and the drift test exists because the first
 * copy already rotted once.
 *
 * Nothing here imports anything, deliberately: it is what lets the test suite
 * run these functions directly under `node --test`.
 */

/** One command's route, as the generated map states it. */
export interface RouteBinding {
  method: string;
  path: string;
}

/** Commands whose route answers with a stream rather than a value. */
export const STREAMING: ReadonlySet<string> = new Set(["send_message", "regenerate_response"]);

/**
 * Fill `:param` placeholders from the call's own arguments.
 *
 * `:messageId` and friends match an argument of the same name. `:id` is the
 * ambiguous one — the app calls the same thing `id` in one command and `chatId`
 * in the next — so it also accepts the singular of the collection it follows:
 * `/api/chats/:id` takes `chatId`, `/api/plans/:id` takes `planId`.
 *
 * The specific name is tried *first*, and that order is load-bearing.
 * `cancel_pending_message({ chatId, id })` sends the chat as `chatId` and the
 * queued message as plain `id`, against `/api/chats/:id/queue/:messageId` — a
 * rule that grabbed `id` for `:id` would build a URL naming the message as the
 * chat, and then fail on the parameter it had just eaten the argument for.
 *
 * A miss throws here rather than sending a request to a URL with a literal
 * `:id` in it.
 *
 * Returns the arguments that were *not* consumed, which is what goes on to the
 * query string or the body.
 */
export function fillPath(
  template: string,
  args: Record<string, unknown>,
  command = "",
): { path: string; rest: Record<string, unknown> } {
  const rest: Record<string, unknown> = { ...args };
  const segments = template.split("/");

  const path = segments
    .map((segment, i) => {
      if (!segment.startsWith(":")) return segment;
      const param = segment.slice(1);
      const candidates =
        param === "id" ? [singularId(segments[i - 1]), "id"] : [param];
      for (const key of candidates) {
        if (key && rest[key] !== undefined && rest[key] !== null) {
          const value = String(rest[key]);
          delete rest[key];
          return encodeURIComponent(value);
        }
      }
      throw new Error(
        `${command || template} needs ${candidates
          .filter(Boolean)
          .join(" or ")} to build ${template}`,
      );
    })
    .join("/");

  return { path, rest };
}

/** `chats` → `chatId`, `plans` → `planId`, `memories` → `memoryId`,
 *  `staged-edits` → `stagedEditId`. */
export function singularId(collection: string | undefined): string | null {
  if (!collection || collection.startsWith(":")) return null;
  const word = collection.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  const singular = word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : word.endsWith("s")
      ? word.slice(0, -1)
      : word;
  return `${singular}Id`;
}

/**
 * The handful of commands whose argument names are not the route's parameter
 * names. Each one is a rename or an added flag, and each says why.
 */
export const ARGUMENT_OVERRIDES: Record<
  string,
  (args: Record<string, unknown>) => Record<string, unknown>
> = {
  // The route's parameter is `q`, because it is a URL somebody types.
  search_messages: ({ query, ...rest }) => ({ q: query, ...rest }),
  // Revoke and forget share `DELETE /api/devices/:id`; the flag is what picks
  // the stronger one, and it is not an argument the command takes.
  forget_paired_device: (rest) => ({ ...rest, forget: "true" }),
};

/** Everything the caller passed that the path did not consume, after any
 *  rename. */
export function leftoverArgs(
  command: string,
  rest: Record<string, unknown>,
): Record<string, unknown> {
  const override = ARGUMENT_OVERRIDES[command];
  return override ? override(rest) : rest;
}

export function appendQuery(url: URL, args: Record<string, unknown>) {
  for (const [key, value] of Object.entries(args)) {
    // A null argument means "unset", which is what leaving the parameter out
    // says. Sending `limit=null` would be a string the server has to reject.
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
}

/** `192.168.1.5`, `192.168.1.5:8765` and `http://192.168.1.5:8765/` all mean
 *  the same thing to a person typing an address, so they mean it here too. */
export function normalizeBaseUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("enter the desktop's address");
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const url = new URL(s);
  if (!url.port) url.port = "8765";
  return `${url.protocol}//${url.host}`;
}

/**
 * Parse a `multizone://pair?host=…&port=…&code=…` link (or QR payload).
 *
 * The code is optional as of 0.17.4: while the desktop is armed and waiting,
 * no code exists yet, and the link is still worth scanning because it carries
 * the address — which is the part people actually get wrong. A link with no
 * `host` is not one of ours and comes back null, because a QR scanner points at
 * whatever is in front of it.
 */
export function parsePairingLink(
  link: string,
): { baseUrl: string; code: string | null } | null {
  try {
    const url = new URL(link.trim());
    if (url.protocol !== "multizone:") return null;
    const host = url.searchParams.get("host");
    if (!host) return null;
    const port = url.searchParams.get("port") || "8765";
    return { baseUrl: normalizeBaseUrl(`${host}:${port}`), code: url.searchParams.get("code") };
  } catch {
    return null;
  }
}

/**
 * Turn a failed response into the message a Tauri command would have thrown, so
 * every `catch (e) { e.message }` in the app keeps working unchanged.
 */
export function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  if (typeof body === "string" && body.trim()) return body;
  if (status === 401) return "This device is no longer paired with the desktop.";
  return `The desktop answered ${status}.`;
}

/** Build the request one command becomes. Exported whole so a test can assert
 *  the URL and body a call produces without a server to send it to. */
export function buildRequest(
  binding: RouteBinding,
  command: string,
  args: Record<string, unknown>,
  baseUrl: string,
): { method: string; url: string; body?: string } {
  const { path, rest } = fillPath(binding.path, args, command);
  const leftovers = leftoverArgs(command, rest);
  const method = binding.method.toUpperCase();
  const url = new URL(baseUrl + path);

  if (method === "GET") {
    appendQuery(url, leftovers);
    return { method, url: url.toString() };
  }
  if (method === "DELETE") {
    // Both, on purpose. Some DELETE handlers read a query flag and some read a
    // JSON body, and which is which is a detail of a Rust signature this file
    // has no business tracking. Populating both costs a few bytes on a LAN and
    // removes a table that would need updating from the other side of the app.
    appendQuery(url, leftovers);
    return { method, url: url.toString(), body: JSON.stringify(leftovers) };
  }
  return { method, url: url.toString(), body: JSON.stringify(leftovers) };
}
