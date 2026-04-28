import type { ModelCatalogEntry, ProviderId } from "../core/types.js";

export interface CodingGateOptions {
  allowTinyTask?: boolean;
  allowVision?: boolean;
  accountHealthy?: boolean;
  smokePassed?: boolean;
}

const CLOUD_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set([
  "codex",
  "claude",
  "zai",
  "opencode",
  "openrouter",
  "github-models",
  "gemini",
  "nvidia-nim",
  "mistral",
  "groq",
]);

const EXCLUDED_MODEL_TEXT = [
  "audio",
  "embed",
  "embedding",
  "guard",
  "image",
  "moderation",
  "ocr",
  "rerank",
  "reranker",
  "speech",
  "summarization",
  "safety",
  "transcribe",
  "tts",
  "video",
  "whisper",
];

const CODING_SIGNAL_TEXT = [
  "agent",
  "code",
  "coder",
  "coding",
  "completion_fim",
  "programming",
  "software",
];

export function inferCodingCapability(...values: Array<string | undefined>): boolean {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  return CODING_SIGNAL_TEXT.some((signal) => text.includes(signal));
}

export function hasExcludedModelPurpose(...values: Array<string | undefined>): boolean {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  return EXCLUDED_MODEL_TEXT.some((signal) => text.includes(signal));
}

function isLocalRunnerSignal(entry: ModelCatalogEntry): boolean {
  const command = entry.source.command?.toLowerCase() ?? "";
  const url = entry.source.url?.toLowerCase() ?? "";
  return (
    command.includes("ollama") ||
    command.includes("lm studio") ||
    command.includes("lmstudio") ||
    command.includes("llama.cpp") ||
    url.includes("localhost") ||
    url.includes("127.0.0.1")
  );
}

export function evaluateCodingModelGate(
  entry: ModelCatalogEntry,
  options: CodingGateOptions = {},
): ModelCatalogEntry["codingGate"] {
  const reasons: string[] = [];
  const capabilities = entry.capabilities;
  const text = `${entry.id} ${entry.displayName ?? ""} ${entry.pricing?.freeText ?? ""}`;
  const toolOrStructured = capabilities.toolUse === true || capabilities.structuredOutput === true;
  const codingCapable =
    capabilities.coding === true ||
    inferCodingCapability(text);

  if (!CLOUD_PROVIDER_IDS.has(entry.provider) || isLocalRunnerSignal(entry)) reasons.push("local_runner_disabled");
  if (entry.availability !== "available" && entry.availability !== "remote") reasons.push("not_cloud_available");
  if (options.accountHealthy === false) reasons.push("account_not_healthy");
  if (entry.requiresApproval || entry.costCategory === "unknown") reasons.push("price_requires_approval");
  if (hasExcludedModelPurpose(text) || (capabilities.vision === true && !options.allowVision)) reasons.push("excluded_model_type");
  if (!codingCapable) reasons.push("not_coding_capable");
  if (!toolOrStructured) reasons.push("missing_tool_or_structured_output");
  if (!options.allowTinyTask && (typeof entry.contextWindow !== "number" || entry.contextWindow < 64_000)) {
    reasons.push("context_below_64k");
  }
  if (entry.codingGate.smoke === "failed") reasons.push("coding_smoke_failed");

  const eligible = reasons.length === 0;
  const smoke = options.smokePassed || entry.codingGate.smoke === "passed" ? "passed" : eligible ? "required" : "not_applicable";
  return { eligible, reasons: Array.from(new Set(reasons)), smoke };
}
