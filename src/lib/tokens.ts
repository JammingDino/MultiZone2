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
  /** inputTokens + outputTokens — the size of the conversation half of the next
   *  request, after any compaction. */
  totalTokens: number;
  /** What a compaction is currently taking out, or null if none is in effect.
   *  This is the evidence that one did anything: without it the meter reports
   *  the same figure before and after, and the user has no way to tell. */
  compacted: CompactionSaving | null;
}

export interface CompactionSaving {
  /** Messages replaced by the summary in the request — still on screen, and
   *  still in the database. */
  messages: number;
  /** What the summary itself costs, since it is not free. */
  summaryTokens: number;
  /** Conversation tokens before the compaction, so the pair reads as a before
   *  and after rather than as one number without a reference. */
  wasTokens: number;
  /** wasTokens minus what is carried now. Negative is possible and is left
   *  signed — a summary longer than the turns it replaced is worth seeing, not
   *  worth hiding. */
  savedTokens: number;
}

/**
 * The chat fields that describe a compaction, as the meter receives them.
 *
 * Named separately from `Chat` so this module stays free of the store's shape
 * and can be tested with two literals.
 */
export interface CompactionState {
  contextSummary: string | null;
  contextSummaryThrough: number | null;
}

/**
 * Characters the summary carries beyond its own text.
 *
 * `compacted_prefix` in the backend wraps the model's summary in a standing
 * `# Conversation so far` preamble before sending it, and that preamble is part
 * of what the request pays for. Mirrored as a constant rather than duplicated
 * as a string: the exact wording is the backend's business, its rough size is
 * this module's, and a constant cannot drift into a second copy of the prose.
 */
const SUMMARY_PREAMBLE_CHARS = 330;

/** The running sums for one set of messages, before they become an estimate. */
function tally(messages: Message[]): { inputTokens: number; outputTokens: number } {
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

  return {
    inputTokens: estimateTokens(inputChars) + images * IMAGE_TOKEN_ESTIMATE,
    outputTokens: estimateTokens(outputChars),
  };
}

/**
 * Estimate the context a chat's next request will carry, from its messages.
 * "Input" is everything the model reads (user turns, tool responses, uploaded
 * file text, images); "output" is everything it generated (answers, thinking,
 * and the tool calls it emitted).
 *
 * **Compaction is applied here** (0.17.6), because it is applied on the way out.
 * The meter used to sum every message in the store, so a chat that had just
 * condensed forty turns reported exactly the number it reported before — the
 * one moment the reading matters most, and the one moment it was furthest from
 * what the model would receive. The rule mirrors `build_history` in
 * `commands/messages.rs`: messages at or before the cutoff are replaced by the
 * summary, which is itself sent as a system message and counted as input, and a
 * cutoff that elides nothing is not a compaction at all.
 */
export function chatContextEstimate(
  messages: Message[],
  compaction?: CompactionState | null,
): ContextEstimate {
  const full = tally(messages);
  const summary = compaction?.contextSummary?.trim();
  const through = compaction?.contextSummaryThrough ?? null;

  const kept = summary && through !== null
    ? messages.filter((m) => m.createdAt > through)
    : messages;

  // A cutoff older than every surviving message elides nothing, and the backend
  // declines to inject the summary in that case — so neither does this.
  if (!summary || through === null || kept.length === messages.length) {
    return {
      inputTokens: full.inputTokens,
      outputTokens: full.outputTokens,
      totalTokens: full.inputTokens + full.outputTokens,
      compacted: null,
    };
  }

  const summaryTokens = estimateTokens(summary.length + SUMMARY_PREAMBLE_CHARS);
  const live = tally(kept);
  const inputTokens = live.inputTokens + summaryTokens;
  const outputTokens = live.outputTokens;
  const totalTokens = inputTokens + outputTokens;
  const wasTokens = full.inputTokens + full.outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    compacted: {
      messages: messages.length - kept.length,
      summaryTokens,
      wasTokens,
      savedTokens: wasTokens - totalTokens,
    },
  };
}
