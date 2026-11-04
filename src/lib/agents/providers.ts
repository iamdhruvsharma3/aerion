export const modelProviderIds = ["openai", "nvidia", "ollama"] as const;
export const agentProviderIds = ["rules", ...modelProviderIds] as const;
export const agentProviderLabels: Record<(typeof agentProviderIds)[number], string> = {
  rules: "Local deterministic tools",
  openai: "OpenAI API",
  nvidia: "NVIDIA Nemotron 3 Ultra",
  ollama: "Local Ollama model",
};
export const nemotronUltraModel = "nvidia/nemotron-3-ultra-550b-a55b";
