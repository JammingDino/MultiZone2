/**
 * Editing a message, in the composer you already know (0.11.3).
 *
 * Clicking Edit used to drop you into a bare `<textarea>` with two buttons under
 * it — a control that appears nowhere else in the app, and which quietly took
 * three things away at the moment you were most likely to want them:
 *
 * - **The attachments vanished.** They were still carried through the resend, as
 *   hidden parts, but nothing on screen said so; a turn with a PDF attached
 *   looked, while being edited, exactly like a turn without one. And there was
 *   no way to remove one, which is half of why anyone edits a question with a
 *   file in it.
 * - **Nothing suggested you could attach more.** You could not, in fact.
 * - **No microphone.** Dictation is a first-class way to put text into this app
 *   everywhere except the one place where you are correcting text — which is
 *   where speaking a replacement sentence is most useful.
 *
 * So the editor is the composer: same rounded shell, same paperclip, same mic,
 * same chips above it, with Save and Cancel where Send would be. Nothing here is
 * a new interaction to learn.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Paperclip, X } from "lucide-react";
import { useApp } from "@/store/app";
import type { PendingAttachment } from "@/lib/attachFiles";
import {
  AttachError,
  AttachmentRow,
  readFileAsDataUrl,
  useAttachments,
} from "@/components/Chat/Attachments";
import { useDictation, MicButton, DictationMeter } from "@/components/Chat/useDictation";

export function EditComposer({
  initialText,
  initialAttachments,
  onCancel,
  onSave,
  saveLabel = "Save",
  saveTitle,
  align = "start",
}: {
  initialText: string;
  /** Present only where attachments make sense — a user turn. Omitted for an
   *  assistant answer, which has none and cannot be given any. */
  initialAttachments?: PendingAttachment[];
  onCancel: () => void;
  /** `attachments` is the full final set: what survived, plus what was added. */
  onSave: (text: string, attachments: PendingAttachment[]) => Promise<void> | void;
  saveLabel?: string;
  saveTitle?: string;
  /** Which edge the chips and hint line hang off — user turns sit right. */
  align?: "start" | "end";
}) {
  const [draft, setDraft] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sendKey = useApp((s) => s.appSettings.sendKey);
  const attachable = initialAttachments !== undefined;

  const tray = useAttachments();
  const dictation = useDictation({ taRef, setText: setDraft });

  // Seed the tray with what the message already carries, once. Everything after
  // that is the user's editing — including removals, which is why this can't
  // just re-sync from the prop.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !initialAttachments?.length) return;
    seeded.current = true;
    tray.setPending(initialAttachments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow with the content, like the composer at the bottom of the chat.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Start with the caret at the end of the existing text rather than at its
  // start — you are almost always continuing or amending, not prefixing.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  async function commit() {
    if (saving) return;
    const next = draft.trim();
    if (!next && tray.pending.length === 0) return;
    setSaving(true);
    try {
      await onSave(next, tray.pending);
    } catch (e) {
      console.error(e);
      setSaving(false);
    }
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!attachable) return;
    const imageItems = Array.from(e.clipboardData?.items ?? []).filter((it) =>
      it.type.startsWith("image/"),
    );
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const dataUrl = await readFileAsDataUrl(file);
      const fileName =
        file.name && file.name !== "image.png" ? file.name : `pasted-${Date.now()}.png`;
      tray.setPending((p) => [
        ...p,
        { id: crypto.randomUUID(), fileName, fileType: "image", payload: dataUrl },
      ]);
    }
  }

  const edge = align === "end" ? "items-end" : "items-start";

  return (
    <div className={`flex w-full flex-col ${edge} gap-1`}>
      <div className="w-full">
        {attachable && (
          <>
            <AttachError tray={tray} />
            <AttachmentRow tray={tray} align={align} />
          </>
        )}
        <DictationMeter dictation={dictation} />
        {dictation.voiceError && (
          <div className="mb-2 flex w-fit items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs text-red-600 dark:text-red-400">
            <span>{dictation.voiceError}</span>
            <button
              onClick={dictation.dismissVoiceError}
              className="hover:text-[var(--color-text)]"
              title="Dismiss"
            >
              <X size={11} />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-panel)] px-3 py-2">
          {attachable && (
            <>
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
                  tray.addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
          <MicButton dictation={dictation} />
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter always saves. Plain Enter does too when that is
              // the user's send key, so editing commits the way sending does.
              const plainEnter = sendKey !== "ctrl_enter" && e.key === "Enter" && !e.shiftKey;
              if ((e.key === "Enter" && (e.ctrlKey || e.metaKey)) || plainEnter) {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                onCancel();
              }
            }}
            rows={1}
            className="max-h-60 min-h-[24px] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm outline-none"
          />
          <button
            onClick={onCancel}
            title="Cancel (Esc)"
            className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            <X size={16} />
          </button>
          <button
            onClick={commit}
            disabled={saving || (draft.trim() === "" && tray.pending.length === 0)}
            title={saveTitle ?? saveLabel}
            className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-2.5 py-1.5 text-xs text-white hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check size={14} />
            {saveLabel}
          </button>
        </div>
      </div>
      <span className="text-[11px] text-[var(--color-text-muted)]">
        {sendKey === "ctrl_enter" ? "Ctrl+Enter" : "Enter"} to save · Esc to cancel
      </span>
    </div>
  );
}
