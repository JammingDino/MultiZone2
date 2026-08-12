import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Paperclip, Send, X, Loader2, Square, SlidersHorizontal, Zap, Brain, ScanText, AudioLines, Clock, CornerDownRight, ClipboardList } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { useTts } from "@/store/tts";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { useDictation, MicButton, DictationMeter } from "@/components/Chat/useDictation";
import type { InputPart, PendingMode } from "@/lib/types";
import { attachmentToParts, type PendingAttachment } from "@/lib/attachFiles";
import {
  appendTranscript,
  AttachError,
  AttachmentRow,
  AudioModeRow,
  readFileAsDataUrl,
  useAttachments,
} from "@/components/Chat/Attachments";
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
// that has to agree with it.
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
  const [sending, setSending] = useState(false);
  const refreshChats = useApp((s) => s.refreshChats);
  const sendKey = useApp((s) => s.appSettings.sendKey);
  const chats = useApp((s) => s.chats);
  const zones = useApp((s) => s.zones);
  const providers = useApp((s) => s.providers);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  const visionOverrides = useApp((s) => s.appSettings.visionOverrides);
  const planMode = !!chats.find((c) => c.id === chatId)?.planMode;
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
  // Staged files. When the chosen model can't see images, PDFs are attached as
  // extracted text — better quality than OCR'ing rendered pages — regardless of
  // the global preference.
  // A transcribed upload lands in the composer as ordinary text the user can
  // edit and send (0.12.0) — which is what lets a text-only model take spoken
  // input at all. In "context" injection mode `onTranscript` is never called and
  // the transcript rides along as a hidden attachment part instead.
  const tray = useAttachments({
    pdfAsText: ocrFallback,
    onTranscript: (t) => appendTranscript(setText, t),
  });
  const pending = tray.pending;
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

  useImperativeHandle(ref, () => ({ addFiles: (files) => tray.addFiles(files) }), [chatId]);

  // Grow the textarea with its content up to the CSS max-height, after which
  // the `overflow-y-auto` class takes over and a scrollbar appears.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);


  async function onSend(explicitText?: string) {
    if (sending || disabled) return;
    // A transcript still arriving would be dropped by a send that doesn't wait
    // for it — the audio chip carries no content until then. Guarded here as
    // well as on the button because Enter doesn't go through the button.
    if (tray.transcribing) return;
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
      tray.clear();
      setSending(false);
      clearOverride();

      await api.sendMessage(chatId, parts, { zoneId: overrideZoneId, model: overrideModel });
      refreshChats();
    } catch (e) {
      console.error("send failed:", e);
      // Restore input so the user doesn't lose their message
      setText(savedText);
      tray.setPending(savedPending);
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
      tray.setPending((p) => [
        ...p,
        { id: crypto.randomUUID(), fileName, fileType: "image", payload: dataUrl },
      ]);
    }
  }

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 sm:px-4 sm:py-3">
      <div className="mx-auto w-full max-w-3xl">
        {notice}
        <AttachError tray={tray} />
        <AudioModeRow tray={tray} />
        <AttachmentRow tray={tray} />
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
        {/* Plan mode (0.12.1). Entering is the model's move, not a button: the
            user asks for a plan in prose and the model calls `enter_plan_mode`.
            What stays here is the state, because a mode that silently withholds
            tools has to be visible while it is on — an indicator, not a switch.
            Leaving is by approving or rejecting the plan in `PlanReview`. */}
        {planMode && (
          <div className="mb-2 flex items-center gap-2">
            <span
              title="Mutating tools are withheld until you approve a plan."
              className="flex items-center gap-1.5 rounded-full border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-2.5 py-1 text-xs text-[var(--color-accent)]"
            >
              <ClipboardList size={11} />
              Plan mode
            </span>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              Read-only until you approve a plan.
            </span>
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
              tray.addFiles(e.target.files);
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
              disabled={disabled || sending || tray.transcribing || (text.trim() === "" && pending.length === 0)}
              className="rounded bg-[var(--color-accent)] p-1.5 text-white hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              title={tray.transcribing ? "Waiting for the transcript…" : "Send"}
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
