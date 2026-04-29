import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface GuardState {
  enabled: boolean;
  source: "default" | "file" | "env";
  path: string;
}

/**
 * Resolve the toggle file path used by both the agent-os CLI and the
 * universal-agent-toolkit `orchestrator-edit-guard.sh` hook. Honors
 * AGENT_OS_GUARD_FILE first, then XDG_CONFIG_HOME, then ~/.config.
 */
export function guardFilePath(): string {
  const override = process.env.AGENT_OS_GUARD_FILE;
  if (override && override.trim().length > 0) return override;
  const base = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  return join(base, "agent-os", "orchestrator-block.json");
}

/**
 * Read the orchestrator-guard toggle. Missing file means enabled (default-on)
 * so a fresh install protects the orchestrator's context window automatically.
 */
export async function readGuardState(): Promise<GuardState> {
  const path = guardFilePath();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    if (typeof parsed.enabled === "boolean") {
      return { enabled: parsed.enabled, source: "file", path };
    }
    return { enabled: true, source: "default", path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { enabled: true, source: "default", path };
    }
    throw error;
  }
}

/**
 * Persist the toggle. Creates parent directories on first write.
 */
export async function writeGuardState(enabled: boolean): Promise<GuardState> {
  const path = guardFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
  return { enabled, source: "file", path };
}
