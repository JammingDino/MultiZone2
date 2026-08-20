// Deterministic synthetic answers, for measuring how much there is to lay out.
//
// The performance item needs a chat of a stated size whose *mix* is stated too:
// a thread of 500 plain paragraphs and a thread of 500 Mermaid diagrams are not
// the same measurement. These proportions are the thing held constant across
// runs, so changing them invalidates any number taken before.
//
// Lives with the mock provider rather than the seeder because the app has no
// route that inserts a message without a turn — which is correct, and means the
// only honest way to seed is to let the real path store it. So the provider
// produces the content, exactly as a provider would.

/** mulberry32 — small, seedable, and identical between runs. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "the quick brown fox jumps over a lazy dog while the model streams tokens into a panel that has to lay them out again on every frame".split(
    " ",
  );

export function prose(rand, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  const text = out.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/** The stated mix: 55% prose, 20% code, 15% table, 10% diagram. */
export function mixedAnswer(seed) {
  const rand = rng(seed);
  const roll = rand();
  const head = prose(rand, 40 + Math.floor(rand() * 60));

  if (roll < 0.55) return `${head}\n\n${prose(rand, 30)}`;

  if (roll < 0.75) {
    return `${head}\n\n\`\`\`ts\nexport function step${seed}(input: string[]): number {\n  // ${prose(rand, 8)}\n  return input.filter((s) => s.length > ${seed % 7}).length;\n}\n\`\`\`\n\n${prose(rand, 20)}`;
  }

  if (roll < 0.9) {
    const rows = 4 + Math.floor(rand() * 6);
    let table = "| Item | Count | Note |\n| --- | --- | --- |\n";
    for (let r = 0; r < rows; r++) table += `| row ${r} | ${Math.floor(rand() * 1000)} | ${prose(rand, 4)} |\n`;
    return `${head}\n\n${table}`;
  }

  return `${head}\n\n\`\`\`mermaid\ngraph TD\n  A${seed}[start] --> B${seed}[work]\n  B${seed} --> C${seed}[done]\n\`\`\``;
}

/** A plausible user turn to sit above it. */
export function userTurn(seed) {
  const rand = rng(seed ^ 0x9e3779b9);
  return prose(rand, 8 + Math.floor(rand() * 25));
}
