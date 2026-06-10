import { useEffect, useRef, useState } from "react";
import type { ContentPart, Message, InputPart } from "@/lib/types";
import { Markdown } from "@/components/Renderers/Markdown";
import { User, Check, X, FileType, ZoomIn } from "lucide-react";
import { StepBlock } from "./StepBlock";
import { MessageActions } from "./MessageActions";
import type { BotTurn, PerspectiveTurn, TurnBlock } from "@/lib/grouping";
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
function TextBlockView({ text, streaming }: { text: string; streaming: boolean }) {
  const visible = useThrottledStreaming(text, streaming);
  return (
    <div>
      <Markdown source={visible} />
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
        <div className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded bg-[var(--color-accent)]">
          <User size={14} />
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
        <div className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded bg-[var(--color-accent)]">
          <User size={14} />
        </div>
      </div>
      <div className="msg-actions">
        <MessageActions
          text={text}
          chatId={message.chatId}
          variant="user"
          onEdit={() => setEditing(true)}
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

export function BotTurnView({ turn }: { turn: BotTurn }) {
  const isStreaming = Boolean(turn.streaming);
  const hasAnything = turn.blocks.length > 0 || isStreaming;

  const chatId = useApp((s) => s.activeChatId) ?? "";
  const zone = useApp((s) => {
    const chat = s.chats.find((c) => c.id === chatId);
    return chat ? s.zones.find((z) => z.id === chat.zoneId) : null;
  });

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

  // Build ordered block elements, tracking step index for labelling.
  let stepIdx = 0;
  const blockElements = turn.blocks.map((block, i) => {
    if (block.kind === "text") {
      return (
        <TextBlockView
          key={`text-${i}`}
          text={block.text}
          streaming={!!block.streaming}
        />
      );
    }
    stepIdx += 1;
    return (
      <StepBlock
        key={block.step.key}
        step={block.step}
        index={stepIdx}
        chatId={chatId}
      />
    );
  });

  return (
    <div className="msg-row">
      <div className="flex gap-3">
        <div
          className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded shadow-sm"
          style={{ background: zoneColor ?? "var(--color-panel)" }}
        >
          <ZoneIcon size={14} color={zoneColor ? "white" : "var(--color-text-muted)"} />
        </div>
        <div
          className="flex-1 min-w-0 overflow-hidden border-l-2 pl-3"
          style={{
            borderColor: zoneColor
              ? `${zoneColor}55`
              : "color-mix(in srgb, var(--color-accent) 33%, transparent)",
          }}
        >
          {blockElements.length > 0 && (
            <div className="flex flex-col gap-2">
              {blockElements}
            </div>
          )}
          {isStreaming && turn.blocks.length === 0 && (
            <span className="animate-pulse text-[var(--color-text-muted)]">▌</span>
          )}
        </div>
      </div>
      {!isStreaming && chatId && pivotMessageId && (
        <div className="msg-actions">
          <MessageActions
            text={allText}
            messageId={lastMessageId}
            pivotMessageId={pivotMessageId}
            chatId={chatId}
            variant="assistant"
          />
        </div>
      )}
      {turn.perspectives.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 pl-10">
          {turn.perspectives.map((p) => (
            <PerspectivePanelView key={p.zoneId} persp={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function PerspectivePanelView({ persp }: { persp: PerspectiveTurn }) {
  const [expanded, setExpanded] = useState(true);
  const isStreaming = Boolean(persp.streaming);
  const zone = useApp((s) => s.zones.find((z) => z.id === persp.zoneId));
  const ZoneIcon = getZoneIcon(zone?.icon);
  const color = zone?.accentColor ?? "var(--color-accent)";
  const visibleText = useThrottledStreaming(persp.text, isStreaming);

  return (
    <div
      className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
      style={{ borderLeftColor: color, borderLeftWidth: 2 }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--color-panel-hover)]"
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
          style={{ background: color }}
        >
          <ZoneIcon size={10} color="white" />
        </span>
        <span className="font-medium" style={{ color }}>{zone?.name ?? persp.zoneId}</span>
        {isStreaming && (
          <span className="ml-auto animate-pulse text-[var(--color-text-muted)]">generating…</span>
        )}
      </button>
      {expanded && (
        <div className="px-4 pb-3 pt-1 text-sm">
          {persp.reasoning && (
            <div className="mb-2 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 font-mono text-xs text-[var(--color-text-muted)] opacity-70">
              {persp.reasoning}
            </div>
          )}
          {visibleText ? (
            <Markdown source={visibleText} />
          ) : isStreaming ? (
            <span className="animate-pulse text-[var(--color-text-muted)]">▌</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
