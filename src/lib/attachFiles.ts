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

import type { InputPart } from "@/lib/types";
import { fileTextMarker, pdfImagesMarker, pdfTextMarker } from "@/lib/attachmentParts";

/** Extensions decoded as images. SVG is deliberately absent: it is text, and a
 *  model reads its markup far better than a rasterised picture of it. */
const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

/** A file staged in a composer, waiting to be sent. */
export interface PendingAttachment {
  id: string;
  fileName: string;
  fileType: "image" | "pdf" | "text";
  /** For image: a data URL. For PDF: page data URLs, or extracted text. For
   *  text: the file's contents. */
  payload: string | string[];
  progress?: { page: number; total: number };
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
