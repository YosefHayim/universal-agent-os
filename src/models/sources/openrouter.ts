import { inferCodingCapability } from "../coding-gate.js";
import { openRouterPricing } from "../pricing.js";
import { asRecord, createEntry, firstArray, numberValue, stringArray, stringValue, type ModelMapOptions } from "../source.js";
import { catalogFile, fetchJson, type DiscoverySource } from "./common.js";
import type { ModelCatalogEntry } from "../../core/types.js";

const URL = "https://openrouter.ai/api/v1/models";

export const openRouterSource: DiscoverySource = {
  provider: "openrouter",
  async discover() {
    const json = await fetchJson(URL);
    return catalogFile("openrouter", URL, mapOpenRouterCatalog(json, { sourceUrl: URL }));
  },
};

export function mapOpenRouterCatalog(payload: unknown, options: ModelMapOptions = {}): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const item of firstArray(payload, ["data", "models"])) {
    const record = asRecord(item);
    const id = stringValue(record.id);
    if (!id) continue;

    const architecture = asRecord(record.architecture);
    const pricingInfo = openRouterPricing(asRecord(record.pricing));
    const supportedParameters = stringArray(record.supported_parameters);
    const topProvider = asRecord(record.top_provider);
    const modality = stringValue(architecture.modality);
    const displayName = stringValue(record.name) ?? id;
    const signalText = [id, displayName, stringValue(record.description), modality].join(" ");
    const contextWindow = numberValue(record.context_length);
    const hasTools = supportedParameters.some((parameter) => ["tools", "tool_choice", "function_calling"].includes(parameter));
    const hasStructured = supportedParameters.some((parameter) =>
      ["response_format", "structured_outputs", "json_schema"].includes(parameter),
    );

    entries.push(createEntry({
      provider: "openrouter",
      id,
      displayName,
      aliases: stringArray(record.aliases),
      costCategory: pricingInfo.costCategory,
      pricing: pricingInfo.pricing,
      contextWindow,
      maxOutputTokens: numberValue(record.max_completion_tokens) ?? numberValue(topProvider.max_completion_tokens),
      source: {
        kind: "provider_api",
        url: options.sourceUrl ?? URL,
        now: options.now,
        ttlMs: options.ttlMs,
      },
      confidence: pricingInfo.costCategory === "unknown" ? "medium" : "high",
      capabilities: {
        coding: inferCodingCapability(signalText),
        reasoning: /reason|r1|thinking/i.test(signalText),
        toolUse: hasTools,
        structuredOutput: hasStructured,
        vision: /image|vision/i.test(modality ?? ""),
        longContext: typeof contextWindow === "number" ? contextWindow >= 64_000 : undefined,
      },
    }));
  }
  return entries;
}

export async function discoverOpenRouterModels() {
  return openRouterSource.discover();
}

export const openRouterModelSource = openRouterSource;
