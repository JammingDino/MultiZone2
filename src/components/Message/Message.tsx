import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentPart, Message, InputPart } from "@/lib/types";
import { Markdown } from "@/components/Renderers/Markdown";
import { User, Check, X, FileType, ZoomIn } from "lucide-react";
import { StepBlock } from "./StepBlock";
import { MessageActions } from "./MessageActions";
import { CitationSources } from "./CitationSources";
import { StackTrace, spawnedSubchatIdsFromBlocks } from "./StackTrace";
import type { BotTurn, PerspectiveTurn, TurnBlock } from "@/lib/grouping";
import { collectCitations, matchedCitations, type Citation, type FileSource } from "@/lib/citations";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { getZoneIcon } from "@/lib/zoneIcons";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Throttles a streaming text source so the Markdown renderer (which re-parses
 * the entire AST on every prop change, plus KaTeX) doesn't fire on every
 * token. We push the latest value to the renderer on a fixed interval while
 * `streaming` is true, and flush immediately the moment it flips to false.
 */
const STREAM_MARKDOWN_THROTTLE_MS = 80;

function useThrottledStreaming(source: string, streaming: boolean): string {
  const [visible, setVisible] = useState(source);
  const latestRef = useRef(source);
  latestRef.current = source;

  useEffect(() => {
    if (!streaming) {
      setVisible(latestRef.current);
      return;
    }
    setVisible(latestRef.current);
    const id = window.setInterval(
      () => setVisible(latestRef.current),
      STREAM_MARKDOWN_THROTTLE_MS,
    );
    return () => window.clearInterval(id);
  }, [streaming]);

  return visible;
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

type PdfAttachment =
  | { fileName: string; mode: "images"; pages: string[] }
  | { fileName: string; mode: "text"; text: string };

function parsePdfAttachments(parts: ContentPart[]): PdfAttachment[] {
  const result: PdfAttachment[] = [];
  let current: { fileName: string; pages: string[] } | null = null;

  for (const p of parts) {
    if (p.type === "hidden_text") {
      if (current) { result.push({ ...current, mode: "images" }); current = null; }

      const imgMatch = p.text.match(/^\[Attached PDF: (.+) — \d+ pages follow as images\]$/);
      if (imgMatch) { current = { fileName: imgMatch[1], pages: [] }; continue; }

      const txtMatch = p.text.match(/^File: (.+) \(PDF, extracted text\)\n```\n([\s\S]*?)\n```$/);
      if (txtMatch) result.push({ fileName: txtMatch[1], mode: "text", text: txtMatch[2] });
    } else if (p.type === "hidden_image" && current) {
      current.pages.push(p.image_url.url);
    } else if (p.type !== "hidden_image") {
      if (current) { result.push({ ...current, mode: "images" }); current = null; }
    }
  }
  if (current) result.push({ ...current, mode: "images" });
  return result;
}

/**
 * File attachments from the primary user message that opened this turn's round,
 * surfaced as citation sources (0.4.1). PDFs carry a page count; other file types
 * aren't reliably named in the stored message parts, so only PDFs are returned.
 */
function deriveFileSources(messages: Message[], firstTurnMsgId: string | undefined): FileSource[] {
  if (!firstTurnMsgId) return [];
  let user: Message | null = null;
  for (const m of messages) {
    if (m.id === firstTurnMsgId) break;
    if (m.role === "user" && !m.zoneId) user = m;
  }
  if (!user) return [];
  return parsePdfAttachments(parseParts(user.content)).map((p) => ({
    fileName: p.fileName,
    pages: p.mode === "images" ? p.pages.length : undefined,
  }));
}

type MessagePreview =
  | { kind: "image"; url: string }
  | { kind: "pdf-images"; fileName: string; pages: string[] }
  | { kind: "pdf-text"; fileName: string; text: string };

export function UserMessage({ message }: { message: Message }) {
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
  const pdfAttachments = parsePdfAttachments(parts);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [preview, setPreview] = useState<MessagePreview | null>(null);
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

  async function commitEdit() {
    const next = draft.trim();
    if (!next || next === text.trim()) {
      setEditing(false);
      setDraft(text);
      return;
    }
    setEditing(false);
    try {
      await api.deleteMessagesFrom(message.chatId, message.id);
      await loadMessages(message.chatId);
      const parts: InputPart[] = [{ type: "text", text: next }];
      for (const img of images) {
        parts.push({ type: "image", data_url: img.image_url.url });
      }
      await api.sendMessage(message.chatId, parts);
      refreshChats();
    } catch (e) {
      console.error(e);
    }
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
          {pdfAttachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {pdfAttachments.map((pdf, i) => (
                <button
                  key={i}
                  onClick={() =>
                    setPreview(
                      pdf.mode === "images"
                        ? { kind: "pdf-images", fileName: pdf.fileName, pages: pdf.pages }
                        : { kind: "pdf-text", fileName: pdf.fileName, text: pdf.text },
                    )
                  }
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-hover)]"
                  title="Click to preview"
                >
                  <FileType size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="max-w-[180px] truncate">{pdf.fileName}</span>
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
          branchFromMessageId={message.id}
        />
      </div>
      {preview && (
        <MessagePreviewModal preview={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function MessagePreviewModal({
  preview,
  onClose,
}: {
  preview: MessagePreview;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

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
  let stepIdx = 0;
  const blockElements = blocks.map((block, i) => {
    if (block.kind === "text") {
      return (
        <TextBlockView
          key={`text-${i}`}
          text={block.text}
          streaming={!!block.streaming}
          citations={citations}
        />
      );
    }
    stepIdx += 1;
    return <StepBlock key={block.step.key} step={block.step} index={stepIdx} chatId={chatId} />;
  });
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

/** Index of the last text block in a turn (the final answer), or -1 if none. */
function lastTextBlockIndex(blocks: TurnBlock[]): number {
  let idx = -1;
  blocks.forEach((b, i) => {
    if (b.kind === "text") idx = i;
  });
  return idx;
}

export function BotTurnView({ turn, isLatest = false }: { turn: BotTurn; isLatest?: boolean }) {
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
  const allCitations = useMemo(
    () => collectCitations(turn.blocks, fileSources),
    [turn.blocks, fileSources],
  );
  const citations = useMemo(
    () => matchedCitations(allCitations, turn.blocks),
    [allCitations, turn.blocks],
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
            fileSources={fileSources}
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
              fileSources={fileSources}
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
  fileSources,
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
  fileSources?: FileSource[];
}) {
  const allCitations = useMemo(
    () => collectCitations(blocks, fileSources ?? []),
    [blocks, fileSources],
  );
  const citations = useMemo(
    () => matchedCitations(allCitations, blocks),
    [allCitations, blocks],
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
              {isStreaming && (
                <span className="animate-pulse text-[var(--color-text-muted)]">generating…</span>
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
