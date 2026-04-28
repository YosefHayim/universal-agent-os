import { createCatalogEntry } from "../catalog.js";
import { subscription } from "../pricing.js";
import { catalogFile, commandJson, sourceTimes, type DiscoverySource } from "./common.js";

export const codexSource: DiscoverySource = {
  provider: "codex",
  async discover() {
    const json = commandJson("codex", ["debug", "models"]);
    return catalogFile("codex", "codex debug models", mapCodexModels(json));
  },
};

export async function discoverCodexModels() {
  return codexSource.discover();
}

export const codexModelSource = codexSource;

export function mapCodexModels(payload: unknown, times = sourceTimes()) {
  const raw = Array.isArray(payload)
    ? payload as Array<Record<string, unknown>>
    : Array.isArray((payload as { models?: unknown } | undefined)?.models)
      ? (payload as { models: Array<Record<string, unknown>> }).models
      : [];
  const pricing = subscription("Codex CLI model access depends on the signed-in account plan.");
  return raw.map((item) => createCatalogEntry({
    provider: "codex",
    id: String(item.slug ?? item.id ?? item.name),
    displayName: typeof item.display_name === "string"
      ? item.display_name
      : typeof item.displayName === "string"
        ? item.displayName
        : undefined,
    costCategory: pricing.costCategory,
    pricing: pricing.pricing,
    requiresApproval: false,
    contextWindow: 200_000,
    sourceKind: "provider_cli",
    sourceCommand: "codex debug models",
    fetchedAt: times.fetchedAt,
    expiresAt: times.expiresAt,
    confidence: raw.length ? "high" : "low",
    cloudHosted: true,
    structuredOutput: true,
    reasoning: true,
  }));
}
