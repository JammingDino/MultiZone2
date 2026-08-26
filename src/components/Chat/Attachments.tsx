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

import { useRef, useState } from "react";
import { AudioLines, FileText, Image as ImageIcon, FileType, Loader2, X, ZoomIn } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { renderPdfToJpegs, extractPdfText } from "@/lib/pdf";
import {
  attachmentKind,
  AudioRejectedError,
  checkAudioLimits,
  formatDuration,
  formatTranscript,
  readFileAsBase64,
  readTextAttachment,
  UnreadableFileError,
  type PendingAttachment,
} from "@/lib/attachFiles";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { CHROME_QUIET, PRIMARY_ACTION } from "@/lib/chrome";

/**
 * Staged attachments for one composer.
 *
 * `pdfAsText` forces a PDF to be attached as extracted text even when the
 * global preference is page images — the input bar passes it when the chosen
 * model can't see images, since extracting the text directly beats OCR'ing a
 * picture of it.
 *
 * `onTranscript` receives a finished audio transcript in "quick" mode, so the
 * composer can put it straight into the message box (0.12.0). The tray does the
 * transcribing but has no idea where a composer's text lives, and a composer that
 * doesn't pass the callback simply keeps the transcript as an attachment — which
 * is exactly the "context" injection mode.
 */
export function useAttachments({
  pdfAsText = false,
  onTranscript,
}: { pdfAsText?: boolean; onTranscript?: (text: string) => void } = {}) {
  const pdfMode = useApp((s) => s.appSettings.pdfMode);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  /** Why the last attempted attachment didn't stage. Shown until the next try —
   *  a file that silently fails to attach is the bug this replaced. */
  const [attachError, setAttachError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewAtt = pending.find((a) => a.id === previewId) ?? null;

  const asText = pdfMode === "text" || pdfAsText;

  const sttProviderId = useApp((s) => s.appSettings.sttProviderId);
  const sttModel = useApp((s) => s.appSettings.sttModel);
  const uploadMode = useApp((s) => s.appSettings.sttUploadMode);
  const injection = useApp((s) => s.appSettings.sttUploadInjection);
  const withMetadata = useApp((s) => s.appSettings.sttUploadMetadata);
  const maxMb = useApp((s) => s.appSettings.sttUploadMaxMb);
  const maxMinutes = useApp((s) => s.appSettings.sttUploadMaxMinutes);
  /** Per-composer override of the global quick/review default, toggled on the
   *  composer itself — the decision is about *this* recording, so it has to be
   *  reachable without a trip to Settings. Null = follow the setting. */
  const [reviewOverride, setReviewOverride] = useState<boolean | null>(null);
  const review = reviewOverride ?? uploadMode === "review";
  /** The bytes behind each staged audio chip, kept so a failed transcription can
   *  be retried without asking the user to find the file again. Dropped when the
   *  chip is (they are only a retry buffer, not a second copy of the message). */
  const audioFilesRef = useRef<Map<string, File>>(new Map());
  const [sawAudio, setSawAudio] = useState(false);

  /**
   * Transcribe one staged audio file and settle its chip.
   *
   * Split out of `addFiles` because it is also the retry path: a transcription
   * that failed because no provider was configured should be re-runnable once one
   * is, without making the user find and re-drop the file — so the bytes are
   * passed in and held by the closure until it succeeds.
   */
  async function runTranscription(id: string, file: File, quick: boolean) {
    try {
      const b64 = await readFileAsBase64(file);
      const result = await api.transcribeAudioUpload(file.name, b64, withMetadata, null);
      const text = formatTranscript(result, withMetadata);
      // Quick mode hands the words straight to the composer and retires the chip:
      // the transcript *became* the message, so leaving a chip behind would send
      // the same words twice.
      if (quick && injection === "message" && onTranscript && text.trim()) {
        setPending((p) => p.filter((a) => a.id !== id));
        onTranscript(text);
        return;
      }
      setPending((p) =>
        p.map((a) =>
          a.id === id
            ? { ...a, payload: text, audio: { ...a.audio, status: "ready", language: result.language ?? undefined } }
            : a,
        ),
      );
    } catch (e) {
      const message = String(e);
      setAttachError(`Couldn't transcribe ${file.name}: ${message}`);
      setPending((p) =>
        p.map((a) => (a.id === id ? { ...a, audio: { ...a.audio, status: "failed", error: message } } : a)),
      );
    }
  }

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
      } else if (kind === "audio") {
        // Answer the one failure the user can't diagnose from a provider error
        // before spending an upload on it.
        if (!sttProviderId || !sttModel) {
          setAttachError(
            `${file.name} is audio, but no transcription provider is configured — set one up in Settings → Voice.`,
          );
          continue;
        }
        try {
          const { durationSecs } = await checkAudioLimits(file, { maxMb, maxMinutes });
          audioFilesRef.current.set(id, file);
          setSawAudio(true);
          setPending((p) => [
            ...p,
            {
              id,
              fileName: file.name,
              fileType: "audio",
              payload: "",
              audio: { status: "transcribing", durationSecs: durationSecs ?? undefined },
            },
          ]);
          // Deliberately not awaited: several dropped recordings transcribe in
          // parallel instead of queueing behind the longest one.
          void runTranscription(id, file, !review);
        } catch (e) {
          if (e instanceof AudioRejectedError) setAttachError(e.message);
          else { console.error(e); setAttachError(`Couldn't read ${file.name}.`); }
        }
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
    remove: (id: string) => {
      audioFilesRef.current.delete(id);
      setPending((p) => p.filter((a) => a.id !== id));
    },
    clear: () => {
      audioFilesRef.current.clear();
      setSawAudio(false);
      setPending([]);
    },
    attachError,
    setAttachError,
    dismissAttachError: () => setAttachError(null),
    previewAtt,
    openPreview: (id: string) => setPreviewId(id),
    closePreview: () => setPreviewId(null),
    // ── Audio (0.12.0) ──
    /** Whether finished transcripts wait for review instead of going straight in. */
    review,
    setReview: (v: boolean) => setReviewOverride(v),
    /** Whether this tray can put a transcript into a composer's text at all.
     *  False in the edit composer, which has no "send this instead" gesture — so
     *  the "Use as message" button isn't offered where it would do nothing. */
    canInject: Boolean(onTranscript),
    /** Whether the review toggle is worth showing. Sticky rather than
     *  `pending.some(isAudio)`: in quick mode the chip retires the instant the
     *  transcript lands, so a live check would flash the toggle for a second and
     *  then hide it — leaving the user no moment in which to say "actually, let
     *  me read this one first". It clears with the tray. */
    hasAudio: sawAudio,
    /** A transcription still in flight. Composers disable send on this: an audio
     *  chip contributes no content until its transcript exists, so sending early
     *  would quietly drop the recording (or send an empty message). */
    transcribing: pending.some((a) => a.audio?.status === "transcribing"),
    /** Correct a transcript by hand. Marks it edited so nothing overwrites it. */
    editTranscript: (id: string, text: string) =>
      setPending((p) =>
        p.map((a) => (a.id === id ? { ...a, payload: text, audio: { ...a.audio, status: "ready", edited: true } } : a)),
      ),
    /** Re-run a transcription that failed — after configuring a provider, say.
     *  The file's bytes were kept for exactly this. */
    retryTranscription: (id: string) => {
      const file = audioFilesRef.current.get(id);
      if (!file) return;
      setPending((p) =>
        p.map((a) => (a.id === id ? { ...a, audio: { ...a.audio, status: "transcribing", error: undefined } } : a)),
      );
      setAttachError(null);
      // Always keeps the chip: a retry is already a moment of attention, so
      // dropping the words straight into the composer would be a surprise.
      void runTranscription(id, file, false);
    },
    /** Move a reviewed transcript into the composer, retiring its chip. */
    useTranscript: (id: string) => {
      const att = pending.find((a) => a.id === id);
      const text = typeof att?.payload === "string" ? att.payload.trim() : "";
      if (!text || !onTranscript) return;
      audioFilesRef.current.delete(id);
      setPending((p) => p.filter((a) => a.id !== id));
      setPreviewId((cur) => (cur === id ? null : cur));
      onTranscript(text);
    },
  };
}

export type AttachmentTray = ReturnType<typeof useAttachments>;

/**
 * Put a finished transcript into a composer's text.
 *
 * Appended after a blank line rather than spliced at the caret (which is what
 * dictation does): an upload's transcript can be an hour of speech, and the caret
 * is wherever the user last happened to click, so inserting there would cut a
 * typed sentence in half. Every composer shares this so "use it" means the same
 * thing in all of them.
 */
export function appendTranscript(setText: (fn: (prev: string) => string) => void, transcript: string) {
  setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${transcript}` : transcript));
}

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
              // A transcription still running has nothing to open yet; a failed
              // one opens to its error and a retry button.
              onPreview={
                att.progress || att.audio?.status === "transcribing"
                  ? undefined
                  : () => tray.openPreview(att.id)
              }
            />
          ))}
        </div>
      )}
      {tray.previewAtt && (
        <AttachmentPreview
          attachment={tray.previewAtt}
          onClose={tray.closePreview}
          onEdit={(text) => tray.editTranscript(tray.previewAtt!.id, text)}
          onUse={tray.canInject ? () => tray.useTranscript(tray.previewAtt!.id) : undefined}
          onRetry={() => tray.retryTranscription(tray.previewAtt!.id)}
        />
      )}
    </>
  );
}

/**
 * The quick / review switch for audio uploads (0.12.0), shown above a composer
 * only once a recording has actually been staged.
 *
 * It is a per-composer override of the Settings → Voice default rather than a
 * second setting: which mode a given recording deserves is a property of that
 * recording — a voice note wants the words in the box, a client call wants
 * reading first — and answering that shouldn't mean leaving the conversation.
 */
export function AudioModeRow({ tray }: { tray: AttachmentTray }) {
  if (!tray.hasAudio) return null;
  return (
    <div className="mb-2 flex w-fit items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] py-1 pl-3 pr-1 text-xs text-[var(--color-text-muted)]">
      <AudioLines size={11} className="shrink-0" />
      <span className="shrink-0">Transcript:</span>
      <AudioModeChip
        label="use it"
        active={!tray.review}
        title="Put the transcript straight into the message box as soon as it's ready."
        onClick={() => tray.setReview(false)}
      />
      <AudioModeChip
        label="review first"
        active={tray.review}
        title="Keep the transcript on its chip so you can read and correct it before sending."
        onClick={() => tray.setReview(true)}
      />
    </div>
  );
}

function AudioModeChip({
  label, active, title, onClick,
}: { label: string; active: boolean; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 transition ${
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
          : "border-transparent hover:border-[var(--color-border)] hover:text-[var(--color-text)]"
      }`}
    >
      {label}
    </button>
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
  const audio = attachment.audio;
  const icon =
    attachment.fileType === "image" ? (
      <ImageIcon size={12} />
    ) : attachment.fileType === "pdf" ? (
      <FileType size={12} />
    ) : attachment.fileType === "audio" ? (
      audio?.status === "transcribing" ? <Loader2 size={12} className="animate-spin" /> : <AudioLines size={12} />
    ) : (
      <FileText size={12} />
    );

  const canPreview = Boolean(onPreview);
  const failed = audio?.status === "failed";

  return (
    <div
      className={`group flex items-center gap-1.5 rounded border bg-[var(--color-panel)] px-2 py-1 text-xs ${
        failed ? "border-red-500/50" : "border-[var(--color-border)]"
      } ${canPreview ? "cursor-pointer hover:border-[var(--color-accent)]" : ""}`}
      onClick={onPreview}
      title={
        failed
          ? `Transcription failed: ${audio?.error ?? "unknown error"}`
          : audio?.status === "transcribing"
            ? "Transcribing…"
            : canPreview
              ? "Click to preview"
              : undefined
      }
    >
      {icon}
      <span className="max-w-[160px] truncate">{attachment.fileName}</span>
      {audio && (
        <span className={`shrink-0 ${failed ? "text-red-500" : "text-[var(--color-text-muted)]"}`}>
          {failed
            ? "failed"
            : audio.status === "transcribing"
              ? "transcribing…"
              : audio.durationSecs != null
                ? formatDuration(audio.durationSecs)
                : "transcript"}
        </span>
      )}
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
  onEdit,
  onUse,
  onRetry,
}: {
  attachment: PendingAttachment;
  onClose: () => void;
  /** Audio only: correct the transcript in place. */
  onEdit?: (text: string) => void;
  /** Audio only: move the transcript into the composer as the message. */
  onUse?: () => void;
  /** Audio only: re-run a failed transcription. */
  onRetry?: () => void;
}) {
  useDismissOnEscape(true, onClose);

  let body: React.ReactNode;

  if (attachment.fileType === "audio") {
    // The review surface (0.12.0). A transcript is the one attachment kind whose
    // contents are a *guess* — the model's, about what was said — so this preview
    // is editable where every other one is read-only. Correcting a mangled name
    // here is the whole point of review mode; anywhere else the user would have
    // to inject it first and fix it in the message box.
    const failed = attachment.audio?.status === "failed";
    body = failed ? (
      <div className="flex max-w-[70vw] flex-col gap-3">
        <p className="text-xs text-red-500">{attachment.audio?.error ?? "Transcription failed."}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className={`w-fit rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
          >
            Try again
          </button>
        )}
      </div>
    ) : (
      <div className="flex w-[70vw] max-w-[720px] flex-col gap-3">
        <textarea
          value={(attachment.payload as string) ?? ""}
          onChange={(e) => onEdit?.(e.target.value)}
          readOnly={!onEdit}
          spellCheck
          className="h-[50vh] w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs leading-relaxed outline-none focus:border-[var(--color-accent)]"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--color-text-muted)]">
            {attachment.audio?.language ? `Detected language: ${attachment.audio.language}. ` : ""}
            Edits are kept — the model gets exactly what's here.
          </span>
          {onUse && (
            <button
              onClick={onUse}
              title="Move this transcript into the message box and remove the attachment"
              className={`shrink-0 rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
            >
              Use as message
            </button>
          )}
        </div>
      </div>
    );
  } else if (attachment.fileType === "image") {
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
      className="mz-safe-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
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
            className={`rounded p-1 ${CHROME_QUIET}`}
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
