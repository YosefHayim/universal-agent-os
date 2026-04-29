import type { ModelCatalogFile, ProviderId, RuntimePaths } from "../core/types.js";
import { readModelCache, writeModelCache } from "./cache.js";
import { codexSource } from "./sources/codex.js";
import { anthropicSource } from "./sources/anthropic.js";
import { clineSource } from "./sources/cline.js";
import { zaiSource } from "./sources/zai.js";
import { kiloSource } from "./sources/kilo.js";
import { opencodeSource } from "./sources/opencode.js";
import { openRouterSource } from "./sources/openrouter.js";
import { githubModelsSource } from "./sources/github-models.js";
import { geminiSource } from "./sources/gemini.js";
import { nvidiaNimSource } from "./sources/nvidia-nim.js";
import { mistralSource } from "./sources/mistral.js";
import { groqSource } from "./sources/groq.js";
import { catalogFile, type DiscoverySource } from "./sources/common.js";

const SOURCES: Record<ProviderId, DiscoverySource | undefined> = {
  manual: undefined,
  codex: codexSource,
  claude: anthropicSource,
  zai: zaiSource,
  opencode: opencodeSource,
  kilo: kiloSource,
  cline: clineSource,
  openrouter: openRouterSource,
  "github-models": githubModelsSource,
  gemini: geminiSource,
  "nvidia-nim": nvidiaNimSource,
  mistral: mistralSource,
  groq: groqSource,
};

export type ModelSourceProviderId = Exclude<ProviderId, "manual">;

export const MODEL_SOURCES = SOURCES as Record<ProviderId, DiscoverySource | undefined>;

export const ACTIVE_MODEL_SOURCE_IDS = Object.freeze(
  Object.entries(SOURCES)
    .filter((entry): entry is [ModelSourceProviderId, DiscoverySource] => entry[0] !== "manual" && entry[1] !== undefined)
    .map(([provider]) => provider),
);

export function hasModelSource(provider: ProviderId): provider is ModelSourceProviderId {
  return provider !== "manual" && SOURCES[provider] !== undefined;
}

export async function discoverModelCatalog(provider: ModelSourceProviderId): Promise<ModelCatalogFile> {
  return SOURCES[provider]!.discover();
}

export async function refreshModelCatalog(paths: RuntimePaths, providers: ProviderId[]): Promise<ModelCatalogFile[]> {
  const out: ModelCatalogFile[] = [];
  for (const provider of providers) {
    const source = SOURCES[provider];
    if (!source) continue;
    try {
      const catalog = await source.discover();
      await writeModelCache(paths, catalog);
      out.push(catalog);
    } catch (error) {
      const fallback = catalogFile(provider, `error:${error instanceof Error ? error.message : String(error)}`, []);
      await writeModelCache(paths, fallback);
      out.push(fallback);
    }
  }
  return out;
}

export async function loadCatalogs(paths: RuntimePaths, providers: ProviderId[]): Promise<ModelCatalogFile[]> {
  const catalogs = await Promise.all(providers.map((provider) => readModelCache(paths, provider)));
  return catalogs.filter((catalog): catalog is ModelCatalogFile => Boolean(catalog));
}
