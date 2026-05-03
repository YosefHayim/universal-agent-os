/**
 * Per-provider plan detector dispatcher with a small in-memory cache.
 *
 * Each detector reads local auth/config artifacts only — never makes a network
 * call — so the cache here just amortizes FS + keychain reads across the
 * frequent panel ticks (every ~5s in `watch.tsx`). TTL is 60s; callers can
 * force a refresh via `detectProviderSubscription(provider, { force: true })`.
 *
 * Adding a new provider: drop a `<provider>.ts` file exporting an async
 * detector returning `ProviderSubscription`, then register it in the dispatch
 * table below. Detectors must not throw — they return
 * `{ active: false, plan: "—", source: <where-we-looked> }` on any failure.
 */

import { detectAnthropic } from "./anthropic.js";
import { detectCline } from "./cline.js";
import { detectGemini } from "./gemini.js";
import { detectKilo } from "./kilo.js";
import { detectOpencode } from "./opencode.js";
import { detectOpenAI } from "./openai.js";
import { type ProviderSubscription } from "./types.js";
import { detectZai } from "./zai.js";

type Detector = () => Promise<ProviderSubscription>;

/** Provider name → detector. Provider names match the keys in PROVIDER_LIMITS. */
const detectors: Record<string, Detector> = {
  claude: detectAnthropic,
  codex: detectOpenAI,
  gemini: detectGemini,
  cline: detectCline,
  kilo: detectKilo,
  opencode: detectOpencode,
  zai: detectZai,
};

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: ProviderSubscription;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Returns the subscription state for one provider, hitting the cache when
 * fresh. `force` bypasses the cache for explicit user refresh actions.
 */
export async function detectProviderSubscription(
  provider: string,
  opts?: { force?: boolean },
): Promise<ProviderSubscription> {
  const now = Date.now();
  if (!opts?.force) {
    const cached = cache.get(provider);
    if (cached && cached.expiresAt > now) return cached.value;
  }

  const detector = detectors[provider];
  if (!detector) {
    const fallback: ProviderSubscription = { active: false, plan: "—", source: "no-detector" };
    cache.set(provider, { value: fallback, expiresAt: now + CACHE_TTL_MS });
    return fallback;
  }

  const value = await detector();
  cache.set(provider, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Clears the in-memory cache; the next call will re-read from disk. */
export function resetPlanDetectionCache(): void {
  cache.clear();
}
