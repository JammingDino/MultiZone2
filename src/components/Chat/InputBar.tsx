import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Paperclip, Send, X, FileText, Image as ImageIcon, FileType, Loader2, Square } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import type { InputPart } from "@/lib/types";
import { renderPdfToJpegs, extractPdfText } from "@/lib/pdf";

interface PendingAttachment {
  id: string;
  fileName: string;
  fileType: "image" | "pdf" | "text" | "other";
  /** For image: single data URL. For PDF: array of page data URLs. For text: content string. */
  payload: string | string[];
  progress?: { page: number; total: number };
}

export interface InputBarHandle {
  addFiles: (files: FileList | File[]) => Promise<void>;
}

interface InputBarProps {
  chatId: string;
  disabled?: boolean;
  ref?: Ref<InputBarHandle>;
}

export function InputBar({ chatId, disabled, ref }: InputBarProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const refreshChats = useApp((s) => s.refreshChats);
  const sendKey = useApp((s) => s.appSettings.sendKey);
  const pdfMode = useApp((s) => s.appSettings.pdfMode);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useApp((s) => Boolean(s.streamingByChat[chatId]));

  useImperativeHandle(ref, () => ({ addFiles: (files) => handleFiles(files) }), [chatId]);

  // Grow the textarea with its content up to the CSS max-height, after which
  // the `overflow-y-auto` class takes over and a scrollbar appears.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    for (const file of list) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const id = crypto.randomUUID();

      if (ext === "pdf") {
        const stub: PendingAttachment = {
          id,
          fileName: file.name,
          fileType: "pdf",
          payload: pdfMode === "text" ? "" : [],
          progress: { page: 0, total: 0 },
        };
        setPending((p) => [...p, stub]);
        try {
          if (pdfMode === "text") {
            const text = await extractPdfText(file, (pr) => {
              setPending((p) => p.map((a) => (a.id === id ? { ...a, progress: pr } : a)));
            });
            setPending((p) =>
              p.map((a) => (a.id === id ? { ...a, payload: text, progress: undefined } : a)),
            );
          } else {
            const pages = await renderPdfToJpegs(file, (pr) => {
              setPending((p) =>
                p.map((a) => (a.id === id ? { ...a, progress: pr } : a)),
              );
            });
            setPending((p) =>
              p.map((a) => (a.id === id ? { ...a, payload: pages, progress: undefined } : a)),
            );
          }
        } catch (e) {
          console.error(e);
          setPending((p) => p.filter((a) => a.id !== id));
        }
      } else if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
        const dataUrl = await readFileAsDataUrl(file);
        setPending((p) => [
          ...p,
          { id, fileName: file.name, fileType: "image", payload: dataUrl },
        ]);
      } else if (["txt", "md", "csv", "json", "rs", "ts", "js", "py", "log"].includes(ext)) {
        const content = await file.text();
        setPending((p) => [
          ...p,
          { id, fileName: file.name, fileType: "text", payload: content },
        ]);
      } else {
        setPending((p) => [
          ...p,
          { id, fileName: file.name, fileType: "other", payload: "" },
        ]);
      }
    }
  }

  function removePending(id: string) {
    setPending((p) => p.filter((a) => a.id !== id));
  }

  async function onSend() {
    if (sending || disabled) return;
    const hasText = text.trim().length > 0;
    if (!hasText && pending.length === 0) return;

    setSending(true);
    const savedText = text;
    const savedPending = pending;

    try {
      const parts: InputPart[] = [];
      const textParts: string[] = [];
      if (hasText) textParts.push(text.trim());

      for (const att of pending) {
        if (att.fileType === "image") {
          parts.push({ type: "image", data_url: att.payload as string });
        } else if (att.fileType === "pdf") {
          if (typeof att.payload === "string") {
            textParts.push(`File: ${att.fileName} (PDF, extracted text)\n\`\`\`\n${att.payload}\n\`\`\``);
          } else {
            const pages = att.payload as string[];
            textParts.push(`[Attached PDF: ${att.fileName} — ${pages.length} pages follow as images]`);
            for (const dataUrl of pages) {
              parts.push({ type: "image", data_url: dataUrl });
            }
            api.savePdfAttachment(chatId, att.fileName, pages).catch(console.error);
          }
        } else if (att.fileType === "text") {
          textParts.push(`File: ${att.fileName}\n\`\`\`\n${att.payload as string}\n\`\`\``);
        }
      }

      const joined = textParts.join("\n\n");
      if (joined) {
        parts.unshift({ type: "text", text: joined });
      }

      setText("");
      setPending([]);
      setSending(false);

      await api.sendMessage(chatId, parts);
      refreshChats();
    } catch (e) {
      console.error("send failed:", e);
      // Restore input so the user doesn't lose their message
      setText(savedText);
      setPending(savedPending);
      setSending(false);
    }
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter((it) => it.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const dataUrl = await readFileAsDataUrl(file);
      const fileName = file.name && file.name !== "image.png" ? file.name : `pasted-${Date.now()}.png`;
      setPending((p) => [
        ...p,
        { id: crypto.randomUUID(), fileName, fileType: "image", payload: dataUrl },
      ]);
    }
  }

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 sm:px-4 sm:py-3">
      <div className="mx-auto w-full max-w-3xl">
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pending.map((att) => (
              <AttachmentChip
                key={att.id}
                attachment={att}
                onRemove={() => removePending(att.id)}
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 focus-within:border-[var(--color-accent)]">
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            title="Attach file"
          >
            <Paperclip size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              const trigger = sendKey === "ctrl_enter"
                ? e.key === "Enter" && (e.ctrlKey || e.metaKey)
                : e.key === "Enter" && !e.shiftKey;
              if (trigger) { e.preventDefault(); onSend(); }
            }}
            ref={taRef}
            rows={1}
            placeholder={
              disabled ? "Configure a zone for this chat first" : "Send a message…"
            }
            className="max-h-40 min-h-[24px] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm outline-none"
            disabled={disabled}
          />
          {isStreaming ? (
            <button
              onClick={() => api.cancelStream(chatId).catch(console.error)}
              className="flex items-center gap-1 rounded bg-[var(--color-panel-hover)] p-1.5 text-[var(--color-text)] hover:bg-[var(--color-border)]"
              title="Stop generating"
            >
              <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
              <Square size={12} />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={disabled || sending || (text.trim() === "" && pending.length === 0)}
              className="rounded bg-[var(--color-accent)] p-1.5 text-white hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              title="Send"
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  const icon =
    attachment.fileType === "image" ? (
      <ImageIcon size={12} />
    ) : attachment.fileType === "pdf" ? (
      <FileType size={12} />
    ) : (
      <FileText size={12} />
    );
  return (
    <div className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs">
      {icon}
      <span className="max-w-[160px] truncate">{attachment.fileName}</span>
      {attachment.progress && (
        <span className="text-[var(--color-text-muted)]">
          {attachment.progress.page}/{attachment.progress.total || "…"}
        </span>
      )}
      <button onClick={onRemove} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
        <X size={12} />
      </button>
    </div>
  );
}

// Maximum long-edge pixel size for stored images. Anything larger is
// resized down before storage so that large screenshots/photos don't
// inflate the base64 payload sent to the model on every turn.
const MAX_IMAGE_PX = 1280;

async function readFileAsDataUrl(file: File): Promise<string> {
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

