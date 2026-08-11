import type { ContentPart } from "@/lib/types";
import type { PendingAttachment } from "@/lib/attachFiles";

/**
 * What a user turn had attached to it, recovered from its content parts.
 *
 * Attachments are sent as *hidden* parts — the model gets the whole file, the
 * chat shows a chip — so the markers the input bar writes are the only record of
 * what was attached. That makes this parser the single place that knows the
 * marker shapes: the chat chips, the citation sources and the chat exports all
 * read them, and a marker changed in one place and not another loses the
 * attachment silently.
 */
export type FileAttachment =
  | { fileName: string; mode: "images"; pages: string[] }
  | { fileName: string; mode: "text"; text: string }
  | { fileName: string; mode: "file"; text: string }
  | { fileName: string; mode: "audio"; text: string };

/** Marker for a PDF whose pages follow as hidden images. */
export function pdfImagesMarker(fileName: string, pageCount: number): string {
  return `[Attached PDF: ${fileName} — ${pageCount} pages follow as images]`;
}

/** Marker carrying a PDF's extracted text. */
export function pdfTextMarker(fileName: string, text: string): string {
  return `File: ${fileName} (PDF, extracted text)\n\`\`\`\n${text}\n\`\`\``;
}

/** Marker carrying a plain text / markdown / source file's contents (0.9.4). */
export function fileTextMarker(fileName: string, text: string): string {
  return `File: ${fileName}\n\`\`\`\n${text}\n\`\`\``;
}

/**
 * Marker carrying an uploaded recording's transcript (0.12.0).
 *
 * Distinct from `fileTextMarker` so the model is told what it is reading: a
 * transcript is speech, with the disfluencies and mishearings that implies, and a
 * model that knows it is looking at one treats "there" for "their" as the
 * transcription error it probably is. It also lets the chip say "transcript"
 * rather than presenting an `.m4a` as a text file.
 *
 * Any metadata header lives *inside* `text`, put there once by
 * `formatTranscript` — so what the user reviewed and what the model receives are
 * the same string.
 */
export function audioTranscriptMarker(fileName: string, text: string): string {
  return `Transcript: ${fileName} (audio)\n\`\`\`\n${text}\n\`\`\``;
}

export function parseFileAttachments(parts: ContentPart[]): FileAttachment[] {
  return splitAttachments(parts).attachments;
}

/**
 * The same parse, also reporting the hidden parts no marker claimed (0.11.3).
 *
 * Editing a user turn now rebuilds its parts from the attachments the user can
 * see and change, rather than carrying the old hidden parts through untouched —
 * that is the only way removing an attachment can mean anything. But a hidden
 * part this parser doesn't recognise is still something the turn carried, and
 * dropping it because we couldn't name it would lose context silently on every
 * edit. So the unclaimed ones come back too, to be passed through as they were.
 */
export function splitAttachments(parts: ContentPart[]): {
  attachments: FileAttachment[];
  unclaimedHidden: ContentPart[];
} {
  const attachments: FileAttachment[] = [];
  const unclaimedHidden: ContentPart[] = [];
  let current: { fileName: string; pages: string[] } | null = null;

  for (const p of parts) {
    if (p.type === "hidden_text") {
      if (current) { attachments.push({ ...current, mode: "images" }); current = null; }

      const imgMatch = p.text.match(/^\[Attached PDF: (.+) — \d+ pages follow as images\]$/);
      if (imgMatch) { current = { fileName: imgMatch[1], pages: [] }; continue; }

      const audioMatch = p.text.match(/^Transcript: (.+) \(audio\)\n```\n([\s\S]*?)\n```$/);
      if (audioMatch) { attachments.push({ fileName: audioMatch[1], mode: "audio", text: audioMatch[2] }); continue; }

      const txtMatch = p.text.match(/^File: (.+) \(PDF, extracted text\)\n```\n([\s\S]*?)\n```$/);
      if (txtMatch) { attachments.push({ fileName: txtMatch[1], mode: "text", text: txtMatch[2] }); continue; }

      // Plain text/markdown/source attachments (0.9.4).
      const fileMatch = p.text.match(/^File: (.+)\n```\n([\s\S]*?)\n```$/);
      if (fileMatch) attachments.push({ fileName: fileMatch[1], mode: "file", text: fileMatch[2] });
      else unclaimedHidden.push(p);
    } else if (p.type === "hidden_image") {
      if (current) current.pages.push(p.image_url.url);
      // A hidden image with no PDF marker in front of it belongs to nothing this
      // parser knows about — keep it rather than lose it.
      else unclaimedHidden.push(p);
    } else {
      if (current) { attachments.push({ ...current, mode: "images" }); current = null; }
    }
  }
  if (current) attachments.push({ ...current, mode: "images" });
  return { attachments, unclaimedHidden };
}

/** One recovered attachment, in the shape a composer stages files in. */
export function fileAttachmentToPending(f: FileAttachment): PendingAttachment {
  const id = crypto.randomUUID();
  switch (f.mode) {
    case "images": return { id, fileName: f.fileName, fileType: "pdf", payload: f.pages };
    case "text":   return { id, fileName: f.fileName, fileType: "pdf", payload: f.text };
    case "file":   return { id, fileName: f.fileName, fileType: "text", payload: f.text };
    // Re-staged as an already-finished transcript: the audio itself is long gone
    // (only the text was ever stored), so re-editing the turn edits the words,
    // and there is nothing left to re-transcribe.
    case "audio":  return { id, fileName: f.fileName, fileType: "audio", payload: f.text, audio: { status: "ready", edited: true } };
  }
}
