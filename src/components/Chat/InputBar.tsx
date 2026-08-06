import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Paperclip, Send, X, FileText, Image as ImageIcon, FileType, Loader2, Square, ZoomIn, SlidersHorizontal, Zap, Brain, ScanText, AudioLines, Clock, CornerDownRight } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { useTts } from "@/store/tts";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { useDictation, MicButton, DictationMeter } from "@/components/Chat/useDictation";
import type { InputPart, PendingMode } from "@/lib/types";
import { renderPdfToJpegs, extractPdfText } from "@/lib/pdf";
import {
  attachmentKind,
  attachmentToParts,
  readTextAttachment,
  UnreadableFileError,
  type PendingAttachment,
} from "@/lib/attachFiles";
import { resolveVisionCapable } from "@/lib/vision";
import { resolveBaseModel, resolveBaseProvider } from "@/lib/baseZone";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";

/** Shared empty result for store selectors. A selector that builds its own `[]`
 *  hands `useSyncExternalStore` a new snapshot on every read, which re-renders
 *  forever — one stable reference is what makes "nothing queued" a no-op. */
const EMPTY: never[] = [];

/** Sentinel zone id meaning "Quick chat (no zone)" for a one-shot override. */
const SIMPLE_ZONE_ID = "__simple__";
/** Sentinel zone id meaning "Smart chat (router picks zone)" for a one-shot override. */
const SMART_ZONE_ID = "__smart__";
const OV_FIELD_CLS =
  "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]";

// Lives in `@/lib/attachFiles` now, with the classification and part-building
// that has to agree with it. Re-exported because the home screen composer shares
// this file's chip and preview components.
export type { PendingAttachment };

export interface InputBarHandle {
  addFiles: (files: FileList | File[]) => Promise<void>;
}

interface InputBarProps {
  chatId: string;
  disabled?: boolean;
  ref?: Ref<InputBarHandle>;
  /** Rendered above the composer, inside its column — for context notices that
   *  belong to the input rather than to the thread (e.g. the subchat banner). */
  notice?: React.ReactNode;
}

export function InputBar({ chatId, disabled, ref, notice }: InputBarProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** Why the last attempted attachment didn't stage. Shown until the next try —
   *  a file that silently fails to attach is the bug this replaced. */
  const [attachError, setAttachError] = useState<string | null>(null);
  const previewAtt = pending.find((a) => a.id === previewId) ?? null;
  const refreshChats = useApp((s) => s.refreshChats);
  const sendKey = useApp((s) => s.appSettings.sendKey);
  const pdfMode = useApp((s) => s.appSettings.pdfMode);
  const chats = useApp((s) => s.chats);
  const zones = useApp((s) => s.zones);
  const providers = useApp((s) => s.providers);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  const visionOverrides = useApp((s) => s.appSettings.visionOverrides);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Focus-the-composer shortcut (Ctrl/Cmd+K): the store bumps a nonce and the
  // mounted composer takes focus.
  const focusComposerNonce = useApp((s) => s.focusComposerNonce);
  useEffect(() => {
    if (focusComposerNonce > 0) taRef.current?.focus();
  }, [focusComposerNonce]);
  // Dictation (0.8.0): mic capture + transcribe-on-stop, shared with the
  // new-chat composer. Cancels a running recording when the chat switches.
  // In conversation mode (0.8.2) the committed transcript is auto-sent.
  const dictation = useDictation({
    taRef,
    setText,
    cancelKey: chatId,
    onCommit: (finalText) => {
      if (useApp.getState().conversationChatId === chatId && finalText.trim()) {
        onSend(finalText.trim());
      }
    },
  });
  // Hands-free conversation mode (0.8.2): drives the STT → send → TTS → STT loop.
  const conversationEnabled = useApp((s) => s.appSettings.voiceConversationEnabled);
  const ttsConfigured = useApp((s) => !!s.appSettings.ttsProviderId && !!s.appSettings.ttsModel);
  const conversationActive = useApp((s) => s.conversationChatId === chatId);
  const setConversationChatId = useApp((s) => s.setConversationChatId);
  const ttsStatus = useTts((s) => s.status);
  const prevTtsStatusRef = useRef(ttsStatus);
  // Busy while any participant is generating — the primary OR a perspective
  // zone — so the stop button stays available until the whole turn settles.
  // cancel_stream cancels every participant at once (shared cancel flag).
  const isStreaming = useApp(
    (s) =>
      Boolean(s.streamingByChat[chatId]) ||
      Object.keys(s.perspectiveStreamsByChat[chatId] ?? {}).length > 0,
  );

  // Conversation loop: once a spoken response finishes (TTS returns to idle
  // after playing) and nothing else is in flight, start listening again so the
  // user can reply hands-free.
  useEffect(() => {
    const prev = prevTtsStatusRef.current;
    prevTtsStatusRef.current = ttsStatus;
    if (!conversationActive) return;
    const wasSpeaking = prev === "playing" || prev === "paused" || prev === "loading";
    if (wasSpeaking && ttsStatus === "idle" && !isStreaming && !dictation.voiceRecording && !dictation.transcribing) {
      dictation.startListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationActive, ttsStatus, isStreaming]);

  // Leaving the chat (or unmount) ends its conversation loop.
  useEffect(() => {
    return () => {
      if (useApp.getState().conversationChatId === chatId) {
        useApp.getState().setConversationChatId(null);
        useTts.getState().stop();
      }
    };
  }, [chatId]);

  function toggleConversation() {
    if (conversationActive) {
      setConversationChatId(null);
      dictation.cancelListening();
      useTts.getState().stop();
    } else {
      setConversationChatId(chatId);
      dictation.startListening();
    }
  }

  // Sending while a turn is already running (0.9.12). Two different asks, so
  // two modes: "steer" reaches the model at its next step inside the running
  // turn, "next" waits for the turn to end and then sends normally. Defaults to
  // "next" because that is the safe reading of a message typed mid-turn — a
  // follow-up you thought of, not a correction you're sure about.
  const [queueMode, setQueueMode] = useState<PendingMode>("next");
  const queued = useApp((s) => s.pendingByChat[chatId] ?? EMPTY);
  const queuePendingMessage = useApp((s) => s.queuePendingMessage);
  const cancelPending = useApp((s) => s.cancelPendingMessage);

  // One-shot overrides for the next send only. ovZone: undefined = use the
  // chat's own zone, null = Quick chat (no zone), string = a specific zone.
  // ovModel "" = no model override.
  const [ovZone, setOvZone] = useState<string | null | undefined>(undefined);
  const [ovModel, setOvModel] = useState("");
  const [ovOpen, setOvOpen] = useState(false);
  const [ovModels, setOvModels] = useState<string[]>([]);
  useDismissOnEscape(ovOpen, () => setOvOpen(false));

  const chat = chats.find((c) => c.id === chatId) ?? null;
  // A Quick turn runs the base zone (Settings → Chat), or the first provider's
  // default model when none is set — the same order the backend resolves.
  const quickProviderId = resolveBaseProvider(providers, zones, baseZoneId)?.id ?? null;
  const quickModel = resolveBaseModel(providers, zones, baseZoneId) || null;
  // Which provider's models the override picker should offer, given the chosen
  // (or default) zone for the turn.
  const ovProviderId = (() => {
    if (ovZone === null) return quickProviderId;
    const zid = ovZone === undefined ? chat?.zoneId ?? null : ovZone;
    if (zid === null) return quickProviderId;
    return zones.find((z) => z.id === zid)?.providerId ?? null;
  })();

  // Effective model for the next send, honouring one-shot overrides. Used to
  // decide OCR fallback (0.4.0). Null when it can't be predicted (Smart routing
  // picks a zone per turn) — we then skip the fallback hint and let the backend
  // OCR if needed.
  const effectiveModel = (() => {
    if (ovModel.trim()) return ovModel.trim();
    if (ovZone === SMART_ZONE_ID) return null;
    const useQuick = ovZone === null;
    if (useQuick) return quickModel;
    const zid = ovZone === undefined ? chat?.zoneId ?? null : ovZone;
    if (zid === null) return quickModel;
    return zones.find((z) => z.id === zid)?.model ?? null;
  })();
  // True when the chosen model can't see images, so any image/PDF attachment
  // will be sent as OCR-extracted text instead. Honors the per-model manual
  // override (Settings / zone editor) over the name heuristic.
  const ocrFallback =
    effectiveModel != null && !resolveVisionCapable(effectiveModel, visionOverrides);
  const hasVisualAttachment = pending.some((a) => a.fileType === "image" || a.fileType === "pdf");

  useEffect(() => {
    if (!ovOpen || !ovProviderId) return;
    let cancelled = false;
    api.fetchModels(ovProviderId)
      .then((m) => { if (!cancelled) setOvModels(m); })
      .catch(() => { if (!cancelled) setOvModels([]); });
    return () => { cancelled = true; };
  }, [ovOpen, ovProviderId]);

  const overrideActive = ovZone !== undefined || ovModel.trim() !== "";
  const overrideLabel = (() => {
    const parts: string[] = [];
    if (ovZone === null) parts.push("Quick chat");
    else if (ovZone === SMART_ZONE_ID) parts.push("Smart chat");
    else if (typeof ovZone === "string") parts.push(zones.find((z) => z.id === ovZone)?.name ?? "zone");
    if (ovModel.trim()) parts.push(ovModel.trim());
    return parts.join(" · ");
  })();
  function clearOverride() { setOvZone(undefined); setOvModel(""); }

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
    // When the chosen model can't see images, extract PDF text directly (better
    // quality than OCR'ing rendered pages) regardless of the global pdfMode.
    const usePdfText = pdfMode === "text" || ocrFallback;
    setAttachError(null);
    for (const file of list) {
      const kind = attachmentKind(file);
      const id = crypto.randomUUID();

      if (kind === "pdf") {
        const stub: PendingAttachment = {
          id,
          fileName: file.name,
          fileType: "pdf",
          payload: usePdfText ? "" : [],
          progress: { page: 0, total: 0 },
        };
        setPending((p) => [...p, stub]);
        try {
          if (usePdfText) {
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
      } else if (kind === "image") {
        const dataUrl = await readFileAsDataUrl(file);
        setPending((p) => [
          ...p,
          { id, fileName: file.name, fileType: "image", payload: dataUrl },
        ]);
      } else {
        // Anything that isn't an image or a PDF is read as text — no extension
        // allowlist, because the file the user picked is nearly always text and
        // the list could never name every language and config format. A file
        // that turns out to be binary is refused where they can see it.
        try {
          const content = await readTextAttachment(file);
          setPending((p) => [
            ...p,
            { id, fileName: file.name, fileType: "text", payload: content },
          ]);
        } catch (e) {
          if (e instanceof UnreadableFileError) setAttachError(e.message);
          else { console.error(e); setAttachError(`Couldn't read ${file.name}.`); }
        }
      }
    }
  }

  function removePending(id: string) {
    setPending((p) => p.filter((a) => a.id !== id));
  }

  async function onSend(explicitText?: string) {
    if (sending || disabled) return;
    const sourceText = explicitText ?? text;
    const hasText = sourceText.trim().length > 0;
    if (!hasText && pending.length === 0) return;

    setSending(true);
    const savedText = text;
    const savedPending = pending;

    try {
      const parts: InputPart[] = [];
      const visibleTextParts: string[] = [];
      if (hasText) visibleTextParts.push(sourceText.trim());

      const joined = visibleTextParts.join("\n\n");
      if (joined) {
        parts.push({ type: "text", text: joined });
      }

      for (const att of pending) {
        parts.push(...attachmentToParts(att));
        // The rendered pages are also kept as a stored attachment, so the chat
        // can show them again without re-rendering the PDF.
        if (att.fileType === "pdf" && Array.isArray(att.payload)) {
          api.savePdfAttachment(chatId, att.fileName, att.payload).catch(console.error);
        }
      }

      const overrideZoneId =
        ovZone === undefined ? null
        : ovZone === null ? SIMPLE_ZONE_ID
        : ovZone; // includes SMART_ZONE_ID sentinel as-is
      const overrideModel = ovModel.trim() || null;

      setText("");
      setPending([]);
      setSending(false);
      clearOverride();

      await api.sendMessage(chatId, parts, { zoneId: overrideZoneId, model: overrideModel });
      refreshChats();
    } catch (e) {
      console.error("send failed:", e);
      // Restore input so the user doesn't lose their message
      setText(savedText);
      setPending(savedPending);
      setSending(false);
    }
  }

  /**
   * Hand the composer's text to a turn that is already running. Attachments
   * can't ride along (the queue carries text), so the button is disabled while
   * any are staged rather than dropping them silently.
   */
  async function onQueue() {
    const body = text.trim();
    if (!body || sending || disabled || pending.length > 0) return;
    setSending(true);
    setText("");
    try {
      const accepted = await queuePendingMessage(chatId, body, queueMode);
      // The turn finished between the keystroke and the call — there is nothing
      // left to queue behind, so send it as an ordinary message.
      if (!accepted) {
        await api.sendMessage(chatId, [{ type: "text", text: body }]);
        refreshChats();
      }
    } catch (e) {
      console.error("queueing failed:", e);
      setText(body);
    } finally {
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
        {notice}
        {attachError && (
          <div className="mb-2 flex w-fit items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400">
            <FileText size={11} />
            <span>{attachError}</span>
            <button
              onClick={() => setAttachError(null)}
              className="opacity-60 hover:opacity-100"
              title="Dismiss"
            >
              <X size={11} />
            </button>
          </div>
        )}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pending.map((att) => (
              <AttachmentChip
                key={att.id}
                attachment={att}
                onRemove={() => removePending(att.id)}
                onPreview={att.progress ? undefined : () => setPreviewId(att.id)}
              />
            ))}
          </div>
        )}
        {previewAtt && (
          <AttachmentPreview
            attachment={previewAtt}
            onClose={() => setPreviewId(null)}
          />
        )}
        {ocrFallback && hasVisualAttachment && (
          <div
            className="mb-2 flex w-fit items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400"
            title={`${effectiveModel} can't process images directly. Attached images and PDFs will be sent as OCR-extracted text.`}
          >
            <ScanText size={11} />
            <span>OCR fallback: images sent as extracted text</span>
          </div>
        )}
        {overrideActive && (
          <div className="mb-2 flex w-fit items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2.5 py-1 text-xs text-[var(--color-accent)]">
            <Zap size={11} />
            <span>This message: {overrideLabel}</span>
            <button onClick={clearOverride} className="hover:text-[var(--color-text)]" title="Clear override">
              <X size={11} />
            </button>
          </div>
        )}
        {queued.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {queued.map((q) => (
              <div
                key={q.id}
                className="flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2.5 py-1 text-xs text-[var(--color-accent)]"
                title={
                  q.mode === "steer"
                    ? `Waiting to reach the model at its next step:\n\n${q.text}`
                    : `Will be sent when this turn finishes:\n\n${q.text}`
                }
              >
                {q.mode === "steer" ? <CornerDownRight size={11} /> : <Clock size={11} />}
                <span className="max-w-[280px] truncate">{q.text}</span>
                <button
                  onClick={() => cancelPending(chatId, q.id)}
                  className="shrink-0 hover:text-[var(--color-text)]"
                  title="Take this back"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Only once there is something to send: the choice between "now" and
            "after" is about a message that exists. Shown on an empty composer it
            was a permanent mid-turn fixture asking about nothing. Centred over
            the composer so it reads as part of it. */}
        {isStreaming && text.trim() !== "" && (
          <div className="mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] py-1 pl-3 pr-1 text-xs text-[var(--color-text-muted)]">
            <span className="shrink-0">Still working, send new message:</span>
            <QueueModeChip
              label="now"
              icon={<CornerDownRight size={10} />}
              active={queueMode === "steer"}
              title="Hand it to the model at its next step, inside this turn. Use it to correct course — nothing it has already done is thrown away."
              onClick={() => setQueueMode("steer")}
            />
            <QueueModeChip
              label="after"
              icon={<Clock size={10} />}
              active={queueMode === "next"}
              title="Hold it until this turn finishes, then send it as an ordinary message."
              onClick={() => setQueueMode("next")}
            />
          </div>
        )}
        <DictationMeter dictation={dictation} />
        {dictation.voiceError && (
          <div className="mb-2 flex w-fit items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs text-red-600 dark:text-red-400">
            <span>{dictation.voiceError}</span>
            <button onClick={dictation.dismissVoiceError} className="hover:text-[var(--color-text)]" title="Dismiss">
              <X size={11} />
            </button>
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
          <MicButton dictation={dictation} disabled={disabled} />
          {conversationEnabled && ttsConfigured && (
            <button
              onClick={toggleConversation}
              disabled={disabled}
              title={conversationActive ? "End conversation mode" : "Start hands-free conversation"}
              className={`rounded p-1.5 hover:bg-[var(--color-panel-hover)] disabled:opacity-40 ${
                conversationActive
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              <AudioLines size={16} className={conversationActive ? "animate-pulse" : ""} />
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setOvOpen((v) => !v)}
              disabled={disabled}
              title="Options for this message (zone / model)"
              className={`rounded p-1.5 hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:opacity-40 ${
                overrideActive ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"
              }`}
            >
              <SlidersHorizontal size={16} />
            </button>
            {ovOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setOvOpen(false)} />
                <div className="absolute bottom-full left-0 z-40 mb-2 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-lg">
                  <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    For this message only
                  </div>

                  <div className="mb-1 text-xs text-[var(--color-text-muted)]">Zone</div>
                  <div className="mb-3 flex flex-wrap gap-1">
                    <OvChip label="Chat default" active={ovZone === undefined} onClick={() => setOvZone(undefined)} />
                    <OvChip label="Quick" icon={<Zap size={10} />} active={ovZone === null} onClick={() => setOvZone(null)} />
                    <OvChip label="Smart" icon={<Brain size={10} />} active={ovZone === SMART_ZONE_ID} onClick={() => setOvZone(SMART_ZONE_ID)} />
                    {zones.map((z) => (
                      <OvChip
                        key={z.id}
                        label={z.name}
                        active={ovZone === z.id}
                        onClick={() => setOvZone(z.id)}
                      />
                    ))}
                  </div>

                  <div className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
                    <span>Model</span>
                    {ovModel.trim() && (
                      <button onClick={() => setOvModel("")} className="hover:text-[var(--color-text)]">Reset</button>
                    )}
                  </div>
                  <ModelCombobox
                    value={ovModel}
                    onChange={setOvModel}
                    options={ovModels}
                    className={OV_FIELD_CLS}
                    placeholder="Zone's default model"
                  />
                </div>
              </>
            )}
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              const trigger = sendKey === "ctrl_enter"
                ? e.key === "Enter" && (e.ctrlKey || e.metaKey)
                : e.key === "Enter" && !e.shiftKey;
              if (trigger) {
                e.preventDefault();
                if (isStreaming) onQueue();
                else onSend();
              }
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
            <>
              <button
                onClick={onQueue}
                disabled={disabled || sending || text.trim() === "" || pending.length > 0}
                title={
                  pending.length > 0
                    ? "Attachments can't be queued — wait for this turn to finish"
                    : queueMode === "steer"
                      ? "Send to the model at its next step"
                      : "Send when this turn finishes"
                }
                className="rounded bg-[var(--color-accent)] p-1.5 text-white hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={16} />
              </button>
              <button
                onClick={() => api.cancelStream(chatId).catch(console.error)}
                className="flex items-center gap-1 rounded bg-[var(--color-panel-hover)] p-1.5 text-[var(--color-text)] hover:bg-[var(--color-border)]"
                title="Stop generating"
              >
                <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                <Square size={12} />
              </button>
            </>
          ) : (
            <button
              onClick={() => onSend()}
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

/** One option of the mid-turn send-mode toggle. */
function QueueModeChip({
  label, icon, active, title, onClick,
}: {
  label: string; icon: React.ReactNode; active: boolean; title: string; onClick: () => void;
}) {
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
      {icon}
      {label}
    </button>
  );
}

function OvChip({
  label, active, icon, onClick,
}: {
  label: string; active: boolean; icon?: React.ReactNode; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
      }`}
    >
      {icon}
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
  } else if (attachment.fileType === "pdf") {
    if (typeof attachment.payload === "string") {
      // text mode
      body = (
        <pre className="max-h-[70vh] max-w-[75vw] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {attachment.payload || "(no text extracted)"}
        </pre>
      );
    } else {
      // images mode — scrollable page gallery
      const pages = attachment.payload as string[];
      body = (
        <div className="flex max-h-[75vh] max-w-[80vw] flex-col gap-4 overflow-y-auto">
          {pages.map((src, i) => (
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
    }
  } else {
    // text file
    body = (
      <pre className="max-h-[70vh] max-w-[75vw] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {attachment.payload as string}
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

// Maximum long-edge pixel size for stored images. Anything larger is
// resized down before storage so that large screenshots/photos don't
// inflate the base64 payload sent to the model on every turn.
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

