import type { CostCategory, ModelPricing } from "../core/types.js";

export function classifyOpenRouterPricing(pricing: unknown): { costCategory: CostCategory; pricing?: ModelPricing; requiresApproval: boolean } {
  const record = typeof pricing === "object" && pricing ? pricing as Record<string, unknown> : {};
  const prompt = parseUsdPerMillion(record.prompt);
  const completion = parseUsdPerMillion(record.completion);
  if (prompt === 0 && completion === 0) {
    return { costCategory: "free_api", pricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, requiresApproval: false };
  }
  if (prompt !== undefined || completion !== undefined) {
    return {
      costCategory: "paid_api",
      pricing: { inputPerMillionUsd: prompt, outputPerMillionUsd: completion },
      requiresApproval: true,
    };
  }
  return { costCategory: "unknown", requiresApproval: true };
}

export function parseUsd(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/^\$/, "");
  if (!cleaned || cleaned === "-") return undefined;
  if (/^free$/i.test(cleaned)) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function perTokenUsdToPerMillion(value: unknown): number | undefined {
  const parsed = parseUsd(value);
  return typeof parsed === "number" ? parsed * 1_000_000 : undefined;
}

export function classifyNumericPricing(values: unknown[]): CostCategory {
  const parsed = values.map(parseUsd).filter((value): value is number => typeof value === "number");
  if (parsed.length === 0) return "unknown";
  if (parsed.some((value) => value > 0)) return "paid_api";
  return "free_api";
}

export function openRouterPricing(pricing: Record<string, unknown>): {
  costCategory: CostCategory;
  pricing?: ModelPricing;
} {
  const costCategory = classifyNumericPricing([
    pricing.prompt,
    pricing.completion,
    pricing.request,
    pricing.image,
    pricing.web_search,
  ]);
  const modelPricing: ModelPricing = {
    inputPerMillionUsd: perTokenUsdToPerMillion(pricing.prompt),
    outputPerMillionUsd: perTokenUsdToPerMillion(pricing.completion),
  };
  return {
    costCategory,
    pricing: Object.values(modelPricing).some((value) => typeof value === "number") ? modelPricing : undefined,
  };
}

export function isCatalogEntryStale(expiresAt: string, now: Date = new Date()): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now.getTime();
}

export function requiresApprovalForPricing(
  costCategory: CostCategory,
  expiresAt?: string,
  now: Date = new Date(),
): boolean {
  if (costCategory === "unknown") return true;
  if (costCategory === "paid_api" && (!expiresAt || isCatalogEntryStale(expiresAt, now))) return true;
  return false;
}

export function isFreeCostCategory(costCategory: CostCategory): boolean {
  return costCategory === "free_api" || costCategory === "free_quota";
}

export function isPaidCostCategory(costCategory: CostCategory): boolean {
  return costCategory === "paid_api" || costCategory === "subscription";
}

export function freeQuota(freeText: string): { costCategory: CostCategory; pricing: ModelPricing; requiresApproval: boolean } {
  return { costCategory: "free_quota", pricing: { freeText }, requiresApproval: false };
}

export function subscription(freeText: string): { costCategory: CostCategory; pricing: ModelPricing; requiresApproval: boolean } {
  return { costCategory: "subscription", pricing: { freeText }, requiresApproval: false };
}

export function unknownPricing(): { costCategory: CostCategory; requiresApproval: boolean } {
  return { costCategory: "unknown", requiresApproval: true };
}

function parseUsdPerMillion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return numeric * 1_000_000;
}
