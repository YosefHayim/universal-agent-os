import { inferCodingCapability } from "../coding-gate.js";
import { asRecord, createEntry, firstArray, numberValue, stringArray, stringValue, type ModelMapOptions } from "../source.js";
import { catalogFile, fetchJson, type DiscoverySource } from "./common.js";
import type { ModelCatalogEntry } from "../../core/types.js";

const URL = "https://models.github.ai/catalog/models";

export const githubModelsSource: DiscoverySource = {
  provider: "github-models",
  async discover() {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const json = await fetchJson(URL, { headers });
    return catalogFile("github-models", URL, mapGitHubModelsCatalog(json, { sourceUrl: URL }));
  },
};

export function mapGitHubModelsCatalog(payload: unknown, options: ModelMapOptions = {}): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const item of firstArray(payload, ["models", "data"])) {
    const record = asRecord(item);
    const id = stringValue(record.id);
    if (!id) continue;

    const limits = asRecord(record.limits);
    const capabilities = stringArray(record.capabilities);
    const tags = stringArray(record.tags);
    const inputModalities = stringArray(record.supported_input_modalities);
    const outputModalities = stringArray(record.supported_output_modalities);
    const summary = stringValue(record.summary);
    const displayName = stringValue(record.name) ?? id;
    const signalText = [id, displayName, summary, capabilities.join(" "), tags.join(" ")].join(" ");
    const contextWindow = numberValue(limits.max_input_tokens) ?? numberValue(limits.context_window);
    const normalizedCapabilities = capabilities.map((capability) => capability.replace(/-/g, "_"));

    entries.push(createEntry({
      provider: "github-models",
      id,
      displayName,
      aliases: [],
      costCategory: "free_quota",
      contextWindow,
      maxOutputTokens: numberValue(limits.max_output_tokens),
      source: {
        kind: "provider_api",
        url: options.sourceUrl ?? URL,
        now: options.now,
        ttlMs: options.ttlMs,
      },
      confidence: "high",
      capabilities: {
        coding: inferCodingCapability(signalText),
        reasoning: normalizedCapabilities.includes("reasoning") || /reasoning|r1|thinking/i.test(signalText),
        toolUse: normalizedCapabilities.includes("tool_calling") || normalizedCapabilities.includes("function_calling"),
        structuredOutput:
          normalizedCapabilities.includes("json_schema") ||
          normalizedCapabilities.includes("structured_outputs") ||
          normalizedCapabilities.includes("tool_calling"),
        vision: inputModalities.includes("image") || outputModalities.includes("image"),
        longContext: typeof contextWindow === "number" ? contextWindow >= 64_000 : undefined,
      },
    }));
  }
  return entries;
}

export async function discoverGitHubModels() {
  return githubModelsSource.discover();
}

export const gitHubModelsSource = githubModelsSource;
