import type { ProviderId } from "../core/types.js";

export const RUNTIME_DIR = ".agent-os";
export const RUNTIME_DIR_NAME = RUNTIME_DIR;
export const CONFIG_DIR_NAME = "config";
export const TASKS_DIR_NAME = "tasks";
export const CACHE_DIR_NAME = "cache";
export const MODEL_CACHE_DIR_NAME = "models";
export const PROVIDER_STATUS_FILE = "provider-status.json";
export const QUEUE_FILE = "queue.json";
export const NOTIFICATIONS_CONFIG_FILE = "notifications.json";

export const DEFAULT_NOTIFICATION_CONFIG = {
  wakeFiles: true,
  bell: true,
  commands: [],
};

export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const PROVIDER_STATUS_TTL_MS = 5 * 60 * 1000;

export const DEFAULT_PROVIDERS: ProviderId[] = [
  "manual",
  "codex",
  "claude",
  "zai",
  "opencode",
  "kilo",
  "cline",
  "openrouter",
  "github-models",
  "gemini",
  "nvidia-nim",
  "mistral",
  "groq",
];
export const PROVIDER_IDS = DEFAULT_PROVIDERS;
export const DIRECT_LAUNCH_PROVIDERS: readonly ProviderId[] = [
  "manual",
  "codex",
  "claude",
  "zai",
  "gemini",
  "opencode",
  "kilo",
  "cline",
];
export const PROVIDER_AVAILABILITY_VALUES = ["available", "unavailable", "limited", "unknown"] as const;
export const PROVIDER_CREDENTIAL_ENV_VARS: Record<ProviderId, string[]> = {
  manual: [],
  codex: [],
  claude: [],
  zai: [],
  opencode: [],
  kilo: [],
  cline: [],
  openrouter: ["OPENROUTER_API_KEY"],
  "github-models": ["GITHUB_TOKEN", "GH_TOKEN"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "nvidia-nim": ["NVIDIA_API_KEY", "NGC_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
};
export const DEFAULT_ALLOWED_FILES = ["**/*"];
export const DEFAULT_RISK = "medium";

export const DEFAULT_VALIDATORS = [
  "result_schema",
  "scope_check",
  "secret_scan",
  "dependency_gate",
  "no_op_check",
  "change_size_check",
];

export const LOCK_TIMEOUT_MS = 30_000;

export function defaultProviderDetail(provider: ProviderId): string {
  if (provider === "manual") return "Manual provider is available without cloud credentials.";
  if (DIRECT_LAUNCH_PROVIDERS.includes(provider)) return `${provider} launches through its installed CLI when detected.`;
  return "Provider adapter is catalog-only until provider smoke activation.";
}

export function defaultProviderAvailability(provider: ProviderId) {
  return provider === "manual" ? "available" : "unknown";
}
