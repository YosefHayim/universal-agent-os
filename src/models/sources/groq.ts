import { createCatalogEntry } from "../catalog.js";
import { freeQuota } from "../pricing.js";
import { catalogFile, fetchJson, sourceTimes, type DiscoverySource } from "./common.js";

export const groqSource: DiscoverySource = {
  provider: "groq",
  async discover() {
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
    const url = "https://api.groq.com/openai/v1/models";
    const json = await fetchJson(url, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } });
    const data = Array.isArray((json as { data?: unknown }).data) ? (json as { data: Array<Record<string, unknown>> }).data : [];
    const times = sourceTimes();
    const pricing = freeQuota("Groq Free plan has explicit rate limits.");
    return catalogFile("groq", url, data.map((item) => createCatalogEntry({
      provider: "groq",
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

export async function discoverGroqModels() {
  return groqSource.discover();
}

export const groqModelSource = groqSource;
