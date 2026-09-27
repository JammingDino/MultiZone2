/**
 * Turn any thrown value into something a user can read.
 *
 * Errors reach the UI as whatever the backend's `AppError` printed — "io error:
 * The system cannot find the file specified. (os error 2)", "database error:
 * … UNIQUE constraint failed: providers.name" — or as a provider's raw JSON.
 * This is the one place that reads them. Known causes get a plain headline and
 * the thing to do about it; a message that is already plain English (plenty of
 * the backend's own are) passes through; anything else gets a generic headline.
 * The raw text is always kept, because it is what goes in a bug report.
 *
 * Pure and dependency-free so `scripts/errors.test.mjs` can import it directly.
 */

export type ErrorAction = "settings" | "retry" | null;

export interface FriendlyError {
  headline: string;
  hint: string;
  action: ErrorAction;
  /** The original text, for "Show details". */
  raw: string;
}

type Fallback = Omit<FriendlyError, "raw">;

const GENERIC: Fallback = {
  headline: "Something went wrong",
  hint: "If it keeps happening, the details are what to report.",
  action: null,
};

/** The text of any thrown value: an Error, a Tauri command's string, anything. */
export function rawError(e: unknown): string {
  let s: string;
  if (typeof e === "string") s = e;
  else if (e instanceof Error) s = e.message;
  else if (e && typeof e === "object" && "message" in e) s = String((e as { message: unknown }).message);
  else s = String(e);
  return s.replace(/^Error: /, "").trim();
}

/** `AppError`'s Display prefixes (src-tauri/src/error.rs). */
const PREFIX = /^(database error|migration error|http error|io error|json error|base64 error|image error|not found|invalid input|provider error): /i;

/** Marks of text written for a developer, not a user. */
const JARGON = /[{}[\]<>]|::|os error|\(code: |panicked|backtrace|0x[0-9a-f]{4,}|[0-9a-f]{8}-[0-9a-f]{4}-|\bstd(out|in|err)\b|json-rpc|\bsse\b/i;

const rule = (headline: string, hint: string, action: ErrorAction = null): Fallback => ({ headline, hint, action });

function classify(s: string, body: string): Fallback | null {
  // Credentials and quota — the provider errors people hit most.
  if (/\b401\b|unauthorized|invalid_api_key|invalid api key|incorrect api key/.test(s))
    return rule("The provider rejected your API key", "Check the key for this provider in Settings → Providers.", "settings");
  if (/\b429\b|rate limit|rate_limit|insufficient_quota|quota/.test(s))
    return rule("Rate limited or out of quota", "The provider is asking you to slow down, or the account is out of credit. Wait a moment and try again.", "retry");
  if (/context length|context_length|too many tokens|maximum context/.test(s))
    return rule("The conversation is too long for this model", "Start a new chat, or switch to a model with a larger context window.", "settings");
  if (/model_not_found|model .{0,80}(not found|does not exist)|\b404\b/.test(s))
    return rule("That model isn't available on this provider", "The model name may be wrong, or the provider may not serve it. Check it in Settings.", "settings");
  if (/\b403\b|forbidden/.test(s))
    return rule("The provider refused the request", "The key may lack access to this model, or the account may be restricted.", "settings");

  // Windows file-system errors, by OS error code.
  if (/os error (2|3)\)|cannot find the (file|path)|no such file/.test(s))
    return rule("The file or folder couldn't be found", "It may have been moved, renamed or deleted.");
  if (/os error 5\)|access is denied|permission denied/.test(s))
    return rule("Windows denied access", "The file may be read-only, open in another program, or in a folder MultiZone can't write to.");
  if (/os error (32|33)\)|being used by another process/.test(s))
    return rule("The file is open in another program", "Close it there and try again.", "retry");
  if (/os error 112\)|not enough space|no space left/.test(s))
    return rule("The disk is full", "Free up some space and try again.", "retry");
  if (/os error 123\)|syntax is incorrect/.test(s))
    return rule("That name isn't valid on Windows", "File names can't contain \\ / : * ? \" < > |.");

  // The local database.
  if (/unique constraint/.test(s))
    return rule("Something with that name already exists", "Pick a different name.");
  if (/foreign key constraint/.test(s))
    return rule("Something this depends on no longer exists", "It may have been deleted. Close and reopen the panel, then try again.");
  if (/database is locked|database is busy/.test(s))
    return rule("The database is busy", "Try again in a moment.", "retry");

  // Reaching a server.
  if (/connection refused|os error 10061|dns|timed out|timeout|unreachable|error sending request|tcp connect|network|failed to fetch/.test(s))
    return rule("Couldn't connect", "Check the address and your connection. If it's a local server like Ollama or LM Studio, make sure it's running.", "retry");
  if (/no provider|no default model|zone has no provider/.test(s))
    return rule("No model is configured", "Pick a provider and model in Settings.", "settings");
  if (/\b50[0-4]\b|overloaded|bad gateway|service unavailable/.test(s))
    return rule("The server had an error", "This is on their end. Trying again usually works.", "retry");

  if (/^json error|expected value at line|invalid type: |eof while parsing/.test(s))
    return rule("The data wasn't in the expected format", "The file or response may be damaged, or from an incompatible version.");

  // "not found: chat 3f2a…" — the thing is named, the id is noise.
  const missing = /^not found: ([a-z][a-z ]*?) \S{6,}$/i.exec(body);
  if (missing) return rule(`That ${missing[1].toLowerCase()} no longer exists`, "It may have been deleted.");

  return null;
}

/**
 * Read an error. `fallback` is used when nothing is recognised and the text
 * itself is not fit to show — callers with more context (a failed chat turn)
 * can say more than "something went wrong".
 */
export function friendlyError(e: unknown, fallback: Fallback = GENERIC): FriendlyError {
  const raw = rawError(e);
  const known = classify(raw.toLowerCase(), raw);
  if (known) return { ...known, raw };

  const plain = raw.replace(PREFIX, "").trim();
  if (plain && plain.length <= 240 && !JARGON.test(plain)) {
    return { headline: plain.charAt(0).toUpperCase() + plain.slice(1), hint: "", action: null, raw };
  }
  return { ...fallback, raw };
}

/** Just the words, as a sentence, for places that show one line or build one. */
export function errorText(e: unknown): string {
  const f = friendlyError(e);
  const end = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  return f.hint ? `${end(f.headline)} ${f.hint}` : end(f.headline);
}
