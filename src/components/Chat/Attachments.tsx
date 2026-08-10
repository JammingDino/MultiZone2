/**
 * Staging attachments in a composer: the hook that reads picked files, the chip
 * that stands for one, and the modal that opens it (0.11.3).
 *
 * The reading loop — classify, render a PDF page by page or extract its text,
 * refuse a binary out loud — was written twice, once in the input bar and once
 * in the home screen, in copies that had already drifted (one honoured the OCR
 * fallback, the other didn't). Editing a message needed the same loop a third
 * time, which is the point at which a third copy stops being defensible.
 *
 * `@/lib/attachFiles` owns what a file *is* and which parts it becomes;
 * this owns the staging state around it.
 */

import { useState } from "react";
import { FileText, Image as ImageIcon, FileType, X, ZoomIn } from "lucide-react";
import { useApp } from "@/store/app";
import { renderPdfToJpegs, extractPdfText } from "@/lib/pdf";
import {
  attachmentKind,
  readTextAttachment,
  UnreadableFileError,
  type PendingAttachment,
} from "@/lib/attachFiles";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";

/**
 * Staged attachments for one composer.
 *
 * `pdfAsText` forces a PDF to be attached as extracted text even when the
 * global preference is page images — the input bar passes it when the chosen
 * model can't see images, since extracting the text directly beats OCR'ing a
 * picture of it.
 */
export function useAttachments({ pdfAsText = false }: { pdfAsText?: boolean } = {}) {
  const pdfMode = useApp((s) => s.appSettings.pdfMode);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  /** Why the last attempted attachment didn't stage. Shown until the next try —
   *  a file that silently fails to attach is the bug this replaced. */
  const [attachError, setAttachError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewAtt = pending.find((a) => a.id === previewId) ?? null;

  const asText = pdfMode === "text" || pdfAsText;

  async function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    setAttachError(null);
    for (const file of Array.from(files)) {
      const kind = attachmentKind(file);
      const id = crypto.randomUUID();

      if (kind === "pdf") {
        // Staged before it is read, so a long render shows a chip with a page
        // counter rather than nothing at all.
        setPending((p) => [
          ...p,
          { id, fileName: file.name, fileType: "pdf", payload: asText ? "" : [], progress: { page: 0, total: 0 } },
        ]);
        const onProgress = (progress: { page: number; total: number }) =>
          setPending((p) => p.map((a) => (a.id === id ? { ...a, progress } : a)));
        try {
          const payload = asText
            ? await extractPdfText(file, onProgress)
            : await renderPdfToJpegs(file, onProgress);
          setPending((p) => p.map((a) => (a.id === id ? { ...a, payload, progress: undefined } : a)));
        } catch (e) {
          console.error(e);
          setPending((p) => p.filter((a) => a.id !== id));
        }
      } else if (kind === "image") {
        const dataUrl = await readFileAsDataUrl(file);
        setPending((p) => [...p, { id, fileName: file.name, fileType: "image", payload: dataUrl }]);
      } else {
        // Anything that isn't an image or a PDF is read as text — no extension
        // allowlist; see `@/lib/attachFiles` for why.
        try {
          const content = await readTextAttachment(file);
          setPending((p) => [...p, { id, fileName: file.name, fileType: "text", payload: content }]);
        } catch (e) {
          if (e instanceof UnreadableFileError) setAttachError(e.message);
          else { console.error(e); setAttachError(`Couldn't read ${file.name}.`); }
        }
      }
    }
  }

  return {
    pending,
    setPending,
    addFiles,
    remove: (id: string) => setPending((p) => p.filter((a) => a.id !== id)),
    clear: () => setPending([]),
    attachError,
    setAttachError,
    dismissAttachError: () => setAttachError(null),
    previewAtt,
    openPreview: (id: string) => setPreviewId(id),
    closePreview: () => setPreviewId(null),
  };
}

export type AttachmentTray = ReturnType<typeof useAttachments>;

/** The "couldn't attach that" strip, shown above whichever composer tried. */
export function AttachError({ tray }: { tray: AttachmentTray }) {
  if (!tray.attachError) return null;
  return (
    <div className="mb-2 flex w-fit items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400">
      <FileText size={11} />
      <span>{tray.attachError}</span>
      <button onClick={tray.dismissAttachError} className="opacity-60 hover:opacity-100" title="Dismiss">
        <X size={11} />
      </button>
    </div>
  );
}

/** Every staged attachment as a row of chips, plus the preview it opens. */
export function AttachmentRow({ tray, align = "start" }: { tray: AttachmentTray; align?: "start" | "end" }) {
  if (tray.pending.length === 0 && !tray.previewAtt) return null;
  return (
    <>
      {tray.pending.length > 0 && (
        <div className={`mb-2 flex flex-wrap gap-2 ${align === "end" ? "justify-end" : ""}`}>
          {tray.pending.map((att) => (
            <AttachmentChip
              key={att.id}
              attachment={att}
              onRemove={() => tray.remove(att.id)}
              onPreview={att.progress ? undefined : () => tray.openPreview(att.id)}
            />
          ))}
        </div>
      )}
      {tray.previewAtt && (
        <AttachmentPreview attachment={tray.previewAtt} onClose={tray.closePreview} />
      )}
    </>
  );
}

export function AttachmentChip({
  attachment,
  onRemove,
  onPreview,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
  onPreview?: () => void;
}) {
  const icon =
    attachment.fileType === "image" ? (
      <ImageIcon size={12} />
    ) : attachment.fileType === "pdf" ? (
      <FileType size={12} />
    ) : (
      <FileText size={12} />
    );

  const canPreview = Boolean(onPreview);

  return (
    <div
      className={`group flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs ${canPreview ? "cursor-pointer hover:border-[var(--color-accent)]" : ""}`}
      onClick={onPreview}
      title={canPreview ? "Click to preview" : undefined}
    >
      {icon}
      <span className="max-w-[160px] truncate">{attachment.fileName}</span>
      {attachment.progress ? (
        <span className="text-[var(--color-text-muted)]">
          {attachment.progress.page}/{attachment.progress.total || "…"}
        </span>
      ) : canPreview ? (
        <ZoomIn size={11} className="shrink-0 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100" />
      ) : null}
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        title="Remove"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: PendingAttachment;
  onClose: () => void;
}) {
  useDismissOnEscape(true, onClose);

  let body: React.ReactNode;

  if (attachment.fileType === "image") {
    body = (
      <img
        src={attachment.payload as string}
        alt={attachment.fileName}
        className="max-h-[75vh] max-w-full rounded object-contain"
      />
    );
  } else if (attachment.fileType === "pdf" && Array.isArray(attachment.payload)) {
    // images mode — scrollable page gallery
    body = (
      <div className="flex max-h-[75vh] max-w-[80vw] flex-col gap-4 overflow-y-auto">
        {attachment.payload.map((src, i) => (
          <div key={i} className="flex flex-col items-center gap-1">
            <span className="text-xs text-[var(--color-text-muted)]">Page {i + 1}</span>
            <img
              src={src}
              alt={`Page ${i + 1}`}
              className="max-w-full rounded border border-[var(--color-border)]"
            />
          </div>
        ))}
      </div>
    );
  } else {
    // A text file, or a PDF attached as extracted text.
    body = (
      <pre className="max-h-[70vh] max-w-[75vw] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {(attachment.payload as string) || "(no text extracted)"}
      </pre>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-6">
          <span className="max-w-[400px] truncate text-sm font-medium">{attachment.fileName}</span>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            <X size={16} />
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}

// Maximum long-edge pixel size for stored images. Anything larger is resized
// down before storage so that large screenshots/photos don't inflate the base64
// payload sent to the model on every turn.
const MAX_IMAGE_PX = 1280;

export async function readFileAsDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      if (w <= MAX_IMAGE_PX && h <= MAX_IMAGE_PX) {
        resolve(raw);
        return;
      }
      const scale = MAX_IMAGE_PX / Math.max(w, h);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = raw;
  });
}
