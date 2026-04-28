import type { ModelCatalogEntry, ProviderAvailability, RiskLevel } from "../core/types.js";

export function scoreRoute(input: { availability: ProviderAvailability; risk: RiskLevel; model?: ModelCatalogEntry }): number {
  if (input.availability === "unavailable") return -1;
  if (input.availability === "unknown") return -1;
  if (input.availability === "limited" && input.risk === "high") return 10;
  let score = input.availability === "available" ? 50 : 20;
  if (input.model?.costCategory === "free_api") score += 25;
  if (input.model?.costCategory === "free_quota") score += 20;
  if (input.model?.costCategory === "subscription") score += 10;
  if (input.model?.costCategory === "paid_api") score -= 10;
  if (input.model?.requiresApproval) score -= 100;
  if (input.model?.codingGate.eligible) score += 20;
  return score;
}
