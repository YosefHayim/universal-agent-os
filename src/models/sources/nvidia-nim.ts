import { freeQuota } from "../pricing.js";
import { asRecord, createEntry, firstArray, stringValue, type ModelMapOptions } from "../source.js";
import { catalogFile, fetchJson, type DiscoverySource } from "./common.js";
import type { ModelCatalogEntry } from "../../core/types.js";

const URL = "https://integrate.api.nvidia.com/v1/models";
const PRICING = freeQuota("NVIDIA NIM catalog availability must be verified against account limits before routing.");

const STRONG_CODING_FAMILIES = [
  /deepseek.*(?:r1|v3|v4|coder-(?:3[0-9]|[1-9][0-9]{2,})b)/i,
  /qwen.*qwen(?:2\.5|3).*(?:coder|code).*?(?:32b|480b|a35b)/i,
  /codestral/i,
  /devstral/i,
  /kimi.*k2/i,
  /glm/i,
  /gpt-oss/i,
  /minimax.*m2/i,
];

function isStrongNvidiaCodingModel(id: string): boolean {
  return STRONG_CODING_FAMILIES.some((pattern) => pattern.test(id));
}

export const nvidiaNimSource: DiscoverySource = {
  provider: "nvidia-nim",
  async discover() {
    const json = await fetchJson(URL);
    return catalogFile("nvidia-nim", URL, mapNvidiaNimCatalog(json));
  },
};

export function mapNvidiaNimCatalog(payload: unknown, options: ModelMapOptions = {}): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of firstArray(payload, ["data", "models"])) {
    const record = asRecord(item);
    const id = stringValue(record.id);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const strongCodingModel = isStrongNvidiaCodingModel(id);
    entries.push(createEntry({
      provider: "nvidia-nim",
      id,
      displayName: id,
      costCategory: PRICING.costCategory,
      pricing: PRICING.pricing,
      contextWindow: strongCodingModel ? 131_072 : undefined,
      source: {
        kind: "provider_api",
        url: options.sourceUrl ?? URL,
        now: options.now,
        ttlMs: options.ttlMs,
      },
      confidence: strongCodingModel ? "medium" : "low",
      capabilities: {
        coding: strongCodingModel,
        reasoning: strongCodingModel,
        structuredOutput: strongCodingModel,
        toolUse: strongCodingModel,
        longContext: strongCodingModel,
      },
    }));
  }
  return entries;
}

export async function discoverNvidiaNimModels() {
  return nvidiaNimSource.discover();
}

export const nvidiaNimModelSource = nvidiaNimSource;
