import { createCatalogEntry } from "../catalog.js";
import { freeQuota, subscription, unknownPricing } from "../pricing.js";
import { catalogFile, sourceTimes, type DiscoverySource } from "./common.js";
import type { ModelPricing, ProviderId } from "../../core/types.js";

export function accountBackedSource(provider: ProviderId, source: string, category: "free_quota" | "subscription" | "unknown"): DiscoverySource {
  return {
    provider,
    async discover() {
      const times = sourceTimes();
      const pricing = category === "free_quota"
        ? freeQuota(`${provider} account-backed free quota; run provider smoke before routing.`)
        : category === "subscription"
          ? subscription(`${provider} subscription/account-backed access; exact marginal cost may be hidden.`)
          : unknownPricing();
      return catalogFile(provider, source, [
        createCatalogEntry({
          provider,
          id: `${provider}:account-catalog-unavailable`,
          displayName: `${provider} account catalog unavailable`,
          costCategory: pricing.costCategory,
          pricing: "pricing" in pricing ? pricing.pricing as ModelPricing : undefined,
          requiresApproval: true,
          contextWindow: undefined,
          sourceKind: "official_docs",
          sourceUrl: source,
          fetchedAt: times.fetchedAt,
          expiresAt: times.expiresAt,
          confidence: "low",
          cloudHosted: true,
          structuredOutput: false,
        }),
      ]);
    },
  };
}
