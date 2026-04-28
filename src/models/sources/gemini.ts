import { createCatalogEntry } from "../catalog.js";
import { freeQuota } from "../pricing.js";
import { catalogFile, fetchJson, sourceTimes, type DiscoverySource } from "./common.js";

export const geminiSource: DiscoverySource = {
  provider: "gemini",
  async discover() {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const json = await fetchJson(url);
    const data = Array.isArray((json as { models?: unknown }).models) ? (json as { models: Array<Record<string, unknown>> }).models : [];
    const times = sourceTimes();
    const pricing = freeQuota("Gemini API free tier is rate-limited per project.");
    return catalogFile("gemini", "https://ai.google.dev/api/models", data.map((item) => createCatalogEntry({
      provider: "gemini",
      id: String(item.name ?? "").replace(/^models\//, ""),
      displayName: typeof item.displayName === "string" ? item.displayName : undefined,
      costCategory: pricing.costCategory,
      pricing: pricing.pricing,
      requiresApproval: false,
      contextWindow: typeof item.inputTokenLimit === "number" ? item.inputTokenLimit : undefined,
      maxOutputTokens: typeof item.outputTokenLimit === "number" ? item.outputTokenLimit : undefined,
      sourceKind: "provider_api",
      sourceUrl: "https://ai.google.dev/api/models",
      fetchedAt: times.fetchedAt,
      expiresAt: times.expiresAt,
      confidence: "high",
      cloudHosted: true,
      structuredOutput: true,
    })));
  },
};

export async function discoverGeminiModels() {
  return geminiSource.discover();
}

export const geminiModelSource = geminiSource;
