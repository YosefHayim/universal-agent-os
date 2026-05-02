/**
 * Captures `anthropic-ratelimit-*` response headers from any Anthropic API call
 * made in the current process and exposes a parsed snapshot for the TUI.
 *
 * Why a singleton: provider-limits.ts and the UsageLimitsPanel run in the
 * same process as `agent-os watch`. If the orchestrator (or any caller in this
 * process) hits the Anthropic API, it should call recordAnthropicHeaders with
 * the response headers; the panel reads the latest snapshot.
 *
 * Plan tier inference is a heuristic (not authoritative) based on the size of
 * the input-tokens limit advertised by the API. Anthropic does not publish a
 * canonical mapping, so the labels are best-effort hints, not contract.
 */

export interface AnthropicRateLimitSnapshot {
  /** Inferred plan tier label (Free/Pro/Team/Max) derived from the tokens limit. Not authoritative. */
  planTier: string;
  /** Raw input-tokens-per-minute limit from `anthropic-ratelimit-input-tokens-limit`. */
  inputTokensLimit?: number;
  /** Reset timestamp (ms epoch) for the input-tokens window, derived from `anthropic-ratelimit-input-tokens-reset`. */
  inputTokensResetAt?: number;
  /** Output-tokens-per-minute limit. */
  outputTokensLimit?: number;
  outputTokensResetAt?: number;
  /** Time the snapshot was captured (ms epoch). */
  capturedAt: number;
}

let latest: AnthropicRateLimitSnapshot | undefined;

/**
 * Header bag accepted as a `Headers` instance, plain record, or array of pairs.
 * Keys are matched case-insensitively because `node:fetch` lowercases headers
 * but vendor SDKs sometimes pass the original casing.
 */
type HeaderInput = Headers | Record<string, string | string[] | undefined> | Array<[string, string]>;

function pick(headers: HeaderInput, name: string): string | undefined {
  const target = name.toLowerCase();
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(target) ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === target) return value;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function inferPlanTier(inputTokensLimit: number | undefined): string {
  if (!inputTokensLimit || !Number.isFinite(inputTokensLimit)) return "unknown";
  if (inputTokensLimit > 1_000_000) return "Max";
  if (inputTokensLimit > 200_000) return "Pro";
  return "Free";
}

/**
 * Records an Anthropic API response's rate-limit headers. Safe to call from
 * any provider/SDK wrapper; missing headers simply produce an undefined field.
 */
export function recordAnthropicHeaders(headers: HeaderInput): void {
  const inputLimit = Number(pick(headers, "anthropic-ratelimit-input-tokens-limit"));
  const outputLimit = Number(pick(headers, "anthropic-ratelimit-output-tokens-limit"));
  const inputReset = pick(headers, "anthropic-ratelimit-input-tokens-reset");
  const outputReset = pick(headers, "anthropic-ratelimit-output-tokens-reset");
  const inputTokensLimit = Number.isFinite(inputLimit) && inputLimit > 0 ? inputLimit : undefined;

  latest = {
    planTier: inferPlanTier(inputTokensLimit),
    inputTokensLimit,
    inputTokensResetAt: inputReset ? Date.parse(inputReset) || undefined : undefined,
    outputTokensLimit: Number.isFinite(outputLimit) && outputLimit > 0 ? outputLimit : undefined,
    outputTokensResetAt: outputReset ? Date.parse(outputReset) || undefined : undefined,
    capturedAt: Date.now(),
  };
}

/** Returns the most recent rate-limit snapshot, or undefined if no Anthropic call has been observed. */
export function getAnthropicRateLimitSnapshot(): AnthropicRateLimitSnapshot | undefined {
  return latest;
}

/** Test/reset helper. */
export function resetAnthropicRateLimitSnapshot(): void {
  latest = undefined;
}
