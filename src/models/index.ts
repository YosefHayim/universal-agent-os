import { DEFAULT_PROVIDERS } from "../config/defaults.js";
import type { CostCategory, ModelCatalogEntry, ProviderId, RuntimePaths } from "../core/types.js";
import { isCatalogStale } from "./cache.js";
import { isFreeCategory } from "./catalog.js";
import { loadCatalogs, refreshModelCatalog } from "./discovery.js";

export interface ModelListFilters {
  provider?: ProviderId;
  free?: boolean;
  paid?: boolean;
  coding?: boolean;
  stale?: boolean;
}

export async function refreshModels(paths: RuntimePaths, provider?: ProviderId): Promise<number> {
  const providers = provider ? [provider] : DEFAULT_PROVIDERS;
  const catalogs = await refreshModelCatalog(paths, providers);
  return catalogs.reduce((count, catalog) => count + catalog.entries.length, 0);
}

export async function listModels(paths: RuntimePaths, filters: ModelListFilters = {}): Promise<ModelCatalogEntry[]> {
  const providers = filters.provider ? [filters.provider] : DEFAULT_PROVIDERS;
  const catalogs = await loadCatalogs(paths, providers);
  const stale = new Set(catalogs.filter((catalog) => isCatalogStale(catalog)).map((catalog) => catalog.provider));
  return catalogs.flatMap((catalog) => catalog.entries.map((entry) => markStale(entry, stale.has(catalog.provider))))
    .filter((entry) => !filters.free || isFreeCategory(entry.costCategory))
    .filter((entry) => !filters.paid || paidCategories.has(entry.costCategory))
    .filter((entry) => !filters.coding || entry.codingGate.eligible)
    .filter((entry) => filters.stale || !entry.requiresApproval || entry.costCategory !== "unknown");
}

export async function modelsDoctor(paths: RuntimePaths): Promise<{ provider: ProviderId; entries: number; stale: boolean; source: string; status: "ok" | "failed"; error?: string }[]> {
  const catalogs = await loadCatalogs(paths, DEFAULT_PROVIDERS);
  return catalogs.map((catalog) => ({
    provider: catalog.provider,
    entries: catalog.entries.length,
    stale: isCatalogStale(catalog),
    source: catalog.source,
    status: catalog.source.startsWith("error:") ? "failed" : "ok",
    error: catalog.source.startsWith("error:") ? catalog.source.slice("error:".length) : undefined,
  }));
}

function markStale(entry: ModelCatalogEntry, stale: boolean): ModelCatalogEntry {
  if (!stale) return entry;
  if (entry.costCategory === "paid_api" || entry.costCategory === "unknown") {
    return {
      ...entry,
      requiresApproval: true,
      codingGate: {
        ...entry.codingGate,
        eligible: false,
        reasons: [...entry.codingGate.reasons, "stale pricing"],
      },
    };
  }
  return entry;
}

const paidCategories = new Set<CostCategory>(["paid_api", "subscription", "unknown"]);
