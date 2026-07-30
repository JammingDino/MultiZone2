import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

/**
 * Long-edge pixel target for a rasterized page. 1568px is the largest edge the
 * vision models make use of — anything bigger is downscaled on their side, so
 * this is "as sharp as the page can usefully get". Normalizing the *long* edge
 * rather than the width also stops landscape pages and slides from being
 * rendered at roughly half the detail of a portrait page.
 */
const TARGET_LONG_EDGE = 1568;
/**
 * Handwritten annotations and small print are thin, high-contrast strokes —
 * exactly what JPEG ringing eats first — so pages are encoded well above the
 * usual photo quality.
 */
const JPEG_QUALITY = 0.95;

export interface PdfRenderProgress {
  page: number;
  total: number;
}

/**
 * Expand a page spec written by the model — "3", "1-4,9", "all" — into real,
 * in-range page numbers, deduped and ordered, capped at `max`.
 *
 * Selection is resolved here rather than in Rust because this is the side that
 * knows `numPages`: "all" and a range that runs off the end of the document need
 * the real length, and the backend would otherwise be guessing at it (see
 * `read_pdf` in tools/filesystem.rs).
 */
export function parsePageSpec(spec: string, total: number, max: number): number[] {
  const raw = spec.trim().toLowerCase();
  const wanted: number[] = [];

  if (!raw || raw === "all" || raw === "*") {
    for (let i = 1; i <= total; i++) wanted.push(i);
  } else {
    for (const chunk of raw.split(",")) {
      const part = chunk.trim();
      if (!part) continue;
      const range = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (range) {
        const from = Math.max(1, Number(range[1]));
        const to = Math.min(total, Number(range[2]));
        for (let i = from; i <= to; i++) wanted.push(i);
        continue;
      }
      // A trailing open range ("5-") reads as "from here to the end".
      const open = part.match(/^(\d+)\s*[-–]$/);
      if (open) {
        for (let i = Math.max(1, Number(open[1])); i <= total; i++) wanted.push(i);
        continue;
      }
      const single = Number(part);
      if (Number.isInteger(single) && single >= 1 && single <= total) wanted.push(single);
    }
  }

  return [...new Set(wanted)].sort((a, b) => a - b).slice(0, max);
}

/** Extract plain text from all pages of a PDF. Returns one block per page separated by headers. */
export async function extractPdfText(
  file: File,
  onProgress?: (p: PdfRenderProgress) => void,
): Promise<string> {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = (content.items as any[])
      .filter((item) => "str" in item)
      .map((item) => item.str as string)
      .join(" ")
      .replace(/ {2,}/g, " ")
      .trim();
    pages.push(text);
    onProgress?.({ page: i, total: doc.numPages });
    page.cleanup();
  }

  await doc.destroy();
  return pages
    .map((text, i) => `--- Page ${i + 1} ---\n${text}`)
    .join("\n\n");
}

/** Rasterize one already-loaded page to a base64 JPEG at ~1568px on its long edge. */
async function renderPage(page: pdfjsLib.PDFPageProxy): Promise<string> {
  const base = page.getViewport({ scale: 1.0 });
  const scale = TARGET_LONG_EDGE / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not create canvas context");

  await page.render({ canvasContext: ctx, viewport } as any).promise;
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** Plain text of one already-loaded page, whitespace-normalized. */
async function pageText(page: pdfjsLib.PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  return (content.items as any[])
    .filter((item) => "str" in item)
    .map((item) => item.str as string)
    .join(" ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Render every page of a PDF to base64-encoded JPEGs at ~1568px on the long edge. */
export async function renderPdfToJpegs(
  file: File,
  onProgress?: (p: PdfRenderProgress) => void,
): Promise<string[]> {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const out: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    out.push(await renderPage(page));
    onProgress?.({ page: i, total: doc.numPages });
    page.cleanup();
  }
  await doc.destroy();
  return out;
}

export interface PdfReadPage {
  page: number;
  /** Data URL, in image mode. */
  image?: string;
  /** Extracted page text, in text mode. */
  text?: string;
}

export interface PdfReadResult {
  /** Pages in the whole document, not just the ones returned. */
  pageCount: number;
  pages: PdfReadPage[];
  /** True when the selection was cut short by the per-call cap. */
  truncated: boolean;
}

/**
 * Read selected pages of a PDF on behalf of the backend's `read_file` tool
 * (1.0). The model names the pages it wants and gets images by default; the
 * document's real page count always comes back, so one cheap read tells it how
 * long the document is and what else there is to ask for.
 */
export async function readPdfPages(
  data: Uint8Array,
  spec: string,
  mode: "images" | "text",
  maxPages: number,
): Promise<PdfReadResult> {
  const doc = await pdfjsLib.getDocument({ data }).promise;
  try {
    const wanted = parsePageSpec(spec, doc.numPages, maxPages);
    const pages: PdfReadPage[] = [];
    for (const n of wanted) {
      const page = await doc.getPage(n);
      try {
        pages.push(
          mode === "text"
            ? { page: n, text: await pageText(page) }
            : { page: n, image: await renderPage(page) },
        );
      } finally {
        page.cleanup();
      }
    }
    // `parsePageSpec` clamps to the cap, so a full-length request of a longer
    // document is the truncation the model needs to be told about.
    const requested = parsePageSpec(spec, doc.numPages, Number.MAX_SAFE_INTEGER);
    return { pageCount: doc.numPages, pages, truncated: requested.length > wanted.length };
  } finally {
    await doc.destroy();
  }
}
