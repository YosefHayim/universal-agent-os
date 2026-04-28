import type {
  Confidence,
  CostCategory,
  ModelAvailability,
  ModelCatalogEntry,
  ModelCatalogFile,
  ModelPricing,
  ProviderId,
  SourceKind,
} from "../core/types.js";
import { evaluateCodingModelGate } from "./coding-gate.js";
import { requiresApprovalForPricing } from "./pricing.js";

export const DEFAULT_MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ExecFileLike {
  (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
}

export interface ModelSourceOptions {
  now?: Date;
  ttlMs?: number;
  fetch?: FetchLike;
  execFile?: ExecFileLike;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export interface ModelMapOptions {
  now?: Date;
  ttlMs?: number;
  sourceUrl?: string;
  sourceCommand?: string;
}

export interface SourceInfoInput {
  kind: SourceKind;
  url?: string;
  command?: string;
  now?: Date;
  ttlMs?: number;
}

export interface EntryInput {
  provider: ProviderId;
  id: string;
  displayName?: string;
  aliases?: string[];
  availability?: ModelAvailability;
  costCategory: CostCategory;
  pricing?: ModelPricing;
  capabilities?: ModelCatalogEntry["capabilities"];
  contextWindow?: number;
  maxOutputTokens?: number;
  source: SourceInfoInput;
  confidence?: Confidence;
}

export interface ModelSource {
  provider: ProviderId;
  discoverModels(options?: ModelSourceOptions): Promise<ModelCatalogFile>;
}

export function modelSourceTime(options: Pick<ModelMapOptions, "now" | "ttlMs"> = {}): {
  fetchedAt: string;
  expiresAt: string;
} {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_MODEL_CATALOG_TTL_MS;
  return {
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export function createEntry(input: EntryInput): ModelCatalogEntry {
  const sourceTimes = modelSourceTime({
    now: input.source.now,
    ttlMs: input.source.ttlMs,
  });
  const contextWindow = input.contextWindow;
  const capabilities = {
    ...input.capabilities,
    longContext: input.capabilities?.longContext ?? (typeof contextWindow === "number" ? contextWindow >= 64_000 : undefined),
  };
  const entry: ModelCatalogEntry = {
    provider: input.provider,
    id: input.id,
    displayName: input.displayName,
    aliases: input.aliases ?? [],
    availability: input.availability ?? "remote",
    costCategory: input.costCategory,
    pricing: input.pricing,
    capabilities,
    contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    source: {
      kind: input.source.kind,
      url: input.source.url,
      command: input.source.command,
      ...sourceTimes,
    },
    confidence: input.confidence ?? "medium",
    requiresApproval: requiresApprovalForPricing(input.costCategory, sourceTimes.expiresAt, input.source.now),
    codingGate: {
      eligible: false,
      reasons: [],
      smoke: "not_applicable",
    },
  };

  return {
    ...entry,
    codingGate: evaluateCodingModelGate(entry),
  };
}

export function createCatalogFile(
  provider: ProviderId,
  entries: ModelCatalogEntry[],
  options: { source: string; now?: Date; ttlMs?: number },
): ModelCatalogFile {
  const times = modelSourceTime(options);
  return {
    provider,
    fetchedAt: times.fetchedAt,
    expiresAt: times.expiresAt,
    source: options.source,
    entries,
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringArray(value: unknown): string[] {
  return arrayValue(value)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

export function firstArray(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  for (const key of keys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export async function fetchJson(url: string, options: ModelSourceOptions = {}, init: RequestInit = {}): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("fetch is not available in this runtime");

  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GET ${url} failed with HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeModelId(id: string): string {
  return id.replace(/^models\//, "").trim();
}
