import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readRegistryEntries, type RegistryEntry } from "../../core/global-registry.js";
import { detectProviderSubscription, type ProviderSubscription } from "./plan-detectors/index.js";

export type { ProviderSubscription };

// === PROVIDER STATE DISCOVERY ===
/**
 * Provider local-state discovery (read-only filesystem reconnaissance):
 * - codex:
 *   - `~/.codex/auth.json` stores auth tokens; JWT payload includes
 *     `https://api.openai.com/auth.chatgpt_plan_type`, account/user IDs, and email.
 *   - `~/.codex/config.toml` has local CLI config but no explicit subscription tier key.
 * - claude:
 *   - `~/.claude/settings.json` exists and can include env overrides (e.g. gateway tokens),
 *     but no reliable plan/subscription key discovered in this workspace.
 *   - `~/.claude/metrics/costs.jsonl` stores usage/cost telemetry samples (not plan/cap).
 * - gemini:
 *   - `~/.gemini/oauth_creds.json` contains OAuth tokens (active auth signal).
 *   - `~/.gemini/google_accounts.json` includes active account email.
 *   - `~/.config/gcloud/application_default_credentials.json` and
 *     `~/.config/gcloud/configurations/config_default` provide Google auth/account/project
 *     fallback signals used by Gemini-adjacent tooling.
 * - zai:
 *   - no `~/.zai` or `~/.glm` files were found in this workspace.
 * - opencode:
 *   - `~/.opencode/config.json` exists (MCP/settings), but no auth/plan/quota cache found.
 * - kilo:
 *   - no `~/.kilo` files were found in this workspace.
 * - cline:
 *   - `~/.cline/data/settings/providers.json` and `~/.cline/data/secrets.json` include
 *     provider auth tokens/session metadata and account email.
 *   - no subscription tier/cap counters discovered in inspected files.
 *
 * Non-interactive CLI flags check (`--help` only):
 * - codex: has non-interactive mode via `codex exec`, no dedicated `--status` flag surfaced.
 * - claude: has non-interactive output via `-p/--print` with `--output-format` variants.
 * - gemini: has non-interactive mode via `-p/--prompt` and `--output-format json`.
 * - zai/opencode: no help output found in this environment.
 * - kilo/cline: help available; no dedicated `--status`/`--usage` summary flag surfaced.
 */

/**
 * Documented provider windows are modeled as fixed rolling durations so the dashboard can report
 * comparable recent usage without guessing opaque quota internals that providers do not publish.
 */
export type LimitWindow = { label: string; windowMs: number };

/**
 * Provider limits keep public window shapes and optional explicit caps only where the cap is known.
 * Most providers intentionally omit tokenCap because the real enforcement is plan-specific and opaque.
 */
export type ProviderLimit = {
  provider: string;
  windows: LimitWindow[];
  monthlyTokenCap?: number;
  note?: string;
};

/**
 * Static limit definitions mirror publicly documented windows from late-2025/early-2026 and are
 * centralized for easy maintenance as plan docs evolve.
 */
export const PROVIDER_LIMITS: readonly ProviderLimit[] = [
  {
    provider: "claude",
    windows: [
      { label: "5h", windowMs: 5 * 60 * 60 * 1000 },
      { label: "weekly", windowMs: 7 * 24 * 60 * 60 * 1000 },
    ],
    note: "limit: opaque (per plan)",
  },
  {
    provider: "codex",
    windows: [
      { label: "5h", windowMs: 5 * 60 * 60 * 1000 },
      { label: "weekly", windowMs: 7 * 24 * 60 * 60 * 1000 },
    ],
    note: "limit: opaque (per plan)",
  },
  {
    provider: "gemini",
    windows: [{ label: "24h", windowMs: 24 * 60 * 60 * 1000 }],
    note: "limit: depends on tier",
  },
  {
    provider: "zai",
    windows: [{ label: "monthly", windowMs: 30 * 24 * 60 * 60 * 1000 }],
    monthlyTokenCap: 1_000_000,
  },
  {
    provider: "opencode",
    windows: [{ label: "—", windowMs: 0 }],
    note: "limit: uses upstream provider",
  },
  {
    provider: "kilo",
    windows: [{ label: "—", windowMs: 0 }],
    note: "limit: none documented",
  },
  {
    provider: "cline",
    windows: [{ label: "—", windowMs: 0 }],
    note: "limit: none documented",
  },
] as const;

/**
 * A normalized usage row per provider/window supports panel rendering while leaving percent undefined
 * whenever no trustworthy numeric cap exists.
 */
export type ProviderUsageStat = {
  provider: string;
  window: string;
  tokensUsed: number;
  tokenCap?: number;
  percent?: number;
  runs: number;
};

/**
 * One provider row with windows as columns for dashboard rendering.
 */
export type ProviderRow = {
  provider: string;
  subscription: ProviderSubscription;
  windows: {
    [label: string]: {
      tokensUsed: number;
      runs: number;
      cap?: number;
      percent?: number;
    };
  };
};

type UsageCacheEntry = { tokens: number; mtimeMs: number };

const usageCache = new Map<string, UsageCacheEntry>();

/**
 * Computes usage for each configured provider window using registry timestamps as run-time anchors
 * and worker usage files as token sources; percentages are emitted only for explicit numeric caps.
 */
export async function computeProviderUsage(opts?: { now?: Date }): Promise<ProviderUsageStat[]> {
  const nowMs = (opts?.now ?? new Date()).getTime();
  const entries = latestEntries(await readRegistryEntries());
  const limitsByProvider = new Map(PROVIDER_LIMITS.map((row) => [row.provider, row]));
  const taskTotals = new Map<string, number>();

  const providerEntries = entries.filter((entry) => {
    const provider = entry.provider ?? "";
    if (!provider || provider === "manual") return false;
    return limitsByProvider.has(provider);
  });

  await Promise.all(providerEntries.map(async (entry) => {
    const taskKey = `${resolve(entry.repoRoot)}::${entry.taskId}`;
    if (taskTotals.has(taskKey)) return;
    taskTotals.set(taskKey, await readTaskUsageTokens(entry));
  }));

  const stats: ProviderUsageStat[] = [];
  for (const limit of PROVIDER_LIMITS) {
    for (const window of limit.windows) {
      let tokensUsed = 0;
      let runs = 0;
      for (const entry of providerEntries) {
        if (entry.provider !== limit.provider) continue;
        if (window.windowMs > 0) {
          const createdAtMs = Date.parse(entry.createdAt);
          if (Number.isNaN(createdAtMs) || createdAtMs < nowMs - window.windowMs || createdAtMs > nowMs) continue;
        }
        const taskKey = `${resolve(entry.repoRoot)}::${entry.taskId}`;
        tokensUsed += taskTotals.get(taskKey) ?? 0;
        runs += 1;
      }

      const tokenCap = limit.monthlyTokenCap;
      const percent = tokenCap && tokenCap > 0 ? Math.max(0, Math.min(100, (tokensUsed / tokenCap) * 100)) : undefined;
      stats.push({
        provider: limit.provider,
        window: window.label,
        tokensUsed,
        tokenCap,
        percent,
        runs,
      });
    }
  }

  return stats.sort((a, b) => {
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.window.localeCompare(b.window);
  });
}

/**
 * Builds one row per provider with subscription state plus per-window usage/cap details.
 */
export async function buildProviderRows(opts?: { now?: Date }): Promise<ProviderRow[]> {
  const stats = await computeProviderUsage(opts);
  const statsByProvider = new Map<string, ProviderUsageStat[]>();
  for (const stat of stats) {
    const rows = statsByProvider.get(stat.provider) ?? [];
    rows.push(stat);
    statsByProvider.set(stat.provider, rows);
  }

  const rows: ProviderRow[] = [];
  for (const limit of PROVIDER_LIMITS) {
    const subscription = await detectProviderSubscription(limit.provider);
    const providerStats = statsByProvider.get(limit.provider) ?? [];
    const windows: ProviderRow["windows"] = {};
    for (const row of providerStats) {
      windows[row.window] = {
        tokensUsed: row.tokensUsed,
        runs: row.runs,
        cap: row.tokenCap,
        percent: row.tokenCap && row.tokenCap > 0 ? Math.max(0, Math.min(100, (row.tokensUsed / row.tokenCap) * 100)) : undefined,
      };
    }
    rows.push({ provider: limit.provider, subscription, windows });
  }
  return rows;
}

function latestEntries(entries: RegistryEntry[]): RegistryEntry[] {
  const latestByTask = new Map<string, RegistryEntry>();
  for (const entry of entries) latestByTask.set(entry.taskId, entry);
  return [...latestByTask.values()];
}

async function readTaskUsageTokens(entry: RegistryEntry): Promise<number> {
  const workerRoot = join(entry.repoRoot, ".agent-os", "tasks", entry.taskId, "workers");
  let directories: string[] = [];
  try {
    const dirents = await readdir(workerRoot, { withFileTypes: true });
    directories = dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
  } catch {
    return 0;
  }

  const perWorker = await Promise.all(directories.map(async (workerId) => {
    const usagePath = join(workerRoot, workerId, "usage.json");
    return readUsageTokens(usagePath);
  }));

  return perWorker.reduce((sum, tokens) => sum + tokens, 0);
}

async function readUsageTokens(path: string): Promise<number> {
  const absolutePath = resolve(path);
  try {
    const fileStat = await stat(absolutePath);
    const cached = usageCache.get(absolutePath);
    if (cached && cached.mtimeMs === fileStat.mtimeMs) return cached.tokens;

    const parsed = await readJsonFile(absolutePath);
    const tokens = parseTokens(parsed);
    usageCache.set(absolutePath, { tokens, mtimeMs: fileStat.mtimeMs });
    return tokens;
  } catch {
    return 0;
  }
}

async function readJsonFile(path: string): Promise<Record<string, number | string | boolean | null | object>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, number | string | boolean | null | object>;
}

function parseTokens(value: Record<string, number | string | boolean | null | object>): number {
  const total = typeof value.totalTokens === "number" ? value.totalTokens : undefined;
  const estimated = typeof value.estimatedTotalTokens === "number" ? value.estimatedTotalTokens : undefined;
  const tokens = total ?? estimated ?? 0;
  return Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
}
