/**
 * Anthropic / Claude Code plan detector.
 *
 * Sources of truth, in priority order:
 * 1. macOS keychain entry `Claude Code-credentials` — the Claude Code CLI
 *    stores OAuth subscription info as a JSON blob with the field
 *    `claudeAiOauth.subscriptionType` (e.g. "max", "pro", "free") and
 *    `claudeAiOauth.rateLimitTier` (e.g. "default_claude_max_20x"). This is
 *    authoritative when present.
 * 2. `~/.claude/.credentials.json` — older / non-mac Claude Code installs may
 *    write the same JSON shape to disk instead of the keychain.
 * 3. Anthropic API rate-limit headers captured in-process (heuristic only).
 * 4. `~/.claude/settings.json` env tokens — only used as an "active" signal
 *    when no plan info is reachable.
 *
 * No tokens or secrets are stored anywhere new — we only read fields needed
 * to determine the plan label.
 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAnthropicRateLimitSnapshot } from "../anthropic-rate-limits.js";
import {
  type ProviderSubscription,
  getRecordField,
  getStringField,
  normalizePlanLabel,
  readJsonSafe,
} from "./types.js";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Reads the Claude Code keychain entry on macOS via `security find-generic-password`.
 * The command prints a JSON blob to stdout when -w is passed; we parse only
 * the small subset we need. Bounded to a 2s timeout so a stuck keychain
 * prompt cannot block the TUI.
 */
async function readKeychainCredentials(): Promise<Record<string, unknown> | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      timeout: 2000,
      maxBuffer: 256 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the plan label from a Claude Code OAuth credentials blob.
 * The shape is `{ claudeAiOauth: { subscriptionType, rateLimitTier, ... } }`.
 */
function planFromOauthBlob(blob: Record<string, unknown> | undefined): string | undefined {
  if (!blob) return undefined;
  const oauth = getRecordField(blob, "claudeAiOauth");
  if (!oauth) return undefined;
  return getStringField(oauth, "subscriptionType") ?? getStringField(oauth, "rateLimitTier");
}

async function readDirHasEntry(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export async function detectAnthropic(): Promise<ProviderSubscription> {
  const home = process.env.HOME ?? "";
  const credentialsPath = join(home, ".claude", ".credentials.json");
  const settingsPath = join(home, ".claude", "settings.json");
  const projectsDir = join(home, ".claude", "projects");

  const keychainBlob = await readKeychainCredentials();
  const keychainPlan = planFromOauthBlob(keychainBlob);
  if (keychainPlan) {
    return {
      active: true,
      plan: normalizePlanLabel(keychainPlan),
      source: `keychain:${KEYCHAIN_SERVICE}`,
    };
  }

  const fileBlob = await readJsonSafe(credentialsPath);
  const filePlan = planFromOauthBlob(fileBlob);
  if (filePlan) {
    return {
      active: true,
      plan: normalizePlanLabel(filePlan),
      source: credentialsPath,
    };
  }

  const snapshot = getAnthropicRateLimitSnapshot();
  if (snapshot && snapshot.planTier && snapshot.planTier !== "unknown") {
    return {
      active: true,
      plan: normalizePlanLabel(snapshot.planTier),
      source: "anthropic-ratelimit-headers",
    };
  }

  const [settings, hasProjects] = await Promise.all([readJsonSafe(settingsPath), readDirHasEntry(projectsDir)]);
  const env = settings ? getRecordField(settings, "env") : undefined;
  const hasEnvToken = Boolean(env && (getStringField(env, "ANTHROPIC_AUTH_TOKEN") || getStringField(env, "ANTHROPIC_API_KEY")));
  const active = hasEnvToken || hasProjects || Boolean(fileBlob);
  return {
    active,
    plan: active ? "?" : "—",
    source: hasEnvToken ? settingsPath : hasProjects ? projectsDir : credentialsPath,
  };
}
