import type { ProviderId, RiskLevel } from "../core/types.js";

export function fallbackProviders(risk: RiskLevel): ProviderId[] {
  if (risk === "high") return ["manual", "codex", "claude", "zai", "gemini", "opencode"];
  return ["manual", "codex", "claude", "gemini", "opencode", "kilo", "cline", "zai", "openrouter", "github-models", "nvidia-nim", "mistral", "groq"];
}
