import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";

/**
 * Cross-platform location for Agent OS user-level state.
 *
 * On every supported platform we stick to a single canonical
 * `~/.config/agent-os/` directory so the marker is easy to find,
 * version, and clean up. We deliberately avoid `$XDG_CONFIG_HOME`
 * branching for now (YAGNI) — the path can be promoted later if
 * users ask for full XDG compliance.
 */
export function onboardingConfigDir(): string {
  // homedir() is portable on Windows/macOS/Linux. We keep the dotfile
  // style on Windows too so behavior is identical across machines.
  return join(homedir(), ".config", "agent-os");
}

export function onboardingMarkerPath(): string {
  return join(onboardingConfigDir(), "onboarded");
}

/** True when the user has never completed onboarding on this machine. */
export async function isFirstRun(): Promise<boolean> {
  try {
    await stat(onboardingMarkerPath());
    return false;
  } catch {
    return true;
  }
}

/** Touch the marker so future invocations skip the first-run prompt. */
export async function markOnboarded(): Promise<void> {
  await mkdir(onboardingConfigDir(), { recursive: true });
  await writeFile(
    onboardingMarkerPath(),
    JSON.stringify({ completedAt: new Date().toISOString(), platform: platform() }, null, 2),
    "utf8",
  );
}
