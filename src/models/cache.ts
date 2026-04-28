import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelCatalogFile, ProviderId, RuntimePaths } from "../core/types.js";
import { catalogFileIsStale } from "./catalog.js";

export function modelCachePath(paths: RuntimePaths, provider: ProviderId): string {
  return join(paths.modelCacheDir, `${provider}.json`);
}

export async function readModelCache(paths: RuntimePaths, provider: ProviderId): Promise<ModelCatalogFile | undefined> {
  try {
    return JSON.parse(await readFile(modelCachePath(paths, provider), "utf8")) as ModelCatalogFile;
  } catch {
    return undefined;
  }
}

export async function writeModelCache(paths: RuntimePaths, catalog: ModelCatalogFile): Promise<void> {
  await mkdir(paths.modelCacheDir, { recursive: true });
  await writeFile(modelCachePath(paths, catalog.provider), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

export function isCatalogStale(catalog: ModelCatalogFile, now = Date.now()): boolean {
  return Date.parse(catalog.expiresAt) <= now;
}

export interface CachedModelCatalog extends ModelCatalogFile {
  path: string;
  stale: boolean;
}

function modelCacheDirFromRoot(rootDir: string): string {
  return join(rootDir, ".agent-os", "cache", "models");
}

function modelCachePathFromRoot(rootDir: string, provider: ProviderId): string {
  return join(modelCacheDirFromRoot(rootDir), `${provider}.json`);
}

export async function writeModelCatalogCache(rootDir: string, catalog: ModelCatalogFile): Promise<string> {
  const path = modelCachePathFromRoot(rootDir, catalog.provider);
  await mkdir(modelCacheDirFromRoot(rootDir), { recursive: true });
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return path;
}

export async function readModelCatalogCache(
  rootDir: string,
  provider: ProviderId,
  options: { now?: Date } = {},
): Promise<CachedModelCatalog | null> {
  const path = modelCachePathFromRoot(rootDir, provider);
  try {
    const catalog = JSON.parse(await readFile(path, "utf8")) as ModelCatalogFile;
    return {
      ...catalog,
      path,
      stale: catalogFileIsStale(catalog, options.now),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readAllModelCatalogCaches(rootDir: string, options: { now?: Date } = {}): Promise<CachedModelCatalog[]> {
  try {
    const files = await readdir(modelCacheDirFromRoot(rootDir));
    const catalogs = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => readModelCatalogCache(rootDir, file.slice(0, -".json".length) as ProviderId, options)),
    );
    return catalogs.filter((catalog): catalog is CachedModelCatalog => catalog !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
