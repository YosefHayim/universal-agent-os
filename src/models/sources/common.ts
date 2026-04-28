import { spawnSync } from "node:child_process";
import { MODEL_CACHE_TTL_MS } from "../../config/defaults.js";
import type { ModelCatalogFile, ModelCatalogEntry, ProviderId } from "../../core/types.js";

export interface DiscoverySource {
  provider: ProviderId;
  discover(): Promise<ModelCatalogFile>;
}

export function catalogFile(provider: ProviderId, source: string, entries: ModelCatalogEntry[], ttlMs = MODEL_CACHE_TTL_MS): ModelCatalogFile {
  const fetchedAt = new Date().toISOString();
  return {
    provider,
    fetchedAt,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    source,
    entries,
  };
}

export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${response.statusText}`);
  return response.json() as Promise<unknown>;
}

export function commandJson(command: string, args: string[], cwd = process.cwd()): unknown | undefined {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

export function sourceTimes(ttlMs = MODEL_CACHE_TTL_MS): { fetchedAt: string; expiresAt: string } {
  const fetchedAt = new Date().toISOString();
  return { fetchedAt, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}
