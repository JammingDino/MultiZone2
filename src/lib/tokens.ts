/**
 * Token estimation shared across the UI.
 *
 * We don't have exact tokenizer counts for arbitrary local models, so counts
 * are estimated from character length (~4 chars/token, the usual rule of
 * thumb). The same estimator is used for the per-message readout and the
 * whole-chat context meter so the two stay consistent.
 *
 * This measures **context**: how large the conversation is right now, which is
 * what the next request will carry. It is not what a provider bills, and the
 * two are far apart — every step of an agentic turn re-sends the whole context
 * and is charged for it, so a fifty-step session is billed fifty contexts. What
 * was actually sent is counted on each request as it goes out, in the backend
 * (`llm::tokens`), and reaches the UI as `SessionUsage.spent`.
 */

import type { ContentPart, Message, ToolCall } from "./types";

/** Rough chars→tokens estimate. Returns 0 for empty input, min 1 otherwise. */
export function estimateTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.round(chars / 4));
}

/** Flat per-image token estimate — an image part carries no text to measure,
 *  but it still occupies context. A conservative mid-range tile cost. */
const IMAGE_TOKEN_ESTIMATE = 1000;

/** Chars in the text-bearing parts of a JSON-encoded ContentPart[]. Images are
 *  returned separately as a count (they have no chars to sum). */
function contentChars(json: string): { chars: number; images: number } {
  try {
    const parts = JSON.parse(json) as ContentPart[];
    if (!Array.isArray(parts)) return { chars: json.length, images: 0 };
    let chars = 0;
    let images = 0;
    for (const p of parts) {
      if (p.type === "text" || p.type === "hidden_text") chars += p.text.length;
      else if (p.type === "image_url" || p.type === "hidden_image") images += 1;
    }
    return { chars, images };
  } catch {
    return { chars: json.length, images: 0 };
  }
}

function toolCallChars(json: string | null): number {
  if (!json) return 0;
  try {
    const calls = JSON.parse(json) as ToolCall[];
    if (!Array.isArray(calls)) return json.length;
    return calls.reduce(
      (n, c) => n + (c.function?.name?.length ?? 0) + (c.function?.arguments?.length ?? 0),
      0,
    );
  } catch {
    return json.length;
  }
}

export interface ContextEstimate {
  /** Tokens the model read but did not generate: user text, tool results,
   *  attachment/file text, images. */
  inputTokens: number;
  /** Tokens the model generated: assistant answers, reasoning, tool-call args. */
  outputTokens: number;
  /** inputTokens + outputTokens — the whole conversation's context size. */
  totalTokens: number;
}

/**
 * Estimate the current context size of a chat from its persisted messages.
 * "Input" is everything the model reads (user turns, tool responses, uploaded
 * file text, images); "output" is everything it generated (answers, thinking,
 * and the tool calls it emitted).
 */
export function chatContextEstimate(messages: Message[]): ContextEstimate {
  let inputChars = 0;
  let outputChars = 0;
  let images = 0;

  for (const m of messages) {
    const { chars, images: imgs } = contentChars(m.content);
    images += imgs;
    if (m.role === "assistant") {
      outputChars += chars + (m.reasoning?.length ?? 0) + toolCallChars(m.toolCalls);
    } else {
      // user, tool (tool responses), system — all read by the model as input.
      inputChars += chars;
    }
  }

  const inputTokens = estimateTokens(inputChars) + images * IMAGE_TOKEN_ESTIMATE;
  const outputTokens = estimateTokens(outputChars);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
