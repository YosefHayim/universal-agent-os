import type { EventRecord, ProviderId, ProviderUsage } from "../core/types.js";

export interface UsageSummaryRow {
  provider: ProviderId | "unknown";
  runs: number;
  exactRuns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedTokens: number;
}

export interface UsageSummary {
  latest?: EventRecord;
  today: UsageSummaryRow[];
  week: UsageSummaryRow[];
  all: UsageSummaryRow[];
}

export function buildRunUsage(input: {
  prompt: string;
  stdout: string;
  stderr: string;
}): ProviderUsage {
  const exact = extractUsageFromText(`${input.stdout}\n${input.stderr}`);
  const estimatedInputTokens = estimateTokens(input.prompt);
  const estimatedOutputTokens = estimateTokens(`${input.stdout}\n${input.stderr}`.trim());
  return {
    ...exact,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    inputChars: input.prompt.length,
    outputChars: `${input.stdout}\n${input.stderr}`.trim().length,
    exact: hasExactUsage(exact),
  };
}

export function extractUsageFromText(text: string): Partial<ProviderUsage> {
  let best: Partial<ProviderUsage> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      best = preferUsage(best, extractUsageFromValue(parsed));
    } catch {
      continue;
    }
  }
  return best;
}

export function summarizeUsage(events: EventRecord[], now = new Date()): UsageSummary {
  const usageEvents = events.filter((event) => event.usage).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    latest: usageEvents.at(-1),
    today: aggregateUsage(usageEvents.filter((event) => Date.parse(event.timestamp) >= startOfToday.getTime())),
    week: aggregateUsage(usageEvents.filter((event) => Date.parse(event.timestamp) >= startOfWeek.getTime())),
    all: aggregateUsage(usageEvents),
  };
}

export function aggregateUsage(events: EventRecord[]): UsageSummaryRow[] {
  const rows = new Map<ProviderId | "unknown", UsageSummaryRow>();
  for (const event of events) {
    if (!event.usage) continue;
    const provider = event.provider ?? "unknown";
    const row = rows.get(provider) ?? {
      provider,
      runs: 0,
      exactRuns: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedTokens: 0,
    };
    row.runs += 1;
    if (event.usage.exact) row.exactRuns += 1;
    row.inputTokens += event.usage.inputTokens ?? 0;
    row.cachedInputTokens += event.usage.cachedInputTokens ?? 0;
    row.outputTokens += event.usage.outputTokens ?? 0;
    row.reasoningOutputTokens += event.usage.reasoningOutputTokens ?? 0;
    row.totalTokens += event.usage.totalTokens ?? ((event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0));
    row.estimatedTokens += event.usage.estimatedTotalTokens ?? 0;
    rows.set(provider, row);
  }
  return [...rows.values()].sort((a, b) => b.runs - a.runs || String(a.provider).localeCompare(String(b.provider)));
}

export function formatUsageLine(usage?: ProviderUsage): string {
  if (!usage) return "usage unavailable";
  const exactParts = [
    usage.inputTokens === undefined ? "" : `in ${formatNumber(usage.inputTokens)}`,
    usage.cachedInputTokens === undefined ? "" : `cached ${formatNumber(usage.cachedInputTokens)}`,
    usage.outputTokens === undefined ? "" : `out ${formatNumber(usage.outputTokens)}`,
    usage.reasoningOutputTokens === undefined ? "" : `reasoning ${formatNumber(usage.reasoningOutputTokens)}`,
    usage.totalTokens === undefined ? "" : `total ${formatNumber(usage.totalTokens)}`,
  ].filter(Boolean);
  if (usage.exact && exactParts.length) return exactParts.join(", ");
  return `estimated ${formatNumber(usage.estimatedTotalTokens ?? 0)} tokens`;
}

export function estimateTokens(value: string): number {
  const chars = value.trim().length;
  return chars ? Math.ceil(chars / 4) : 0;
}

function extractUsageFromValue(value: unknown): Partial<ProviderUsage> {
  const found: Partial<ProviderUsage>[] = [];
  visit(value, found);
  return found.reduce((best, usage) => preferUsage(best, usage), {});
}

function visit(value: unknown, found: Partial<ProviderUsage>[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, found);
    return;
  }
  const record = value as Record<string, unknown>;
  const direct = usageFromRecord(record);
  if (hasExactUsage(direct)) found.push(direct);
  for (const key of ["usage", "usageMetadata", "usage_metadata", "tokenUsage", "token_usage", "metrics"]) {
    if (record[key]) {
      const nested = usageFromRecord(record[key] as Record<string, unknown>);
      if (hasExactUsage(nested)) found.push(nested);
    }
  }
  for (const child of Object.values(record)) visit(child, found);
}

function usageFromRecord(record: Record<string, unknown>): Partial<ProviderUsage> {
  return normalizeUsage({
    inputTokens:
      numberValue(record.input_tokens) ??
      numberValue(record.inputTokens) ??
      numberValue(record.prompt_tokens) ??
      numberValue(record.promptTokens) ??
      numberValue(record.promptTokenCount),
    cachedInputTokens:
      numberValue(record.cached_input_tokens) ??
      numberValue(record.cachedInputTokens) ??
      numberValue(record.cache_read_input_tokens) ??
      numberValue(record.cachedContentTokenCount) ??
      numberValue(record.cached),
    outputTokens:
      numberValue(record.output_tokens) ??
      numberValue(record.outputTokens) ??
      numberValue(record.completion_tokens) ??
      numberValue(record.completionTokens) ??
      numberValue(record.candidatesTokenCount),
    reasoningOutputTokens:
      numberValue(record.reasoning_output_tokens) ??
      numberValue(record.reasoningOutputTokens) ??
      numberValue(record.reasoning_tokens),
    totalTokens:
      numberValue(record.total_tokens) ??
      numberValue(record.totalTokens) ??
      numberValue(record.totalTokenCount),
  });
}

function normalizeUsage(usage: Partial<ProviderUsage>): Partial<ProviderUsage> {
  const totalTokens = usage.totalTokens ?? (
    usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.reasoningOutputTokens !== undefined
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0)
      : undefined
  );
  return { ...usage, totalTokens };
}

function preferUsage(current: Partial<ProviderUsage>, next: Partial<ProviderUsage>): Partial<ProviderUsage> {
  if (!hasExactUsage(next)) return current;
  if (!hasExactUsage(current)) return next;
  return usageScore(next) >= usageScore(current) ? next : current;
}

function usageScore(usage: Partial<ProviderUsage>): number {
  return (usage.totalTokens ?? 0) + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0);
}

function hasExactUsage(usage: Partial<ProviderUsage>): boolean {
  return [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens,
  ].some((value) => value !== undefined);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}
