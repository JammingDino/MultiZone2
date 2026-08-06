import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ContentPart, Message, InputPart } from "@/lib/types";
import { Markdown } from "@/components/Renderers/Markdown";
import { User, Check, X, FileType, ZoomIn } from "lucide-react";
import { StepBlock } from "./StepBlock";
import { ActivityRail } from "./ActivityRail";
import { PerspectiveStatusLine, PrimaryStatusLine } from "./StatusLine";
import { MessageActions } from "./MessageActions";
import { CitationSources } from "./CitationSources";
import { StackTrace, spawnedSubchatIdsFromBlocks } from "./StackTrace";
import type { BotTurn, PerspectiveTurn, Step, TurnBlock } from "@/lib/grouping";
import {
  citationKey,
  collectCarriedCitations,
  collectCitations,
  matchedCitations,
  type Citation,
  type FileSource,
} from "@/lib/citations";
import { parseFileAttachments } from "@/lib/attachmentParts";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { getZoneIcon } from "@/lib/zoneIcons";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Throttles a streaming text source so the Markdown renderer (which re-parses
 * the entire AST on every prop change, plus KaTeX) doesn't fire on every
 * token. We push the latest value to the renderer on a fixed interval while
 * `streaming` is true, and flush immediately the moment it flips to false.
 *
 * The throttled `visible` state is only ever consulted *while streaming*. When
 * idle we return `source` directly rather than a state copy of it, because a
 * copy can go stale: this component instance is reused across chat switches
 * (turns and text blocks are keyed by index), and an effect keyed on
 * `[streaming]` never re-runs when both the old and new chat are idle. That
 * left `visible` holding the previous chat's answer — the "chat history
 * mix-ups" bug, where the prompt updated (user messages are keyed by id) but
 * the answer under it did not.
 */
const STREAM_MARKDOWN_THROTTLE_MS = 80;

function useThrottledStreaming(source: string, streaming: boolean): string {
  const [visible, setVisible] = useState(source);
  const latestRef = useRef(source);
  latestRef.current = source;

  useEffect(() => {
    if (!streaming) return;
    setVisible(latestRef.current);
    const id = window.setInterval(
      () => setVisible(latestRef.current),
      STREAM_MARKDOWN_THROTTLE_MS,
    );
    return () => window.clearInterval(id);
  }, [streaming]);

  // Idle: `source` is authoritative and always current.
  return streaming ? visible : source;
}

/** Renders a single text chunk, with its own streaming throttle. */
function TextBlockView({
  text,
  streaming,
  citations,
}: {
  text: string;
  streaming: boolean;
  citations?: Citation[];
}) {
  const visible = useThrottledStreaming(text, streaming);
  return (
    <div>
      <Markdown source={visible} citations={citations} />
      {streaming && <span className="animate-pulse">▌</span>}
    </div>
  );
}

function parseParts(json: string): ContentPart[] {
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr;
  } catch {}
  return [{ type: "text", text: json }];
}

/**
 * File attachments from the primary user message that opened this turn's round,
 * surfaced as citation sources (0.4.1). PDFs rendered as images carry a page
 * count; everything else is named alone.
 */
function deriveFileSources(messages: Message[], firstTurnMsgId: string | undefined): FileSource[] {
  if (!firstTurnMsgId) return [];
  let user: Message | null = null;
  for (const m of messages) {
    if (m.id === firstTurnMsgId) break;
    if (m.role === "user" && !m.zoneId) user = m;
  }
  if (!user) return [];
  return parseFileAttachments(parseParts(user.content)).map((p) => ({
    fileName: p.fileName,
    pages: p.mode === "images" ? p.pages.length : undefined,
  }));
}

type MessagePreview =
  | { kind: "image"; url: string }
  | { kind: "pdf-images"; fileName: string; pages: string[] }
  | { kind: "pdf-text"; fileName: string; text: string }
  | { kind: "file-text"; fileName: string; text: string };

function UserMessageImpl({ message }: { message: Message }) {
  const parts = parseParts(message.content);
  const text = parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const images = parts.filter(
    (p): p is Extract<ContentPart, { type: "image_url" }> => p.type === "image_url",
  );
  // hidden_text and hidden_image parts are never rendered — they are sent to
  // the model but kept invisible in the chat UI.
  const fileAttachments = parseFileAttachments(parts);
  // Hidden parts carry the attachments; keep them intact when a turn is edited
  // and resent, so editing the question doesn't silently drop the file with it.
  const hiddenParts = parts.filter(
    (p) => p.type === "hidden_text" || p.type === "hidden_image",
  );

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [preview, setPreview] = useState<MessagePreview | null>(null);
  const resending = useRef(false);
  const loadMessages = useApp((s) => s.loadMessages);
  const refreshChats = useApp((s) => s.refreshChats);
  // In a subchat, user-role turns are the owning zone's prompts — render them
  // with that zone's avatar instead of the generic user avatar.
  const subchatZone = useApp((s) => {
    const chat = s.chats.find((c) => c.id === message.chatId);
    if (!chat?.initiatedByZoneId) return null;
    return s.zones.find((z) => z.id === chat.initiatedByZoneId) ?? null;
  });
  const SenderIcon = subchatZone ? getZoneIcon(subchatZone.icon) : User;
  const senderBg = subchatZone?.accentColor ?? "var(--color-accent)";

  /**
   * Send this turn again — the given text plus every attachment it carried,
   * with this message and everything after it dropped first. Shared by "Save &
   * resend" (edited text) and "Resend" (unchanged), because those differ only in
   * what the text is.
   */
  async function resend(nextText: string) {
    // The turn isn't streaming yet between the click and the send, so the
    // button's own disabled state can't cover this window.
    if (resending.current) return;
    resending.current = true;
    try {
      await api.deleteMessagesFrom(message.chatId, message.id);
      await loadMessages(message.chatId);
      const parts: InputPart[] = [];
      if (nextText) parts.push({ type: "text", text: nextText });
      for (const img of images) {
        parts.push({ type: "image", data_url: img.image_url.url });
      }
      for (const p of hiddenParts) {
        if (p.type === "hidden_text") parts.push({ type: "hidden_text", text: p.text });
        else parts.push({ type: "hidden_image", data_url: p.image_url.url });
      }
      await api.sendMessage(message.chatId, parts);
      refreshChats();
    } catch (e) {
      console.error(e);
    } finally {
      resending.current = false;
    }
  }

  async function commitEdit() {
    const next = draft.trim();
    if (!next || next === text.trim()) {
      setEditing(false);
      setDraft(text);
      return;
    }
    setEditing(false);
    await resend(next);
  }

  if (editing) {
    return (
      <div className="flex justify-end gap-3">
        <div className="flex max-w-[80%] flex-col items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
                setDraft(text);
              }
            }}
            autoFocus
            rows={Math.max(2, draft.split("\n").length)}
            className="w-[480px] max-w-[80vw] rounded-2xl rounded-tr-sm border border-[var(--color-accent)] bg-[var(--color-panel)] px-3 py-2 text-sm"
          />
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <button
              onClick={() => {
                setEditing(false);
                setDraft(text);
              }}
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-[var(--color-panel-hover)]"
            >
              <X size={11} />
              Cancel
            </button>
            <button
              onClick={commitEdit}
              className="flex items-center gap-1 rounded bg-[var(--color-accent)] px-2 py-1 text-white"
            >
              <Check size={11} />
              Save &amp; resend
            </button>
            <span>Ctrl+Enter to save, Esc to cancel</span>
          </div>
        </div>
        <div
          className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded shadow-sm"
          style={{ background: senderBg }}
          title={subchatZone ? subchatZone.name : undefined}
        >
          <SenderIcon size={14} color="white" />
        </div>
      </div>
    );
  }

  return (
    <div className="msg-row">
      <div className="flex justify-end gap-3">
        <div className="flex max-w-[80%] flex-col items-end gap-2">
          {images.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setPreview({ kind: "image", url: img.image_url.url })}
                  className="group relative rounded border border-[var(--color-border)] hover:border-[var(--color-accent)]"
                  title="Click to preview"
                >
                  <img
                    src={img.image_url.url}
                    alt="attachment"
                    className="max-h-48 rounded"
                  />
                  <span className="absolute inset-0 flex items-center justify-center rounded bg-black/0 transition group-hover:bg-black/20">
                    <ZoomIn size={20} className="opacity-0 text-white drop-shadow group-hover:opacity-100 transition" />
                  </span>
                </button>
              ))}
            </div>
          )}
          {fileAttachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {fileAttachments.map((f, i) => (
                <button
                  key={i}
                  onClick={() =>
                    setPreview(
                      f.mode === "images"
                        ? { kind: "pdf-images", fileName: f.fileName, pages: f.pages }
                        : f.mode === "text"
                          ? { kind: "pdf-text", fileName: f.fileName, text: f.text }
                          : { kind: "file-text", fileName: f.fileName, text: f.text },
                    )
                  }
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-hover)]"
                  title="Click to preview"
                >
                  <FileType size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="max-w-[180px] truncate">{f.fileName}</span>
                  <ZoomIn size={10} className="shrink-0 text-[var(--color-text-muted)]" />
                </button>
              ))}
            </div>
          )}
          {text && (
            <div className="rounded-2xl rounded-tr-sm bg-[var(--color-accent)] px-3 py-2 text-sm text-white">
              <div className="whitespace-pre-wrap break-words">{text}</div>
            </div>
          )}
        </div>
        <div
          className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded shadow-sm"
          style={{ background: senderBg }}
          title={subchatZone ? subchatZone.name : undefined}
        >
          <SenderIcon size={14} color="white" />
        </div>
      </div>
      <div className="msg-actions">
        <MessageActions
          text={text}
          chatId={message.chatId}
          variant="user"
          onEdit={() => setEditing(true)}
          onResend={() => resend(text.trim())}
          branchFromMessageId={message.id}
        />
      </div>
      {preview && (
        <MessagePreviewModal preview={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

/** Memoized — a large chat history shouldn't re-render every past user turn on each streamed token. */
export const UserMessage = memo(UserMessageImpl);

function MessagePreviewModal({
  preview,
  onClose,
}: {
  preview: MessagePreview;
  onClose: () => void;
}) {
  useDismissOnEscape(true, onClose);

  const title =
    preview.kind === "image" ? "Image preview" : preview.fileName;

  let body: React.ReactNode;
  if (preview.kind === "image") {
    body = (
      <img
        src={preview.url}
        alt="attachment"
        className="max-h-[75vh] max-w-full rounded object-contain"
      />
    );
  } else if (preview.kind === "pdf-images") {
    body = (
      <div className="flex max-h-[75vh] max-w-[80vw] flex-col gap-4 overflow-y-auto">
        {preview.pages.map((src, i) => (
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
    body = (
      <pre className="max-h-[70vh] max-w-[75vw] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {preview.text || "(no text extracted)"}
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
          <span className="max-w-[400px] truncate text-sm font-medium">{title}</span>
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

/**
 * Renders an ordered block list (thinking / tool steps / text) for one
 * participant's turn. Shared by the primary turn and every perspective turn so
 * they render with identical structure — only avatar and accent differ.
 */
function TurnBody({
  blocks,
  isStreaming,
  chatId,
  citations,
}: {
  blocks: TurnBlock[];
  isStreaming: boolean;
  chatId: string;
  citations?: Citation[];
}) {
  // Compact mode folds each unbroken stretch of thinking/tool steps into one
  // activity rail; a text block ends the stretch, so the model's prose always
  // sits at the top level of the turn rather than inside a collapsed block.
  const compact = useApp((s) => s.appSettings.compactSteps);
  const blockElements: React.ReactNode[] = [];
  let stepIdx = 0;
  let run: Step[] = [];
  let runStart = 1;

  const flushRun = () => {
    if (run.length === 0) return;
    if (compact) {
      blockElements.push(
        <ActivityRail
          key={`rail-${run[0].key}`}
          steps={run}
          startIndex={runStart}
          chatId={chatId}
        />,
      );
    } else {
      for (const [i, step] of run.entries()) {
        blockElements.push(
          <StepBlock key={step.key} step={step} index={runStart + i} chatId={chatId} />,
        );
      }
    }
    run = [];
  };

  blocks.forEach((block, i) => {
    if (block.kind === "step") {
      if (run.length === 0) runStart = stepIdx + 1;
      stepIdx += 1;
      run.push(block.step);
      return;
    }
    flushRun();
    blockElements.push(
      <TextBlockView
        key={`text-${i}`}
        text={block.text}
        streaming={!!block.streaming}
        citations={citations}
      />,
    );
  });
  flushRun();

  return (
    <>
      {blockElements.length > 0 && <div className="flex flex-col gap-2">{blockElements}</div>}
      {isStreaming && blocks.length === 0 && (
        <span className="animate-pulse text-[var(--color-text-muted)]">▌</span>
      )}
    </>
  );
}

/**
 * Inline click-to-edit textarea for an assistant message's final answer text.
 * Saving persists the new text to the DB and flags the message as edited;
 * the surrounding turn re-renders from the reloaded messages.
 */
function AssistantEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (text: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function commit() {
    const next = draft.trim();
    if (!next || next === initial.trim()) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        autoFocus
        rows={Math.max(3, draft.split("\n").length)}
        className="w-full rounded-lg border border-[var(--color-accent)] bg-[var(--color-panel)] px-3 py-2 text-sm"
      />
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <button
          onClick={onCancel}
          className="flex items-center gap-1 rounded px-2 py-1 hover:bg-[var(--color-panel-hover)]"
        >
          <X size={11} />
          Cancel
        </button>
        <button
          onClick={commit}
          disabled={saving}
          className="flex items-center gap-1 rounded bg-[var(--color-accent)] px-2 py-1 text-white disabled:opacity-50"
        >
          <Check size={11} />
          {saving ? "Saving…" : "Save"}
        </button>
        <span>Ctrl+Enter to save, Esc to cancel</span>
      </div>
    </div>
  );
}

/**
 * The turn's own retrieved sources, plus any earlier-turn source the answer
 * actually cited. Feeds the Sources list, so carried sources appear under
 * "Used" without dragging the whole of an earlier search into "All retrieved".
 */
function withCitedCarried(turnCitations: Citation[], used: Citation[]): Citation[] {
  const own = new Set(turnCitations.map(citationKey));
  const extra = used.filter((c) => !own.has(citationKey(c)));
  return extra.length > 0 ? [...turnCitations, ...extra] : turnCitations;
}

/** Index of the last text block in a turn (the final answer), or -1 if none. */
function lastTextBlockIndex(blocks: TurnBlock[]): number {
  let idx = -1;
  blocks.forEach((b, i) => {
    if (b.kind === "text") idx = i;
  });
  return idx;
}

function BotTurnViewImpl({ turn, isLatest = false }: { turn: BotTurn; isLatest?: boolean }) {
  const isStreaming = Boolean(turn.streaming);
  const hasAnything = turn.blocks.length > 0 || isStreaming;

  const chatId = useApp((s) => s.activeChatId) ?? "";
  // While streaming, no assistant message is saved yet so `turn.zoneId` is null.
  // Resolve the answering zone early — from the live routing result, else the
  // chat's bound zone — so the avatar/accent show the zone's colours from the
  // first token instead of a generic theme that only "fills in" once saved.
  const chatZoneId = useApp((s) => s.chats.find((c) => c.id === chatId)?.zoneId ?? null);
  const routing = useApp((s) => s.routingByChat[chatId]);
  const resolvedZoneId =
    turn.zoneId ??
    (routing && routing.status === "done" ? routing.zoneId : null) ??
    chatZoneId;
  const zone = useApp((s) => s.zones.find((z) => z.id === resolvedZoneId));
  const layout = useApp((s) => s.appSettings.perspectiveLayout);

  // Citation sources for the turn (web_search results + the round's file
  // attachments). Shared with every perspective card in this round.
  const messages = useApp((s) => s.messagesByChat[chatId]);
  const fileSources = useMemo(
    () => deriveFileSources(messages ?? [], turn.messageIds[0]),
    [messages, turn.messageIds],
  );
  // Sources retrieved in earlier turns stay citable for the rest of the chat —
  // a follow-up answer often leans on the search that ran two turns ago.
  const carriedCitations = useMemo(
    () => collectCarriedCitations(messages ?? [], turn.messageIds[0]),
    [messages, turn.messageIds],
  );
  const turnCitations = useMemo(
    () => collectCitations(turn.blocks, fileSources),
    [turn.blocks, fileSources],
  );
  const citations = useMemo(
    () => matchedCitations(turnCitations, turn.blocks, carriedCitations),
    [turnCitations, turn.blocks, carriedCitations],
  );
  // A carried source is listed only when it was actually cited, so old search
  // results don't pile up under "retrieved" on every later turn.
  const allCitations = useMemo(
    () => withCitedCarried(turnCitations, citations),
    [turnCitations, citations],
  );
  // Sub-agents this leader turn spawned (0.6.1 stack tracer). Empty for ordinary
  // turns, so the trace block renders nothing.
  const spawnedSubchatIds = useMemo(
    () => spawnedSubchatIdsFromBlocks(turn.blocks),
    [turn.blocks],
  );

  const editMessage = useApp((s) => s.editMessage);
  const [editing, setEditing] = useState(false);
  // The turn's final assistant message — the edit target / "edited" marker source.
  const lastMsgId = turn.messageIds[turn.messageIds.length - 1] ?? "";
  const finalEdited = useApp((s) =>
    lastMsgId
      ? s.messagesByChat[chatId]?.find((m) => m.id === lastMsgId)?.edited ?? false
      : false,
  );

  if (!hasAnything) return null;

  const pivotMessageId = turn.messageIds[0];
  const lastMessageId = turn.messageIds[turn.messageIds.length - 1];

  // Combine all text blocks for copy action.
  const allText = turn.blocks
    .filter((b): b is Extract<TurnBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n");

  const ZoneIcon = getZoneIcon(zone?.icon);
  const zoneColor = zone?.accentColor ?? null;
  const hasPerspectives = turn.perspectives.length > 0;

  // ── Multi-zone turn: the primary and every perspective are equal cards laid
  // out together — side-by-side columns or stacked. They share one renderer so
  // the zone avatar/accent is the only thing that differs between them. ──
  if (hasPerspectives) {
    // NB: no `msg-row` on this wrapper — each ParticipantCard is its own
    // `.msg-row`, so a wrapping row here would make hovering any one card
    // reveal every card's action bar (the `.msg-row:hover .msg-actions` rule
    // matches all descendants).
    return (
      <div>
        <div className={layout === "columns" ? "flex flex-wrap items-start justify-center gap-4" : "flex flex-col gap-5"}>
          <ParticipantCard
            zoneId={resolvedZoneId}
            fallbackName="Primary"
            blocks={turn.blocks}
            isStreaming={isStreaming}
            chatId={chatId}
            text={allText}
            actionMessageId={lastMessageId}
            regenerateZoneId={null}
            canRegenerate={isLatest}
            layout={layout}
            branchFromMessageId={lastMessageId}
            branchSolo
            branchSoloZoneId={null}
            fileSources={fileSources}
            carriedCitations={carriedCitations}
            statusLine={
              turn.streaming ? (
                <PrimaryStatusLine
                  streaming={turn.streaming}
                  chatId={chatId}
                  zoneId={resolvedZoneId}
                />
              ) : null
            }
          />
          {turn.perspectives.map((p) => (
            <ParticipantCard
              key={p.zoneId}
              zoneId={p.zoneId}
              fallbackName="Perspective"
              blocks={p.blocks}
              isStreaming={Boolean(p.streaming)}
              chatId={chatId}
              text={p.text}
              actionMessageId={p.messageId}
              regenerateZoneId={p.zoneId}
              canRegenerate={isLatest}
              layout={layout}
              branchFromMessageId={p.messageId}
              branchSolo
              branchSoloZoneId={p.zoneId}
              fileSources={fileSources}
              carriedCitations={carriedCitations}
              statusLine={
                p.streaming ? (
                  <PerspectiveStatusLine
                    streaming={p.streaming}
                    chatId={chatId}
                    zoneId={p.zoneId}
                  />
                ) : null
              }
            />
          ))}
        </div>
      </div>
    );
  }

  // ── Ordinary single-zone turn (unchanged look) ──
  return (
    <div className="msg-row">
      <div className="flex gap-3">
        <div className="flex flex-col items-center gap-1">
          <div
            className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded shadow-sm"
            style={{ background: zoneColor ?? "var(--color-panel)" }}
          >
            <ZoneIcon size={14} color={zoneColor ? "white" : "var(--color-text-muted)"} />
          </div>
        </div>
        <div
          className="flex-1 min-w-0 overflow-hidden border-l-2 pl-3"
          style={{
            borderColor: zoneColor
              ? `${zoneColor}55`
              : "color-mix(in srgb, var(--color-accent) 33%, transparent)",
          }}
        >
          {editing ? (
            (() => {
              const idx = lastTextBlockIndex(turn.blocks);
              const finalText =
                idx >= 0
                  ? (turn.blocks[idx] as Extract<TurnBlock, { kind: "text" }>).text
                  : allText;
              return (
                <div className="flex flex-col gap-2">
                  {idx >= 0 && (
                    <TurnBody
                      blocks={turn.blocks.filter((_, i) => i !== idx)}
                      isStreaming={false}
                      chatId={chatId}
                    />
                  )}
                  <AssistantEditor
                    initial={finalText}
                    onCancel={() => setEditing(false)}
                    onSave={async (text) => {
                      await editMessage(chatId, lastMessageId, text);
                      setEditing(false);
                    }}
                  />
                </div>
              );
            })()
          ) : (
            <>
              <TurnBody
                blocks={turn.blocks}
                isStreaming={isStreaming}
                chatId={chatId}
                citations={citations}
              />
              {turn.streaming && (
                <PrimaryStatusLine
                  streaming={turn.streaming}
                  chatId={chatId}
                  zoneId={resolvedZoneId}
                />
              )}
              {!isStreaming && <CitationSources used={citations} all={allCitations} />}
              {!isStreaming && (
                <StackTrace
                  chatId={chatId}
                  spawnedIds={spawnedSubchatIds}
                  leaderZoneId={resolvedZoneId}
                />
              )}
            </>
          )}
        </div>
      </div>
      {!isStreaming && !editing && chatId && pivotMessageId && (
        <div className="msg-actions">
          <MessageActions
            text={allText}
            messageId={lastMessageId}
            chatId={chatId}
            variant="assistant"
            regenerateZoneId={null}
            canRegenerate={isLatest}
            branchFromMessageId={lastMessageId}
            onEdit={allText ? () => setEditing(true) : undefined}
            edited={finalEdited}
          />
        </div>
      )}
    </div>
  );
}

// `groupMessages` rebuilds a fresh `BotTurn` object on every call (including
// for turns whose underlying messages haven't changed), so a default
// reference-equality memo would never bail out. Compare the pieces that
// actually change instead: message ids (grows only via new persisted
// messages) and the `streaming` reference (a new object every token, but only
// present on the turn currently generating).
function botTurnPropsEqual(
  prev: { turn: BotTurn; isLatest?: boolean },
  next: { turn: BotTurn; isLatest?: boolean },
): boolean {
  if (prev.isLatest !== next.isLatest) return false;
  const a = prev.turn;
  const b = next.turn;
  if (a.streaming !== b.streaming || a.zoneId !== b.zoneId) return false;
  if (a.messageIds.length !== b.messageIds.length) return false;
  for (let i = 0; i < a.messageIds.length; i++) {
    if (a.messageIds[i] !== b.messageIds[i]) return false;
  }
  if (a.perspectives.length !== b.perspectives.length) return false;
  for (let i = 0; i < a.perspectives.length; i++) {
    const pa = a.perspectives[i];
    const pb = b.perspectives[i];
    if (pa.zoneId !== pb.zoneId || pa.messageId !== pb.messageId || pa.streaming !== pb.streaming) {
      return false;
    }
  }
  return true;
}

/** Memoized — an in-progress turn re-renders on every streamed token; earlier turns in the same chat shouldn't. */
export const BotTurnView = memo(BotTurnViewImpl, botTurnPropsEqual);

/**
 * One participant's response in a multi-zone turn — the primary or a
 * perspective — rendered identically: zone avatar + collapse toggle + name
 * label + bordered body (thinking / tool / text via `TurnBody`). The zone
 * avatar and accent colour are the only things that differ between cards.
 */
function ParticipantCard({
  zoneId,
  fallbackName,
  blocks,
  isStreaming,
  chatId,
  text,
  actionMessageId,
  regenerateZoneId,
  canRegenerate,
  layout,
  branchFromMessageId,
  branchSolo = false,
  branchSoloZoneId = null,
  fileSources,
  carriedCitations,
  statusLine,
}: {
  zoneId: string | null;
  fallbackName: string;
  blocks: TurnBlock[];
  isStreaming: boolean;
  chatId: string;
  text: string;
  actionMessageId: string;
  regenerateZoneId: string | null;
  canRegenerate: boolean;
  layout: "stacked" | "columns";
  branchFromMessageId?: string;
  /** Branch this participant alone — see `MessageActions`. */
  branchSolo?: boolean;
  branchSoloZoneId?: string | null;
  fileSources?: FileSource[];
  carriedCitations?: Citation[];
  /** This zone's live status/stats while it generates — rendered in its own column. */
  statusLine?: React.ReactNode;
}) {
  const turnCitations = useMemo(
    () => collectCitations(blocks, fileSources ?? []),
    [blocks, fileSources],
  );
  const citations = useMemo(
    () => matchedCitations(turnCitations, blocks, carriedCitations ?? []),
    [turnCitations, blocks, carriedCitations],
  );
  const allCitations = useMemo(
    () => withCitedCarried(turnCitations, citations),
    [turnCitations, citations],
  );
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const editMessage = useApp((s) => s.editMessage);
  const edited = useApp((s) =>
    actionMessageId
      ? s.messagesByChat[chatId]?.find((m) => m.id === actionMessageId)?.edited ?? false
      : false,
  );
  const zone = useApp((s) => s.zones.find((z) => z.id === zoneId));
  const ZoneIcon = getZoneIcon(zone?.icon);
  const color = zone?.accentColor ?? null;
  const hasContent = blocks.length > 0;
  const showCollapsed = collapsed && !isStreaming;

  return (
    <div className={`msg-row ${layout === "columns" ? "min-w-[280px] max-w-3xl flex-1" : ""}`}>
      <div className="flex gap-3">
        {/* Avatar + the collapse "dropdown" beneath it */}
        <div className="flex flex-col items-center gap-1">
          <div
            className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded shadow-sm"
            style={{ background: color ?? "var(--color-panel)" }}
          >
            <ZoneIcon size={14} color={color ? "white" : "var(--color-text-muted)"} />
          </div>
          {!isStreaming && (
            <button
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? "Expand response" : "Collapse response"}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            >
              {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
        </div>

        {/* The `overflow-hidden` clip is scoped to the response body only, so
            long content can't blow out the column — while the actions' stats
            popup (rendered below) is free of the clip and won't be cut off. */}
        <div className="flex-1 min-w-0">
          <div
            className="overflow-hidden border-l-2 pl-3"
            style={{
              borderColor: color
                ? `${color}55`
                : "color-mix(in srgb, var(--color-accent) 33%, transparent)",
            }}
          >
            <div className="mb-1 flex items-center gap-2 text-xs">
              <span className="font-medium" style={{ color: color ?? "var(--color-accent)" }}>
                {zone?.name ?? fallbackName}
              </span>
              {zone?.model && (
                <span className="truncate text-[var(--color-text-muted)]">{zone.model}</span>
              )}
            </div>

            {showCollapsed ? (
              <span className="text-xs italic text-[var(--color-text-muted)]">
                Response collapsed
              </span>
            ) : editing ? (
              (() => {
                const idx = lastTextBlockIndex(blocks);
                const finalText =
                  idx >= 0
                    ? (blocks[idx] as Extract<TurnBlock, { kind: "text" }>).text
                    : text;
                return (
                  <div className="flex flex-col gap-2">
                    {idx >= 0 && (
                      <TurnBody
                        blocks={blocks.filter((_, i) => i !== idx)}
                        isStreaming={false}
                        chatId={chatId}
                      />
                    )}
                    <AssistantEditor
                      initial={finalText}
                      onCancel={() => setEditing(false)}
                      onSave={async (next) => {
                        await editMessage(chatId, actionMessageId, next);
                        setEditing(false);
                      }}
                    />
                  </div>
                );
              })()
            ) : hasContent || isStreaming ? (
              <>
                <TurnBody
                  blocks={blocks}
                  isStreaming={isStreaming}
                  chatId={chatId}
                  citations={citations}
                />
                {statusLine}
                {!isStreaming && <CitationSources used={citations} all={allCitations} />}
              </>
            ) : (
              <span className="text-xs italic text-[var(--color-text-muted)]">No response.</span>
            )}
          </div>

          {!isStreaming && !editing && (text || hasContent) && (
            <div className="msg-actions pl-3">
              <MessageActions
                text={text}
                messageId={actionMessageId}
                chatId={chatId}
                variant="perspective"
                regenerateZoneId={regenerateZoneId}
                canRegenerate={canRegenerate}
                branchFromMessageId={branchFromMessageId}
                branchSolo={branchSolo}
                branchSoloZoneId={branchSoloZoneId}
                onEdit={text || hasContent ? () => setEditing(true) : undefined}
                edited={edited}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
