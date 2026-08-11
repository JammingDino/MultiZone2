/**
 * Deciding what a picked file *is*, reading it, and turning it into the parts a
 * turn carries.
 *
 * Both composers (the chat input bar and the home screen) stage attachments, and
 * both used to answer "what kind of file is this?" with their own copy of an
 * extension allowlist — nine text extensions long. Anything outside it became a
 * fourth kind, `"other"`, staged with an empty payload; and neither send path had
 * a branch for `"other"`, so it produced no content part at all. A `.tsx`,
 * `.yaml`, `.html`, `.sh`, `.sql` or an extensionless `Dockerfile` got a chip
 * that looked exactly like a working one, previewed as an empty box, and reached
 * the model as nothing whatsoever (0.9.14).
 *
 * The allowlist is gone. Images and PDFs are recognised because they need
 * decoding; *everything else is read as text*, which is what a file the user
 * deliberately attached almost always is. A file that turns out to be binary is
 * refused out loud rather than staged as an empty chip — the failure a user can
 * see and correct, instead of the one that looks like it worked.
 *
 * One module rather than two copies, because the duplication is what let the two
 * halves of this (classify here, build parts there) drift apart unnoticed.
 */

import type { Transcription } from "@/lib/tauri";
import type { InputPart } from "@/lib/types";
import {
  audioTranscriptMarker,
  fileTextMarker,
  pdfImagesMarker,
  pdfTextMarker,
} from "@/lib/attachmentParts";

/** Extensions decoded as images. SVG is deliberately absent: it is text, and a
 *  model reads its markup far better than a rasterised picture of it. */
const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

/**
 * Extensions transcribed rather than read (0.12.0).
 *
 * This is the set OpenAI's `/audio/transcriptions` documents as accepted, plus
 * `opus` and `aac`, which ordinary voice recorders emit and which the endpoint's
 * decoder handles in practice. Recognising an audio file at all is the whole
 * point: before this, a dropped `.m4a` fell through to the "everything else is
 * text" branch, decoded to binary, and was refused — the app had a transcription
 * provider configured and still could not accept a voice note.
 */
const AUDIO_EXTS = [
  "mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm", "flac", "ogg", "oga", "opus", "aac",
];

/** How a staged audio file's transcription is going. */
export interface AudioState {
  status: "transcribing" | "ready" | "failed";
  /** Why it failed, shown on the chip. */
  error?: string;
  /** Seconds, as measured locally before upload (the limit check needs it
   *  whether or not the endpoint reports a duration back). */
  durationSecs?: number;
  /** Language the endpoint detected, when it was asked for metadata. */
  language?: string;
  /** True once the user has edited the transcript by hand, which suppresses any
   *  later automatic overwrite of it. */
  edited?: boolean;
}

/** A file staged in a composer, waiting to be sent. */
export interface PendingAttachment {
  id: string;
  fileName: string;
  fileType: "image" | "pdf" | "text" | "audio";
  /** For image: a data URL. For PDF: page data URLs, or extracted text. For
   *  text: the file's contents. For audio: the transcript. */
  payload: string | string[];
  progress?: { page: number; total: number };
  /** Audio only: transcription state. Absent on every other kind. */
  audio?: AudioState;
}

/** Lowercased extension, or "" for a file that has none. */
export function fileExtension(file: File): string {
  const parts = file.name.split(".");
  return parts.length > 1 ? (parts.pop() as string).toLowerCase() : "";
}

/**
 * What to do with a picked file.
 *
 * Only two kinds have to be *recognised* — they need decoding before a model can
 * use them. Everything else is text, including the extensions nobody thought to
 * list. The MIME type is consulted alongside the extension because a dropped or
 * pasted file often arrives with a useful `type` and a useless name.
 */
export function attachmentKind(file: File): PendingAttachment["fileType"] {
  const ext = fileExtension(file);
  if (ext === "pdf" || file.type === "application/pdf") return "pdf";
  if (IMAGE_EXTS.includes(ext)) return "image";
  // `image/svg+xml` is excluded by the `svg` check, not by this prefix.
  if (ext !== "svg" && file.type.startsWith("image/")) return "image";
  if (AUDIO_EXTS.includes(ext) || file.type.startsWith("audio/")) return "audio";
  return "text";
}

/** A file that can't be sent as text and isn't an image or a PDF either. */
export class UnreadableFileError extends Error {
  constructor(public readonly fileName: string) {
    super(`${fileName} looks like a binary file, so there's no text to send.`);
    this.name = "UnreadableFileError";
  }
}

/** How much of a file to examine when deciding whether it is text. */
const SNIFF_CHARS = 4096;

/**
 * Does this decoded text look like it was never text to begin with?
 *
 * Two signals, both cheap. A NUL byte does not occur in real text files and does
 * in almost every binary format; and `File.text()` decodes as UTF-8, so bytes
 * that aren't valid UTF-8 come back as U+FFFD — a scattering is fine (a stray
 * Latin-1 byte in a log), a drift of them means we are reading a JPEG.
 */
function looksBinary(text: string): boolean {
  const head = text.slice(0, SNIFF_CHARS);
  if (head.length === 0) return false;
  if (head.includes("\u0000")) return true;
  let replacements = 0;
  for (const ch of head) if (ch === "\uFFFD") replacements += 1;
  return replacements / head.length > 0.1;
}

/**
 * Read a file's contents as text, refusing one that isn't.
 *
 * @throws {UnreadableFileError} when the file decodes to binary.
 */
export async function readTextAttachment(file: File): Promise<string> {
  const text = await file.text();
  if (looksBinary(text)) throw new UnreadableFileError(file.name);
  return text;
}

// ── Audio (0.12.0) ───────────────────────────────────────────────────────────

/** An audio file that can't be transcribed, with a reason the user can act on. */
export class AudioRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioRejectedError";
  }
}

/**
 * `hh:mm:ss`-ish, dropping the hour when there isn't one.
 *
 * Floors rather than rounds, because these are mostly *timestamps*: a segment
 * beginning at 2.5s labelled `0:03` points past its own first word, and someone
 * scrubbing a recording to a cited time would land after what they were looking
 * for. Flooring is also what media players do with elapsed time.
 */
export function formatDuration(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * How long an audio file is, decided locally by letting the browser's own
 * decoder load its metadata.
 *
 * Resolves to `null` rather than rejecting when the format can't be probed: a
 * container the WebView won't decode may still be one the transcription endpoint
 * accepts, so an unknown duration means "no duration limit could be applied
 * here", not "refuse the file". The size ceiling still holds either way.
 */
export function probeAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("audio");
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

/**
 * Check an audio file against the user's configured ceilings before it is read
 * into memory and uploaded.
 *
 * Both limits are the user's to set, with defaults that are generous rather than
 * cautious — 25 MB because that is OpenAI's own hard ceiling and a smaller number
 * would invent a restriction the endpoint doesn't have, and two hours because the
 * recordings this feature exists for (a meeting, a lecture) are long by nature.
 *
 * @throws {AudioRejectedError} when the file is over a limit.
 */
export async function checkAudioLimits(
  file: File,
  limits: { maxMb: number; maxMinutes: number },
): Promise<{ durationSecs: number | null }> {
  const maxBytes = Math.max(1, limits.maxMb) * 1024 * 1024;
  if (file.size > maxBytes) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new AudioRejectedError(
      `${file.name} is ${mb} MB, over the ${limits.maxMb} MB limit for audio uploads (Settings → Voice).`,
    );
  }
  const durationSecs = await probeAudioDuration(file);
  if (limits.maxMinutes > 0 && durationSecs != null && durationSecs > limits.maxMinutes * 60) {
    throw new AudioRejectedError(
      `${file.name} runs ${formatDuration(durationSecs)}, over the ${limits.maxMinutes}-minute limit for audio uploads (Settings → Voice).`,
    );
  }
  return { durationSecs };
}

/** A file's bytes as bare base64 (no `data:` prefix), for the upload command. */
export async function readFileAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked so a long recording doesn't blow the argument limit of `apply`.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The transcript text a staged audio file carries, which is *all* the user ever
 * sees or edits — the review editor edits this string, and the marker below wraps
 * it verbatim. Formatting the metadata in once, here, is what keeps those two
 * from disagreeing about what the transcript says.
 *
 * Without metadata it is just the words. With it, a duration/language header and
 * timestamped segments, which is what makes an hour of audio navigable rather
 * than a single paragraph — the model can cite a time, and so can the user.
 */
export function formatTranscript(t: Transcription, withMetadata: boolean): string {
  if (!withMetadata) return t.text;

  const header: string[] = [];
  if (t.durationSecs != null) header.push(`Duration: ${formatDuration(t.durationSecs)}`);
  if (t.language) header.push(`Language: ${t.language}`);

  if (t.segments.length === 0) {
    return header.length > 0 ? `${header.join(" · ")}\n\n${t.text}` : t.text;
  }

  const lines = t.segments.map((s) => {
    // Flagged rather than dropped: a low-confidence span is often the one worth
    // checking, and silently removing it would lose words the user said.
    const unsure = s.noSpeechProb != null && s.noSpeechProb > 0.5 ? " (unclear)" : "";
    return `[${formatDuration(s.start)}]${unsure} ${s.text.trim()}`;
  });
  return [...(header.length > 0 ? [header.join(" · "), ""] : []), ...lines].join("\n");
}

/**
 * The content parts one staged attachment contributes to a turn.
 *
 * Text and PDF text ride along as *hidden* parts: the model gets the whole file,
 * the chat shows a chip you can open. Inlining them into the visible turn buried
 * a one-line question under a wall of README.
 *
 * Every case returns something. An attachment that produced no parts is the bug
 * this module exists to make impossible, so the switch is exhaustive over
 * `fileType` and TypeScript fails the build if a kind is ever added without a
 * branch here.
 */
export function attachmentToParts(att: PendingAttachment): InputPart[] {
  switch (att.fileType) {
    case "text":
      return [{ type: "hidden_text", text: fileTextMarker(att.fileName, att.payload as string) }];
    case "audio": {
      // A transcript that never arrived (still running, or failed) contributes
      // nothing rather than an empty "Transcript:" block claiming the recording
      // was silent.
      const transcript = (att.payload as string).trim();
      if (!transcript) return [];
      return [{ type: "hidden_text", text: audioTranscriptMarker(att.fileName, transcript) }];
    }
    case "image":
      return [{ type: "image", data_url: att.payload as string }];
    case "pdf": {
      if (typeof att.payload === "string") {
        return [{ type: "hidden_text", text: pdfTextMarker(att.fileName, att.payload) }];
      }
      const pages = att.payload;
      return [
        { type: "hidden_text", text: pdfImagesMarker(att.fileName, pages.length) },
        ...pages.map((data_url): InputPart => ({ type: "hidden_image", data_url })),
      ];
    }
    default: {
      const never: never = att.fileType;
      throw new Error(`unhandled attachment kind: ${never}`);
    }
  }
}
