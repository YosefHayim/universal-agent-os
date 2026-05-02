import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

/** Registry rows are append-only so late provider selection can enrich a task without rewriting shared state. */
export interface RegistryEntry {
  taskId: string;
  repoRoot: string;
  goal: string;
  createdAt: string;
  provider?: string | null;
  modelId?: string | null;
}

/** Uses an OS data directory so tasks created from unrelated checkouts share one discovery surface. */

function canonicalRepoRoot(input: string): string {
  try { return realpathSync(input); } catch { return resolve(input); }
}
function canonicalRepoRootSync(input: string): string {
  try { return realpathSync(input); } catch { return resolve(input); }
}

export function registryFilePath(): string {
  if (process.env.AGENT_OS_REGISTRY_FILE) return process.env.AGENT_OS_REGISTRY_FILE;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "agent-os", "registry.ndjson");
}

/** Appends one complete NDJSON line with O_APPEND so concurrent workers cannot interleave bytes. */
export async function appendRegistryEntry(entry: RegistryEntry): Promise<void> {
  const path = registryFilePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    const normalized = normalizeEntry(entry);
    const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
    try {
      await handle.writev([Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8")]);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isPermissionError(error)) {
      console.warn(`[agent-os] registry append skipped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    throw error;
  }
}

/** Reads tolerate a partially written final line because append-only logs may be observed mid-write. */
export async function readRegistryEntries(opts: { sinceMs?: number; repoRoot?: string } = {}): Promise<RegistryEntry[]> {
  let raw = "";
  try {
    raw = await readFile(registryFilePath(), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  const repoRoot = opts.repoRoot ? canonicalRepoRootSync(opts.repoRoot) : undefined;
  const lines = raw.split("\n");
  const entries: RegistryEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRegistryEntry(parsed)) continue;
      const entry = normalizeEntry(parsed);
      if (opts.sinceMs !== undefined && Date.parse(entry.createdAt) < opts.sinceMs) continue;
      if (repoRoot && entry.repoRoot !== repoRoot) continue;
      entries.push(entry);
    } catch (error) {
      if (index === lines.length - 1) continue;
      throw error;
    }
  }
  return entries;
}

/** Rewrites through a sibling temp file so dashboard readers never see a half-pruned registry. */
export async function pruneRegistry(opts: { olderThanMs: number }): Promise<number> {
  const path = registryFilePath();
  const entries = await readRegistryEntries();
  const kept = entries.filter((entry) => Date.parse(entry.createdAt) >= opts.olderThanMs);
  const removed = entries.length - kept.length;
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, kept.map((entry) => JSON.stringify(normalizeEntry(entry))).join("\n") + (kept.length ? "\n" : ""), "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  return removed;
}

function normalizeEntry(entry: RegistryEntry): RegistryEntry {
  return {
    taskId: entry.taskId,
    repoRoot: canonicalRepoRoot(entry.repoRoot),
    goal: entry.goal.slice(0, 200),
    createdAt: entry.createdAt,
    provider: entry.provider ?? null,
    modelId: entry.modelId ?? null,
  };
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.taskId === "string"
    && typeof record.repoRoot === "string"
    && typeof record.goal === "string"
    && typeof record.createdAt === "string"
    && (record.provider === undefined || record.provider === null || typeof record.provider === "string")
    && (record.modelId === undefined || record.modelId === null || typeof record.modelId === "string");
}

function isPermissionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EACCES";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
