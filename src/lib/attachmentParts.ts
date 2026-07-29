import type { ContentPart } from "@/lib/types";

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
  | { fileName: string; mode: "file"; text: string };

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

export function parseFileAttachments(parts: ContentPart[]): FileAttachment[] {
  const result: FileAttachment[] = [];
  let current: { fileName: string; pages: string[] } | null = null;

  for (const p of parts) {
    if (p.type === "hidden_text") {
      if (current) { result.push({ ...current, mode: "images" }); current = null; }

      const imgMatch = p.text.match(/^\[Attached PDF: (.+) — \d+ pages follow as images\]$/);
      if (imgMatch) { current = { fileName: imgMatch[1], pages: [] }; continue; }

      const txtMatch = p.text.match(/^File: (.+) \(PDF, extracted text\)\n```\n([\s\S]*?)\n```$/);
      if (txtMatch) { result.push({ fileName: txtMatch[1], mode: "text", text: txtMatch[2] }); continue; }

      // Plain text/markdown/source attachments (0.9.4).
      const fileMatch = p.text.match(/^File: (.+)\n```\n([\s\S]*?)\n```$/);
      if (fileMatch) result.push({ fileName: fileMatch[1], mode: "file", text: fileMatch[2] });
    } else if (p.type === "hidden_image" && current) {
      current.pages.push(p.image_url.url);
    } else if (p.type !== "hidden_image") {
      if (current) { result.push({ ...current, mode: "images" }); current = null; }
    }
  }
  if (current) result.push({ ...current, mode: "images" });
  return result;
}
