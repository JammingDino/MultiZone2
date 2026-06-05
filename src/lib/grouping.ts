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
  messageId: string;
  text: string;
  reasoning: string | null;
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

function newTurn(): BotTurn {
  return { type: "bot", messageIds: [], blocks: [], perspectives: [] };
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
  let turn: BotTurn | null = null;

  for (const m of primaryMsgs) {
    if (m.role === "user") {
      if (turn) {
        units.push(turn);
        turn = null;
      }
      units.push({ type: "user", message: m });
      continue;
    }
    if (m.role === "system") continue;

    if (m.role === "assistant") {
      if (turn === null) turn = newTurn();
      const t: BotTurn = turn;
      t.messageIds.push(m.id);
      const text = extractText(m.content);
      const calls = parseToolCalls(m.toolCalls);

      // Emit blocks in the order the model produced them: reasoning → text → tool calls.
      if (m.reasoning && m.reasoning.trim()) {
        t.blocks.push({
          kind: "step",
          step: {
            kind: "thinking",
            key: `${m.id}:thinking`,
            text: m.reasoning,
            streaming: false,
          },
        });
      }
      if (text) {
        t.blocks.push({ kind: "text", text });
      }
      for (const tc of calls) {
        t.blocks.push({
          kind: "step",
          step: {
            kind: "tool",
            key: `${m.id}:${tc.id}`,
            toolCall: tc,
            toolResult: null,
            pending: false,
          },
        });
      }
    } else if (m.role === "tool" && turn !== null) {
      const t: BotTurn = turn;
      // Attach the tool result to its matching pending ToolStep block.
      for (const block of t.blocks) {
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

  if (streaming) {
    if (turn === null) turn = newTurn();
    const t: BotTurn = turn;
    t.streaming = streaming;

    if (streaming.reasoning) {
      t.blocks.push({
        kind: "step",
        step: {
          kind: "thinking",
          key: `streaming:${streaming.messageId}:thinking`,
          text: streaming.reasoning,
          streaming: true,
        },
      });
    }
    if (streaming.content) {
      t.blocks.push({ kind: "text", text: streaming.content, streaming: true });
    }
    for (const pt of streaming.pendingTools) {
      t.blocks.push({
        kind: "step",
        step: {
          kind: "tool",
          key: `streaming:${streaming.messageId}:${pt.index}`,
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

  if (turn) units.push(turn);

  // ── Attach persisted perspective messages to their user turns ──────────────
  const userTimestamps: number[] = units
    .filter((u): u is UserUnit => u.type === "user")
    .map((u) => u.message.createdAt);

  const perspByTurnIdx = new Map<number, PerspectiveTurn[]>();
  for (const pm of perspMsgs) {
    if (pm.role !== "assistant" || !pm.zoneId) continue;
    let turnIdx = -1;
    for (let i = userTimestamps.length - 1; i >= 0; i--) {
      if (pm.createdAt >= userTimestamps[i]) {
        turnIdx = i;
        break;
      }
    }
    if (turnIdx < 0) continue;

    const list = perspByTurnIdx.get(turnIdx) ?? [];
    const text = extractText(pm.content);
    const existing = list.find((p) => p.zoneId === pm.zoneId);
    if (existing) {
      if (text) existing.text = existing.text ? `${existing.text}\n\n${text}` : text;
    } else {
      list.push({
        zoneId: pm.zoneId,
        messageId: pm.id,
        text,
        reasoning: pm.reasoning ?? null,
      });
    }
    perspByTurnIdx.set(turnIdx, list);
  }

  let userIdx = 0;
  for (const unit of units) {
    if (unit.type === "user") {
      userIdx++;
    } else if (unit.type === "bot") {
      const saved = perspByTurnIdx.get(userIdx - 1) ?? [];
      unit.perspectives = saved;
    }
  }

  // ── Attach active streaming perspectives to the last BotTurn ────────────────
  if (Object.keys(perspectiveStreams).length > 0) {
    const lastBot = [...units].reverse().find((u): u is BotTurn => u.type === "bot");
    if (lastBot) {
      for (const [zoneId, streamState] of Object.entries(perspectiveStreams)) {
        const existing = lastBot.perspectives.find((p) => p.zoneId === zoneId);
        if (existing) {
          existing.streaming = streamState;
          if (streamState.content && !existing.text.includes(streamState.content)) {
            existing.text = streamState.content;
          }
          if (streamState.reasoning) existing.reasoning = streamState.reasoning;
        } else {
          lastBot.perspectives.push({
            zoneId,
            messageId: streamState.messageId,
            text: streamState.content,
            reasoning: streamState.reasoning || null,
            streaming: streamState,
          });
        }
      }
    }
  }

  return units;
}
