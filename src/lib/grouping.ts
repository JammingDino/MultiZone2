import type { ContentPart, Message, ToolCall } from "@/lib/types";
import type { StreamingState } from "@/store/app";

export type Step = ThinkingStep | ToolStep;

export interface ThinkingStep {
  kind: "thinking";
  key: string;
  text: string;
  /** True while reasoning content is actively streaming. */
  streaming: boolean;
}

export interface ToolStep {
  kind: "tool";
  /** Stable identity for React keys: assistant message id + tool_call id. */
  key: string;
  /** Assistant message that issued the call — needed to write a fix back to it. */
  messageId: string;
  toolCall: ToolCall;
  toolResult: Message | null;
  /** True while the tool is being constructed by streaming deltas. */
  pending: boolean;
}

/** A single ordered item in a bot turn — either a text chunk or a step (thinking/tool). */
export type TurnBlock =
  | { kind: "text"; text: string; streaming?: boolean }
  | { kind: "step"; step: Step };

export interface PerspectiveTurn {
  zoneId: string;
  /** Last assistant message id in the turn (for copy/regenerate targeting). */
  messageId: string;
  /** All assistant message ids in this perspective turn, ordered. */
  messageIds: string[];
  /** Ordered text/step blocks — identical structure to the primary turn. */
  blocks: TurnBlock[];
  /** Combined plain text of the answer (for the copy action). */
  text: string;
  streaming?: StreamingState;
}

export interface BotTurn {
  type: "bot";
  /** All assistant message ids in this turn, ordered. */
  messageIds: string[];
  /** Ordered sequence of text chunks and steps, preserving the model's actual output order. */
  blocks: TurnBlock[];
  streaming?: StreamingState;
  /** Perspective zone responses attached to this turn. */
  perspectives: PerspectiveTurn[];
  /** The zone that answered this turn (from the first assistant message's activeZoneId). */
  zoneId: string | null;
}

export interface UserUnit {
  type: "user";
  message: Message;
}

export type RenderUnit = UserUnit | BotTurn;

function extractText(json: string): string {
  try {
    const arr = JSON.parse(json) as ContentPart[];
    if (!Array.isArray(arr)) return json;
    return arr
      .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
  } catch {
    return json;
  }
}

function parseToolCalls(json: string | null): ToolCall[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr;
  } catch {}
  return [];
}

/** Joins the text of a block list (for the copy action). */
function blocksText(blocks: TurnBlock[]): string {
  return blocks
    .filter((b): b is Extract<TurnBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n");
}

/**
 * Builds the ordered block list for one participant's turn from its persisted
 * assistant + tool messages (in chronological order). Shared by the primary
 * turn and each perspective turn so they render identically.
 */
function buildBlocks(msgs: Message[]): { blocks: TurnBlock[]; messageIds: string[] } {
  const blocks: TurnBlock[] = [];
  const messageIds: string[] = [];

  for (const m of msgs) {
    if (m.role === "assistant") {
      messageIds.push(m.id);
      // Emit blocks in the order the model produced them: reasoning → text → tools.
      if (m.reasoning && m.reasoning.trim()) {
        blocks.push({
          kind: "step",
          step: { kind: "thinking", key: `${m.id}:thinking`, text: m.reasoning, streaming: false },
        });
      }
      // Models routinely emit a couple of newlines alongside a tool call. That
      // renders as nothing, but as a block it would split the turn's steps into
      // two activity rails around an empty gap — so only real prose counts.
      const text = extractText(m.content);
      if (text.trim()) blocks.push({ kind: "text", text });
      for (const tc of parseToolCalls(m.toolCalls)) {
        blocks.push({
          kind: "step",
          step: {
            kind: "tool",
            key: `${m.id}:${tc.id}`,
            messageId: m.id,
            toolCall: tc,
            toolResult: null,
            pending: false,
          },
        });
      }
    } else if (m.role === "tool") {
      // Attach the tool result to its matching pending ToolStep block.
      for (const block of blocks) {
        if (
          block.kind === "step" &&
          block.step.kind === "tool" &&
          block.step.toolCall.id === m.toolCallId &&
          block.step.toolResult === null
        ) {
          block.step.toolResult = m;
          break;
        }
      }
    }
  }

  return { blocks, messageIds };
}

/** Appends the live streaming state (reasoning / text / pending tools) to a block list. */
function appendStreamingBlocks(blocks: TurnBlock[], streaming: StreamingState): void {
  if (streaming.reasoning) {
    blocks.push({
      kind: "step",
      step: {
        kind: "thinking",
        key: `streaming:${streaming.messageId}:thinking`,
        text: streaming.reasoning,
        streaming: true,
      },
    });
  }
  if (streaming.content.trim()) {
    blocks.push({ kind: "text", text: streaming.content, streaming: true });
  }
  for (const pt of streaming.pendingTools) {
    blocks.push({
      kind: "step",
      step: {
        kind: "tool",
        key: `streaming:${streaming.messageId}:${pt.index}`,
        messageId: streaming.messageId,
        toolCall: {
          id: `pending-${pt.index}`,
          callType: "function",
          function: { name: pt.name, arguments: pt.args },
        },
        toolResult: null,
        pending: true,
      },
    });
  }
}

export function groupMessages(
  messages: Message[],
  streaming: StreamingState | undefined,
  perspectiveStreams: Record<string, StreamingState> = {},
): RenderUnit[] {
  // Split primary (zone_id null) from perspective messages.
  const primaryMsgs = messages.filter((m) => !m.zoneId);
  const perspMsgs = messages.filter((m) => !!m.zoneId);

  const units: RenderUnit[] = [];
  // Messages collected for the bot turn currently being built.
  let turnMsgs: Message[] = [];
  let turnZoneId: string | null = null;
  let turnOpen = false;

  const flushTurn = (turnStreaming?: StreamingState) => {
    if (!turnOpen && !turnStreaming) return;
    const { blocks, messageIds } = buildBlocks(turnMsgs);
    if (turnStreaming) appendStreamingBlocks(blocks, turnStreaming);
    units.push({
      type: "bot",
      messageIds,
      blocks,
      perspectives: [],
      zoneId: turnZoneId,
      streaming: turnStreaming,
    });
    turnMsgs = [];
    turnZoneId = null;
    turnOpen = false;
  };

  for (const m of primaryMsgs) {
    if (m.role === "user") {
      flushTurn();
      units.push({ type: "user", message: m });
      continue;
    }
    if (m.role === "system") continue;
    turnOpen = true;
    turnMsgs.push(m);
    if (m.role === "assistant" && turnZoneId === null && m.activeZoneId) {
      turnZoneId = m.activeZoneId;
    }
  }
  // The trailing turn folds in any active primary stream.
  flushTurn(streaming);

  // ── Attach perspective turns (persisted) to their rounds ───────────────────
  const userTimestamps: number[] = units
    .filter((u): u is UserUnit => u.type === "user")
    .map((u) => u.message.createdAt);

  // turnIdx → zoneId → ordered messages (assistant + tool) for that participant.
  const byTurn = new Map<number, Map<string, Message[]>>();
  for (const pm of perspMsgs) {
    if (!pm.zoneId) continue;
    if (pm.role !== "assistant" && pm.role !== "tool") continue;
    let turnIdx = -1;
    for (let i = userTimestamps.length - 1; i >= 0; i--) {
      if (pm.createdAt >= userTimestamps[i]) {
        turnIdx = i;
        break;
      }
    }
    if (turnIdx < 0) continue;
    const zmap = byTurn.get(turnIdx) ?? new Map<string, Message[]>();
    const list = zmap.get(pm.zoneId) ?? [];
    list.push(pm);
    zmap.set(pm.zoneId, list);
    byTurn.set(turnIdx, zmap);
  }

  let precedingUserIdx = -1;
  for (const unit of units) {
    if (unit.type === "user") {
      precedingUserIdx++;
    } else if (unit.type === "bot") {
      const zmap = byTurn.get(precedingUserIdx);
      if (!zmap) continue;
      for (const [zoneId, msgs] of zmap.entries()) {
        const { blocks, messageIds } = buildBlocks(msgs);
        unit.perspectives.push({
          zoneId,
          messageIds,
          messageId: messageIds[messageIds.length - 1] ?? "",
          blocks,
          text: blocksText(blocks),
        });
      }
    }
  }

  // ── Attach active streaming perspectives to the last bot turn ──────────────
  if (Object.keys(perspectiveStreams).length > 0) {
    let lastBot = [...units].reverse().find((u): u is BotTurn => u.type === "bot");
    if (!lastBot) {
      // No primary turn yet this round (e.g. primary errored) — create one so
      // the streaming perspectives still have somewhere to render.
      lastBot = { type: "bot", messageIds: [], blocks: [], perspectives: [], zoneId: null };
      units.push(lastBot);
    }
    for (const [zoneId, st] of Object.entries(perspectiveStreams)) {
      let pt = lastBot.perspectives.find((p) => p.zoneId === zoneId);
      if (!pt) {
        pt = { zoneId, messageId: st.messageId, messageIds: [], blocks: [], text: "" };
        lastBot.perspectives.push(pt);
      }
      appendStreamingBlocks(pt.blocks, st);
      pt.streaming = st;
      pt.text = blocksText(pt.blocks);
    }
  }

  return units;
}
