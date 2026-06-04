import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const TARGET_WIDTH = 1024;
const JPEG_QUALITY = 0.85;

export interface PdfRenderProgress {
  page: number;
  total: number;
}

/** Render every page of a PDF to base64-encoded JPEGs at ~1024px wide. */
export async function renderPdfToJpegs(
  file: File,
  onProgress?: (p: PdfRenderProgress) => void,
): Promise<string[]> {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const out: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1.0 });
    const scale = TARGET_WIDTH / base.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not create canvas context");

    await page.render({ canvasContext: ctx, viewport } as any).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    out.push(dataUrl);
    onProgress?.({ page: i, total: doc.numPages });
    page.cleanup();
  }
  await doc.destroy();
  return out;
}
