import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Network,
  Crown,
  Loader2,
  MessageSquare,
} from "lucide-react";
import type { ContentPart, Message, SubchatNode } from "@/lib/types";
import type { TurnBlock } from "@/lib/grouping";
import { useApp } from "@/store/app";
import { getZoneIcon } from "@/lib/zoneIcons";
import { usePersistentBool } from "@/lib/uiState";
import { Markdown } from "@/components/Renderers/Markdown";
import * as api from "@/lib/tauri";

/** Concatenated text of a stored message content JSON (array of content parts). */
function contentText(json: string): string {
  try {
    const parts = JSON.parse(json) as ContentPart[];
    if (!Array.isArray(parts)) return json;
    return parts
      .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
  } catch {
    return json;
  }
}

/** Pull `subchat_id` out of a `spawn_subagent` tool-result message content. */
function subchatIdFromResult(content: string): string | null {
  try {
    const obj = JSON.parse(contentText(content));
    return typeof obj?.subchat_id === "string" ? obj.subchat_id : null;
  } catch {
    return null;
  }
}

/**
 * The subchat ids spawned in a single assistant turn, read from its
 * `spawn_subagent` tool steps. These are the trace's direct roots for the turn;
 * nesting is filled in from the call tree. Persists across reloads because it's
 * derived from the persisted tool-result messages.
 */
export function spawnedSubchatIdsFromBlocks(blocks: TurnBlock[]): string[] {
  const ids: string[] = [];
  for (const b of blocks) {
    if (b.kind !== "step" || b.step.kind !== "tool") continue;
    if (b.step.toolCall.function.name !== "spawn_subagent") continue;
    const result = b.step.toolResult;
    if (!result) continue;
    const id = subchatIdFromResult(result.content);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Inline stack-trace block for a leader turn (0.6.1). Collapsible, styled like a
 * thinking block. Shows the leader→sub-agent(→nested) call tree; each node
 * carries the zone avatar, name, and message count, and expands to reveal that
 * subchat's transcript inline. Renders nothing when the turn spawned no
 * sub-agents.
 */
export function StackTrace({
  chatId,
  spawnedIds,
  leaderZoneId,
}: {
  chatId: string;
  spawnedIds: string[];
  leaderZoneId: string | null;
}) {
  // Whether this turn's stack trace is expanded persists across sessions, keyed
  // by the turn's first spawned subchat id (stable + unique per leader turn).
  const [open, setOpen] = usePersistentBool(`stacktrace:${chatId}:${spawnedIds[0] ?? ""}`, false);
  const [nodes, setNodes] = useState<SubchatNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const leaderZone = useApp((s) => s.zones.find((z) => z.id === leaderZoneId));

  // Lazily fetch the call tree the first time the block is opened.
  useEffect(() => {
    if (!open || nodes || loading) return;
    setLoading(true);
    api
      .getSubchatTree(chatId)
      .then(setNodes)
      .catch((e) => console.error("get_subchat_tree failed:", e))
      .finally(() => setLoading(false));
  }, [open, chatId, nodes, loading]);

  // parentChatId → child nodes, for reconstructing nesting.
  const childMap = useMemo(() => {
    const m = new Map<string, SubchatNode[]>();
    for (const n of nodes ?? []) {
      if (!n.parentChatId) continue;
      const arr = m.get(n.parentChatId) ?? [];
      arr.push(n);
      m.set(n.parentChatId, arr);
    }
    return m;
  }, [nodes]);

  if (spawnedIds.length === 0) return null;

  // Direct children of this turn: subchats parented to this chat that the turn
  // actually spawned (scopes the trace to this turn when the chat has several).
  const roots = (childMap.get(chatId) ?? []).filter((n) => spawnedIds.includes(n.id));
  const LeaderIcon = getZoneIcon(leaderZone?.icon);
  const leaderColor = leaderZone?.accentColor ?? null;

  return (
    <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-panel-hover)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Network size={12} className="text-amber-500" />
        <span className="text-[var(--color-text-muted)]">
          Stack trace ·{" "}
          <span className="text-[var(--color-text)]">
            {spawnedIds.length} sub-agent{spawnedIds.length > 1 ? "s" : ""}
          </span>
        </span>
        {loading && (
          <Loader2 size={12} className="ml-auto animate-spin text-[var(--color-text-muted)]" />
        )}
      </button>

      {open && (
        <div className="border-t border-[var(--color-border)] p-2">
          {/* Leader root node */}
          <div className="flex items-center gap-2 px-1 py-1 text-xs">
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
              style={{ background: leaderColor ?? "var(--color-accent)" }}
            >
              <LeaderIcon size={11} color="white" />
            </span>
            <span className="font-medium text-[var(--color-text)]">
              {leaderZone?.name ?? "Leader"}
            </span>
            <Crown size={11} className="text-amber-500" />
            <span className="text-[var(--color-text-muted)]">leader</span>
          </div>

          {/* The call tree */}
          <div className="ml-2.5 border-l border-[var(--color-border)] pl-3">
            {nodes === null ? (
              <div className="py-1 text-xs text-[var(--color-text-muted)]">Loading…</div>
            ) : roots.length === 0 ? (
              <div className="py-1 text-xs text-[var(--color-text-muted)]">
                No sub-agent records found.
              </div>
            ) : (
              roots.map((n) => (
                <SubchatNodeRow key={n.id} node={n} childMap={childMap} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One node in the call tree: a sub-agent subchat, with its nested children
 * below and a click-to-expand inline transcript. */
function SubchatNodeRow({
  node,
  childMap,
}: {
  node: SubchatNode;
  childMap: Map<string, SubchatNode[]>;
}) {
  // Each subchat row remembers whether its transcript is open, keyed by the
  // globally-unique subchat id, so the view is restored next session.
  const [expanded, setExpanded] = usePersistentBool(`subchat:${node.id}`, false);
  const zone = useApp((s) => s.zones.find((z) => z.id === node.zoneId));
  const ZoneIcon = getZoneIcon(zone?.icon);
  const color = zone?.accentColor ?? null;
  const children = childMap.get(node.id) ?? [];

  return (
    <div className="py-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        title={expanded ? "Hide transcript" : "Show transcript"}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-[var(--color-panel-hover)]"
      >
        {expanded ? (
          <ChevronDown size={11} className="shrink-0 text-[var(--color-text-muted)]" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-[var(--color-text-muted)]" />
        )}
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
          style={{ background: color ?? "var(--color-accent)" }}
        >
          <ZoneIcon size={11} color="white" />
        </span>
        <span className="truncate font-medium text-[var(--color-text)]">
          {zone?.name ?? node.title}
        </span>
        {zone?.isLeader && <Crown size={10} className="shrink-0 text-amber-500" />}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[var(--color-text-muted)]">
          <MessageSquare size={10} />
          {node.messageCount}
        </span>
      </button>

      {expanded && <SubchatTranscript subchatId={node.id} />}

      {children.length > 0 && (
        <div className="ml-2.5 border-l border-[var(--color-border)] pl-3">
          {children.map((c) => (
            <SubchatNodeRow key={c.id} node={c} childMap={childMap} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Lazily-loaded inline transcript of a subchat — its primary user/assistant
 * turns. User turns are the leader's prompts; assistant turns are the
 * sub-agent's answers. */
function SubchatTranscript({ subchatId }: { subchatId: string }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getMessages(subchatId)
      .then((m) => {
        if (alive) setMessages(m);
      })
      .catch((e) => {
        console.error("load subchat transcript failed:", e);
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [subchatId]);

  if (error) {
    return (
      <div className="my-1 ml-7 text-xs text-[var(--color-text-muted)]">
        Could not load transcript.
      </div>
    );
  }
  if (messages === null) {
    return (
      <div className="my-1 ml-7 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
        <Loader2 size={11} className="animate-spin" /> Loading transcript…
      </div>
    );
  }

  // Primary conversation only (skip perspective/zone-scoped rows); the
  // user/assistant alternation is the leader↔sub-agent exchange.
  const turns = messages.filter(
    (m) => !m.zoneId && (m.role === "user" || m.role === "assistant"),
  );

  if (turns.length === 0) {
    return (
      <div className="my-1 ml-7 text-xs italic text-[var(--color-text-muted)]">
        No turns yet.
      </div>
    );
  }

  return (
    <div className="my-1 ml-7 flex flex-col gap-2 border-l border-[var(--color-border)] pl-3">
      {turns.map((m) => {
        const text = contentText(m.content);
        if (!text.trim()) return null;
        const isPrompt = m.role === "user";
        return (
          <div key={m.id} className="text-xs">
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              {isPrompt ? "Prompt from leader" : "Sub-agent"}
            </div>
            {isPrompt ? (
              <div className="whitespace-pre-wrap break-words text-[var(--color-text-muted)]">
                {text}
              </div>
            ) : (
              <div className="leading-relaxed">
                <Markdown source={text} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
