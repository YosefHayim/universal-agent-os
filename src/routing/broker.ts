import { DIRECT_LAUNCH_PROVIDERS } from "../config/defaults.js";
import type { CostCategory, ModelCatalogEntry, ProviderAvailability, ProviderId, RiskLevel, RuntimePaths, Task } from "../core/types.js";
import { getManualProviderAvailability } from "./manual-status.js";
import { fallbackProviders } from "./fallback.js";
import { providerAdapter } from "../providers/registry.js";
import { scoreRoute } from "./scoring.js";

export interface RouteChoice {
  provider: ProviderId;
  model?: ModelCatalogEntry;
  modelId?: string;
  score: number;
  reason: string;
}

export interface RouteCandidate {
  provider: ProviderId;
  providerAvailability: ProviderAvailability;
  risk: RiskLevel;
  model: ModelCatalogEntry;
}

export interface RouteSelection {
  selected?: RouteCandidate;
  fallback: {
    routes: RouteCandidate[];
    blocked: Array<RouteCandidate & { reasons: string[] }>;
  };
}

export interface RuntimeRouteOptions {
  requestedProvider?: ProviderId;
  requestedModelId?: string;
}

export function chooseRoute(candidates: RouteCandidate[], options?: { now?: Date }): RouteSelection;
export function chooseRoute(paths: RuntimePaths, task: Task, models?: ModelCatalogEntry[], options?: ProviderId | RuntimeRouteOptions): Promise<RouteChoice>;
export function chooseRoute(
  first: RuntimePaths | RouteCandidate[],
  second?: Task | { now?: Date },
  third: ModelCatalogEntry[] = [],
  options?: ProviderId | RuntimeRouteOptions,
): Promise<RouteChoice> | RouteSelection {
  if (Array.isArray(first)) return chooseFromCandidates(first, second as { now?: Date } | undefined);
  return chooseRuntimeRoute(first, second as Task, third, normalizeRuntimeRouteOptions(options));
}

async function chooseRuntimeRoute(paths: RuntimePaths, task: Task, models: ModelCatalogEntry[] = [], options: RuntimeRouteOptions = {}): Promise<RouteChoice> {
  const requestedModel = options.requestedModelId?.trim();
  const requestedProvider = options.requestedProvider;
  const candidates = requestedProvider ? [requestedProvider] : fallbackProviders(task.risk);
  if (requestedModel) return chooseRequestedModelRoute(paths, task, models, candidates, requestedModel, requestedProvider);
  const scored: RouteChoice[] = [];
  for (const provider of candidates) {
    const availability = await routeAvailability(paths, provider);
    const model = models.find((entry) => entry.provider === provider && entry.codingGate.eligible && !entry.requiresApproval);
    scored.push({ provider, model, score: scoreRoute({ availability, risk: task.risk, model }), reason: `${availability}${model ? ` with ${model.id}` : ""}` });
  }
  const best = scored.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 0) return { provider: "manual", score: 0, reason: "no healthy provider; using manual fallback" };
  return best;
}

async function chooseRequestedModelRoute(
  paths: RuntimePaths,
  task: Task,
  models: ModelCatalogEntry[],
  candidates: ProviderId[],
  requestedModel: string,
  requestedProvider?: ProviderId,
): Promise<RouteChoice> {
  const providerMatches = models
    .filter((entry) => candidates.includes(entry.provider))
    .filter((entry) => (requestedProvider ? entry.provider === requestedProvider : true))
    .filter((entry) => matchesModel(entry, requestedModel));
  if (!providerMatches.length) {
    if (requestedProvider && DIRECT_LAUNCH_PROVIDERS.includes(requestedProvider)) {
      const availability = await routeAvailability(paths, requestedProvider);
      const score = scoreRoute({ availability, risk: task.risk, model: undefined });
      if (score < 0) return { provider: "manual", score: 0, reason: `${requestedProvider} unavailable; using manual fallback` };
      return {
        provider: requestedProvider,
        modelId: requestedModel,
        score,
        reason: `${availability} with uncached requested model ${requestedModel}`,
      };
    }
    const providerText = requestedProvider ? ` for provider ${requestedProvider}` : "";
    throw new Error(`Model not found${providerText}: ${requestedModel}`);
  }

  const blocked = providerMatches.filter((entry) => !entry.codingGate.eligible || entry.requiresApproval);
  const model = providerMatches.find((entry) => entry.codingGate.eligible && !entry.requiresApproval);
  if (!model) {
    const reasons = [...new Set(blocked.flatMap((entry) => [...entry.codingGate.reasons, entry.requiresApproval ? "requires approval" : ""]))].filter(Boolean);
    throw new Error(`Model is not eligible for automatic coding route: ${requestedModel}${reasons.length ? ` (${reasons.join(", ")})` : ""}`);
  }

  const availability = await routeAvailability(paths, model.provider);
  const score = scoreRoute({ availability, risk: task.risk, model });
  if (score < 0) return { provider: "manual", score: 0, reason: `${model.provider} unavailable; using manual fallback` };
  return { provider: model.provider, model, score, reason: `${availability} with requested model ${model.id}` };
}

async function routeAvailability(paths: RuntimePaths, provider: ProviderId): Promise<ProviderAvailability> {
  const override = await getManualProviderAvailability(paths, provider);
  if (override !== "unknown") return override;
  try {
    return (await providerAdapter(provider).status({ paths, cwd: paths.rootDir })).availability;
  } catch {
    return "unavailable";
  }
}

function matchesModel(entry: ModelCatalogEntry, requestedModel: string): boolean {
  return entry.id === requestedModel || entry.aliases.includes(requestedModel) || `${entry.provider}:${entry.id}` === requestedModel;
}

function normalizeRuntimeRouteOptions(options?: ProviderId | RuntimeRouteOptions): RuntimeRouteOptions {
  if (!options) return {};
  if (typeof options === "string") return { requestedProvider: options };
  return options;
}

function chooseFromCandidates(candidates: RouteCandidate[], options: { now?: Date } = {}): RouteSelection {
  const now = options.now ?? new Date();
  const routes: RouteCandidate[] = [];
  const blocked: Array<RouteCandidate & { reasons: string[] }> = [];
  for (const candidate of candidates) {
    const reasons = blockReasons(candidate, now);
    if (reasons.length) blocked.push({ ...candidate, reasons });
    else routes.push(candidate);
  }
  return {
    selected: routes[0],
    fallback: { routes, blocked },
  };
}

function blockReasons(candidate: RouteCandidate, now: Date): string[] {
  const reasons: string[] = [];
  if (candidate.providerAvailability === "unavailable") reasons.push("provider is unavailable");
  if (candidate.model.costCategory === "unknown") reasons.push("unknown pricing");
  if (candidate.model.requiresApproval) reasons.push("price requires approval");
  if (candidate.model.costCategory === "paid_api" && isStale(candidate.model.source.expiresAt, now)) reasons.push("stale paid pricing");
  if (!candidate.model.codingGate.eligible) reasons.push("model failed coding gate");
  return reasons;
}

function isStale(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) <= now.getTime();
}
