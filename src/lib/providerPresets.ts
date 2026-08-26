/**
 * Known providers, so adding one is a click rather than a hunt for a base URL.
 *
 * Everything MultiZone talks to speaks the OpenAI chat-completions shape, so a
 * preset is really just "the name people know this service by" plus the
 * OpenAI-compatible endpoint it exposes. Anything not listed here still works
 * the old way — type a name and a URL.
 *
 * `suggestedModel` is a hint for the model field, not a guarantee: model names
 * move faster than releases do, so it is only pre-filled when the provider's
 * model list can't be fetched without a key, and the user can always override.
 */
export type ProviderPreset = {
  id: string;
  /** Name pre-filled into the provider form. */
  name: string;
  baseUrl: string;
  /** Where the user gets a key (shown as a hint under the key field). */
  keyUrl?: string;
  /** Local runtimes need no key; hosted ones do. Drives the hint text. */
  needsKey: boolean;
  suggestedModel?: string;
  /** One-line orientation for people who don't recognise the name. */
  blurb: string;
  /**
   * The standing free allowance, in a few words, for a provider that has one —
   * and only where a card is *not* required to get it. Absent means "this one
   * wants a payment method", not "this one is expensive".
   *
   * These numbers move. They are a reason to try a provider first, not a
   * promise: the link under the field is the source of truth, and a wrong
   * number here costs a user one rate-limit message rather than money.
   * Checked August 2026.
   */
  freeTier?: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
    blurb: "GPT models",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyUrl: "https://console.anthropic.com/settings/keys",
    needsKey: true,
    suggestedModel: "claude-sonnet-4-5",
    blurb: "Claude models (OpenAI-compatible endpoint)",
  },
  {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    needsKey: true,
    suggestedModel: "gemini-2.5-flash",
    blurb: "Gemini via AI Studio",
    freeTier: "1,500 requests a day on Flash, no card",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    needsKey: true,
    blurb: "One key, hundreds of models",
    freeTier: "50 requests a day across its free models, no card",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    needsKey: true,
    suggestedModel: "deepseek-chat",
    blurb: "DeepSeek chat and reasoner",
  },
  {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    needsKey: true,
    blurb: "Grok models",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    needsKey: true,
    blurb: "Very fast open-weight hosting",
    freeTier: "1,000 requests a day, no card",
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    needsKey: true,
    blurb: "Mistral and Codestral",
    freeTier: "A free tier on La Plateforme, no card",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyUrl: "https://build.nvidia.com",
    needsKey: true,
    blurb: "NVIDIA-hosted open models",
    freeTier: "Free credits on signup, no card",
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    needsKey: true,
    blurb: "Open-weight model hosting",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyUrl: "https://cloud.cerebras.ai",
    needsKey: true,
    suggestedModel: "gpt-oss-120b",
    blurb: "Open-weight models at very high speed",
    freeTier: "1M tokens a day, no card",
  },
  {
    id: "zai",
    name: "Z.ai (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai",
    needsKey: true,
    suggestedModel: "glm-4.7-flash",
    blurb: "GLM models; the Flash variants are free",
    freeTier: "Free Flash models, rate limited",
  },
  {
    id: "cohere",
    name: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    needsKey: true,
    blurb: "Command models, strong at retrieval",
    freeTier: "Trial key, ~1,000 calls a month",
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    blurb: "Local models on this machine",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    blurb: "Local server from the LM Studio app",
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    baseUrl: "http://localhost:8080/v1",
    needsKey: false,
    blurb: "Local llama-server",
  },
  {
    id: "vllm",
    name: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    needsKey: false,
    blurb: "Self-hosted vLLM server",
  },
];

/**
 * The providers someone with no key and no local model can actually start on,
 * best allowance first.
 *
 * This list exists because "install Ollama first" is not a real answer for most
 * people — it wants a capable machine, a download measured in gigabytes, and a
 * tolerance for the result being slower and weaker than the free hosted tiers.
 * Every entry here is free without a payment method and takes about a minute to
 * get a key for.
 *
 * There is deliberately no "no key at all" option: a hosted endpoint that
 * answers without a key is either someone else's key being spent or a proxy
 * that sees every prompt, and neither belongs in a local-first app. The only
 * genuinely keyless providers are the local ones below, which is the trade
 * being made either way.
 */
const FREE_TIER_ORDER = [
  // Biggest standing allowance and the one most people already have an account
  // for; also the only free tier here that takes images.
  "google",
  // Fastest to first token by a distance, which is what a first impression is.
  "groq",
  // The largest token budget of the lot, on capable open-weight models.
  "cerebras",
  // One key, many models — the best answer when the user does not yet know
  // which model they want.
  "openrouter",
  "mistral",
  "zai",
  "nvidia",
  "cohere",
];

export const FREE_TIER_PRESETS: ProviderPreset[] = PROVIDER_PRESETS.filter(
  (p) => p.freeTier !== undefined,
).sort((a, b) => {
  // A preset that gains a free tier without being ranked sorts last rather than
  // to the front, which is the safe direction for a recommendation.
  const rank = (id: string) => {
    const i = FREE_TIER_ORDER.indexOf(id);
    return i === -1 ? FREE_TIER_ORDER.length : i;
  };
  return rank(a.id) - rank(b.id);
});

/**
 * The sentence that has to accompany a free-tier recommendation.
 *
 * MultiZone's first principle is that nothing leaves the machine unless the
 * user chooses, and PRIVACY.md says so in the app. Suggesting a hosted provider
 * in onboarding *is* that choice being offered, so it is offered with what it
 * costs: free tiers are generally funded by the prompts sent to them.
 */
export const FREE_TIER_CAVEAT =
  "These send your messages to that company's servers, and free tiers are usually the ones that train on what you send. Nothing is shared until you pick one, and a local model stays entirely on this machine.";

/** The preset a base URL belongs to, if any — used to label an existing row. */
export function presetForBaseUrl(baseUrl: string | null | undefined): ProviderPreset | null {
  const url = baseUrl?.trim().replace(/\/+$/, "").toLowerCase();
  if (!url) return null;
  return (
    PROVIDER_PRESETS.find((p) => p.baseUrl.replace(/\/+$/, "").toLowerCase() === url) ?? null
  );
}
