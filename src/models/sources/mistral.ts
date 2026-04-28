import { createCatalogEntry } from "../catalog.js";
import { freeQuota } from "../pricing.js";
import { catalogFile, fetchJson, sourceTimes, type DiscoverySource } from "./common.js";

export const mistralSource: DiscoverySource = {
  provider: "mistral",
  async discover() {
    if (!process.env.MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY is not set");
    const url = "https://api.mistral.ai/v1/models";
    const json = await fetchJson(url, { headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` } });
    const data = Array.isArray((json as { data?: unknown }).data) ? (json as { data: Array<Record<string, unknown>> }).data : [];
    const times = sourceTimes();
    const pricing = freeQuota("Mistral Experiment plan is free evaluation quota, not unlimited free usage.");
    return catalogFile("mistral", url, data.map((item) => createCatalogEntry({
      provider: "mistral",
      id: String(item.id),
      costCategory: pricing.costCategory,
      pricing: pricing.pricing,
      requiresApproval: false,
      contextWindow: 128_000,
      sourceKind: "provider_api",
      sourceUrl: url,
      fetchedAt: times.fetchedAt,
      expiresAt: times.expiresAt,
      confidence: "high",
      cloudHosted: true,
      structuredOutput: true,
    })));
  },
};

export async function discoverMistralModels() {
  return mistralSource.discover();
}

export const mistralModelSource = mistralSource;
