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
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    needsKey: true,
    blurb: "One key, hundreds of models",
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
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    needsKey: true,
    blurb: "Mistral and Codestral",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyUrl: "https://build.nvidia.com",
    needsKey: true,
    blurb: "NVIDIA-hosted open models",
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

/** The preset a base URL belongs to, if any — used to label an existing row. */
export function presetForBaseUrl(baseUrl: string | null | undefined): ProviderPreset | null {
  const url = baseUrl?.trim().replace(/\/+$/, "").toLowerCase();
  if (!url) return null;
  return (
    PROVIDER_PRESETS.find((p) => p.baseUrl.replace(/\/+$/, "").toLowerCase() === url) ?? null
  );
}
