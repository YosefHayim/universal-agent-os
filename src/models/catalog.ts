import type { CostCategory, ModelAvailability, ModelCatalogEntry, ModelCatalogFile, ProviderId, SourceKind } from "../core/types.js";
import { evaluateCodingModelGate } from "./coding-gate.js";
import {
  DEFAULT_MODEL_CATALOG_TTL_MS,
  createCatalogFile,
  modelSourceTime,
} from "./source.js";
import {
  isCatalogEntryStale,
  isFreeCostCategory,
  isPaidCostCategory,
  requiresApprovalForPricing,
} from "./pricing.js";

const CODING_HINTS = [
  "agent",
  "code",
  "coder",
  "coding",
  "codex",
  "completion_fim",
  "programming",
  "software",
  "r1",
];

const NON_CODING_HINTS = [
  "embed",
  "embedding",
  "rerank",
  "whisper",
  "tts",
  "speech",
  "audio",
  "image",
  "video",
  "ocr",
  "safety",
  "guard",
  "moderation",
];

export interface EntryInput {
  provider: ProviderId;
  id: string;
  displayName?: string;
  aliases?: string[];
  costCategory: CostCategory;
  requiresApproval?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  sourceKind: SourceKind;
  sourceUrl?: string;
  sourceCommand?: string;
  fetchedAt: string;
  expiresAt: string;
  confidence?: "high" | "medium" | "low";
  pricing?: ModelCatalogEntry["pricing"];
  availability?: ModelAvailability;
  structuredOutput?: boolean;
  toolUse?: boolean;
  reasoning?: boolean;
  cloudHosted?: boolean;
}

export function createCatalogEntry(input: EntryInput): ModelCatalogEntry {
  const codingSignal = hasCodingSignal(input.id, input.displayName);
  const nonCoding = hasNonCodingSignal(input.id, input.displayName);
  const longContext = (input.contextWindow ?? 0) >= 64_000;
  const structured = Boolean(input.structuredOutput ?? input.toolUse ?? true);
  const cloudHosted = input.cloudHosted ?? !["codex", "claude", "zai", "manual"].includes(input.provider);
  const reasons: string[] = [];
  if (!cloudHosted && !["codex", "claude", "zai"].includes(input.provider)) reasons.push("not cloud-hosted");
  if (!codingSignal) reasons.push("no coding metadata signal");
  if (nonCoding) reasons.push("non-coding modality");
  if (!longContext) reasons.push("context below 64k or unknown");
  if (!structured) reasons.push("no structured output signal");
  if (input.costCategory === "unknown") reasons.push("unknown pricing");
  const eligible = reasons.length === 0;
  return {
    provider: input.provider,
    id: input.id,
    displayName: input.displayName,
    aliases: input.aliases ?? [],
    availability: input.availability ?? (cloudHosted ? "remote" : "available"),
    costCategory: input.costCategory,
    pricing: input.pricing,
    capabilities: {
      coding: codingSignal && !nonCoding,
      longContext,
      reasoning: Boolean(input.reasoning ?? codingSignal),
      structuredOutput: structured,
      toolUse: Boolean(input.toolUse ?? structured),
    },
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    source: {
      kind: input.sourceKind,
      url: input.sourceUrl,
      command: input.sourceCommand,
      fetchedAt: input.fetchedAt,
      expiresAt: input.expiresAt,
    },
    confidence: input.confidence ?? "medium",
    requiresApproval: input.requiresApproval ?? requiresApprovalForPricing(input.costCategory, input.expiresAt),
    codingGate: {
      eligible,
      reasons,
      smoke: eligible ? "required" : "not_applicable",
    },
  };
}

export function isFreeCategory(category: CostCategory): boolean {
  return category === "free_api" || category === "free_quota";
}

export interface CatalogPolicyOptions {
  now?: Date;
}

export interface CatalogListFilters {
  provider?: ProviderId;
  free?: boolean;
  paid?: boolean;
  coding?: boolean;
  stale?: boolean;
  now?: Date;
}

export { DEFAULT_MODEL_CATALOG_TTL_MS };

export function createModelCatalog(
  provider: ProviderId,
  entries: ModelCatalogEntry[],
  options: { fetchedAt?: Date; source: string; ttlMs?: number },
): ModelCatalogFile {
  const now = options.fetchedAt ?? new Date();
  return createCatalogFile(provider, entries.map((entry) => applyCatalogPolicy(entry, { now })), {
    source: options.source,
    now,
    ttlMs: options.ttlMs,
  });
}

export function applyCatalogPolicy(
  entry: ModelCatalogEntry,
  options: CatalogPolicyOptions = {},
): ModelCatalogEntry {
  const now = options.now ?? new Date();
  const source = entry.source.expiresAt
    ? entry.source
    : {
        ...entry.source,
        ...modelSourceTime({ now, ttlMs: DEFAULT_MODEL_CATALOG_TTL_MS }),
      };
  const requiresApproval =
    entry.requiresApproval || requiresApprovalForPricing(entry.costCategory, source.expiresAt, now);
  const next: ModelCatalogEntry = {
    ...entry,
    source,
    capabilities: {
      ...entry.capabilities,
      longContext: entry.capabilities.longContext ?? (typeof entry.contextWindow === "number" ? entry.contextWindow >= 64_000 : undefined),
    },
    requiresApproval,
  };
  return {
    ...next,
    codingGate: evaluateCodingModelGate(next),
  };
}

export function catalogEntryIsStale(entry: ModelCatalogEntry, now: Date = new Date()): boolean {
  return isCatalogEntryStale(entry.source.expiresAt, now);
}

export function catalogFileIsStale(catalog: ModelCatalogFile, now: Date = new Date()): boolean {
  return isCatalogEntryStale(catalog.expiresAt, now);
}

export function listCatalogEntries(catalogs: ModelCatalogFile[], filters: CatalogListFilters = {}): ModelCatalogEntry[] {
  const now = filters.now ?? new Date();
  return catalogs
    .flatMap((catalog) => catalog.entries)
    .map((entry) => applyCatalogPolicy(entry, { now }))
    .filter((entry) => (filters.provider ? entry.provider === filters.provider : true))
    .filter((entry) => (filters.free ? isFreeCostCategory(entry.costCategory) : true))
    .filter((entry) => (filters.paid ? isPaidCostCategory(entry.costCategory) : true))
    .filter((entry) => (filters.coding ? entry.codingGate.eligible : true))
    .filter((entry) => (filters.stale ? catalogEntryIsStale(entry, now) : true))
    .sort((a, b) => `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`));
}

export function costCategoryLabel(costCategory: CostCategory): string {
  return costCategory.replace("_", " ");
}

export function hasCodingSignal(...values: Array<string | undefined>): boolean {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  return CODING_HINTS.some((hint) => text.includes(hint));
}

function hasNonCodingSignal(...values: Array<string | undefined>): boolean {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  return NON_CODING_HINTS.some((hint) => text.includes(hint));
}
