import OpenAI from "openai";
import type { AgentProvider, ModelProvider } from "../../lib/agents/schema";
import { nemotronUltraModel } from "../../lib/agents/providers";
import { HttpError } from "../http";
export function providerConfiguration(provider: AgentProvider) {
  if (provider === "rules")
    return {
      ready: true,
      model: null,
      detail: "Deterministic tools and parsers; no language model calls.",
    };
  if (provider === "openai")
    return {
      ready: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
      model: process.env.OPENAI_MODEL ?? null,
      detail: "Requires OPENAI_API_KEY and OPENAI_MODEL in .env.local, then a web/worker restart.",
    };
  if (provider === "nvidia")
    return {
      ready: Boolean(process.env.NVIDIA_API_KEY?.trim()),
      model: process.env.NVIDIA_MODEL?.trim() || nemotronUltraModel,
      detail:
        "NVIDIA hosted API. Set NVIDIA_API_KEY in .env.local and restart web/worker. Uses Nemotron 3 Ultra unless NVIDIA_MODEL is set; configuration is not a live connectivity check.",
    };
  const configured = Boolean(process.env.OLLAMA_MODEL);
  return {
    ready: configured,
    model: process.env.OLLAMA_MODEL ?? null,
    detail:
      "Requires an Ollama server on this machine and OLLAMA_MODEL. Model availability is checked by a live run.",
  };
}
export function modelClient(provider: ModelProvider) {
  const config = providerConfiguration(provider);
  if (!config.ready || !config.model) throw new HttpError(503, config.detail);
  if (provider === "openai")
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45_000, maxRetries: 0 });
  if (provider === "nvidia")
    return new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY?.trim(),
      baseURL: "https://integrate.api.nvidia.com/v1",
      timeout: 90_000,
      maxRetries: 0,
    });
  const url = new URL(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new HttpError(
      503,
      "The local model endpoint must use loopback HTTP(S) without URL credentials.",
    );
  return new OpenAI({
    apiKey: "ollama",
    baseURL: url.href.replace(/\/$/, ""),
    timeout: 45_000,
    maxRetries: 0,
  });
}

/** NVIDIA documents max_tokens and reasoning_effort. Disable thinking for the initial constrained-output integration. */
export function chatGenerationOptions(provider: ModelProvider, maxTokens: number) {
  return provider === "nvidia"
    ? { max_tokens: maxTokens, reasoning_effort: "none" as const, temperature: 0.2 }
    : { max_completion_tokens: maxTokens };
}
