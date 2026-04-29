import { spawnSync } from "node:child_process";
import { createCatalogEntry } from "../catalog.js";
import { freeQuota, subscription } from "../pricing.js";
import { catalogFile, sourceTimes, type DiscoverySource } from "./common.js";

const OFFICIAL_FREE_MODEL_IDS = new Set([
  "minimax/minimax-m2.5",
  "kwaipilot/kat-coder-pro",
  "z-ai/glm-5",
]);

export const clineSource: DiscoverySource = {
  provider: "cline",
  async discover() {
    const result = spawnSync("cline", ["config"], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (!output.trim() && result.status !== 0) throw new Error(result.stderr.trim() || "cline config failed");
    return catalogFile("cline", "cline config", mapClineConfigModels(output));
  },
};

export async function discoverClineModels() {
  return clineSource.discover();
}

export const clineModelSource = clineSource;

export function mapClineConfigModels(output: string, times = sourceTimes()) {
  const ids = parseClineConfigModelIds(output);
  return ids.map((id) => {
    const pricing = isFreeModelId(id)
      ? freeQuota("cline config reported this model as free or free-quota through the configured provider account.")
      : subscription("cline model access depends on the signed-in provider account.");
    return createCatalogEntry({
      provider: "cline",
      id,
      displayName: `${id} coding worker model`,
      costCategory: pricing.costCategory,
      pricing: pricing.pricing,
      requiresApproval: pricing.requiresApproval,
      contextWindow: 200_000,
      sourceKind: "provider_cli",
      sourceCommand: "cline config",
      fetchedAt: times.fetchedAt,
      expiresAt: times.expiresAt,
      confidence: ids.length ? "medium" : "low",
      cloudHosted: true,
      structuredOutput: true,
      toolUse: true,
      reasoning: /\b(r1|reasoning|thinking|think|opus|sonnet|codex|coder)\b/i.test(id),
    });
  });
}

export function parseClineConfigModelIds(output: string): string[] {
  const clean = stripAnsi(output);
  const ids: string[] = [];
  for (const line of clean.split(/\r?\n/)) {
    const match = line.match(/\b(?:act|plan)Mode[A-Za-z]*(?:ModelId|ClineModelId|OpenRouterModelId):\s*([^\s]+)/);
    const id = match?.[1]?.trim();
    if (!id || /^(null|undefined|none|not)$/i.test(id)) continue;
    ids.push(id);
  }
  return Array.from(new Set(ids));
}

function isFreeModelId(id: string): boolean {
  return OFFICIAL_FREE_MODEL_IDS.has(id) || /(^|[-:/])free($|[-:/])|:free\b/i.test(id);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
