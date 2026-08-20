// The known sequence, and the check that says whether it arrived intact.
//
// "No dropped tokens under sustained use" sat open through eight releases
// because watching a stream cannot establish it. A stream of *numbered* tokens
// can: generate `0001 0002 0003 …`, reassemble whatever the app stored, and
// diff. A gap stops being a feeling about the UI and becomes an index.
//
// Pure and dependency-free on purpose — it is imported by the mock provider,
// by the unit tests, and by the soak driver that runs against a live app.

/** Width of the token counter. 4 digits carries 9999 tokens per stream; past
 *  that the width grows, which is fine — the parser reads whatever it is given. */
const PAD = 4;

/** One token as it appears in the stream, e.g. `0042`. */
export function token(n) {
  return String(n).padStart(PAD, "0");
}

/**
 * The full expected text for a stream of `count` tokens.
 *
 * Tokens are space-separated because a provider's tokens arrive as fragments
 * that concatenate; the separator is what makes a *dropped* token distinguish-
 * able from a *merged* one when reading the result by eye.
 */
export function expectedText(count) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(token(i));
  return out.join(" ");
}

/**
 * The individual deltas the mock sends. Each token goes out as its own SSE
 * chunk with its trailing space, so the transport is exercised once per token
 * rather than once per buffer-full.
 */
export function deltas(count) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(i === count ? token(i) : token(i) + " ");
  return out;
}

/**
 * Compare received text against the sequence that was sent.
 *
 * Returns `{ ok, received, expected, firstGap, missing, disordered, extra }`.
 * `firstGap` is the index of the first token that is absent or out of place —
 * the one number worth putting in a failure message.
 *
 * Deliberately tolerant about *surrounding* text: a model's answer may carry a
 * preamble, and a turn may append its own wrapper. Only the numeric tokens are
 * extracted, so the check measures the transport rather than the prose.
 */
export function verifySequence(text, count) {
  const found = String(text ?? "").match(/\b\d{4,}\b/g) ?? [];
  const nums = found.map((s) => Number(s));

  const seen = new Set(nums);
  const missing = [];
  for (let i = 1; i <= count; i++) if (!seen.has(i)) missing.push(i);

  // Out of order is a different bug from missing — it means chunks were
  // reassembled in the wrong sequence rather than lost — so it is reported
  // separately instead of both being called "dropped".
  const disordered = [];
  for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) disordered.push(nums[i]);

  const extra = nums.filter((n) => n < 1 || n > count);

  const firstGap = missing.length > 0 ? missing[0] : disordered.length > 0 ? disordered[0] : null;

  return {
    ok: missing.length === 0 && disordered.length === 0 && extra.length === 0,
    received: nums.length,
    expected: count,
    firstGap,
    missing,
    disordered,
    extra,
  };
}

/** A one-line failure message naming the index, for a test or a CLI. */
export function describe(result) {
  if (result.ok) return `all ${result.expected} tokens arrived in order`;
  const parts = [`${result.received}/${result.expected} tokens`];
  if (result.missing.length) {
    const head = result.missing.slice(0, 10).map(token).join(", ");
    parts.push(
      `${result.missing.length} missing (first: ${token(result.missing[0])}${
        result.missing.length > 10 ? `; ${head}, …` : result.missing.length > 1 ? `; ${head}` : ""
      })`,
    );
  }
  if (result.disordered.length) {
    parts.push(`${result.disordered.length} out of order (first: ${token(result.disordered[0])})`);
  }
  if (result.extra.length) parts.push(`${result.extra.length} unexpected`);
  return parts.join(" — ");
}
