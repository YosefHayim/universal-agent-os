import { spawnSync } from "node:child_process";
import { createCatalogEntry } from "../catalog.js";
import { freeQuota, subscription } from "../pricing.js";
import { catalogFile, sourceTimes, type DiscoverySource } from "./common.js";

export const opencodeSource: DiscoverySource = {
  provider: "opencode",
  async discover() {
    const result = spawnSync("opencode", ["models"], { encoding: "utf8", timeout: 20_000, maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr.trim() || "opencode models failed");
    return catalogFile("opencode", "opencode models", mapOpencodeModels(result.stdout));
  },
};

export async function discoverOpencodeModels() {
  return opencodeSource.discover();
}

export const opencodeModelSource = opencodeSource;

export function mapOpencodeModels(output: string, times = sourceTimes()) {
  const ids = parseOpencodeModelIds(output);
  return ids.map((id) => {
    const pricing = isFreeModelId(id)
      ? freeQuota("opencode reported this model as free or free-quota through the configured provider account.")
      : subscription("opencode model access depends on the signed-in provider account.");
    return createCatalogEntry({
      provider: "opencode",
      id,
      costCategory: pricing.costCategory,
      pricing: pricing.pricing,
      requiresApproval: pricing.requiresApproval,
      contextWindow: 200_000,
      sourceKind: "provider_cli",
      sourceCommand: "opencode models",
      fetchedAt: times.fetchedAt,
      expiresAt: times.expiresAt,
      confidence: ids.length ? "high" : "low",
      cloudHosted: true,
      structuredOutput: true,
      toolUse: true,
      reasoning: /\b(r1|reasoning|thinking|think|opus|sonnet|codex|coder)\b/i.test(id),
    });
  });
}

export function parseOpencodeModelIds(output: string): string[] {
  return Array.from(new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[a-z0-9][a-z0-9._:/+-]+\/[a-z0-9][a-z0-9._:/+-]+$/i.test(line)),
  ));
}

function isFreeModelId(id: string): boolean {
  return /(^|[-:/])free($|[-:/])|:free\b/i.test(id);
}
