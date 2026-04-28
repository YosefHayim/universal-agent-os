import type { RiskLevel } from "../core/types.js";

export type IsolationMode = "temp_copy" | "git_worktree";

export function chooseIsolation(risk: RiskLevel, supportsWorktree: boolean): IsolationMode {
  if (risk === "low" && supportsWorktree) return "git_worktree";
  return "temp_copy";
}

export function chooseIsolationMode(input: {
  risk: RiskLevel;
  isGitRepository: boolean;
  providerSupportsWorktree: boolean;
}): IsolationMode {
  if (input.risk === "low" && input.isGitRepository && input.providerSupportsWorktree) return "git_worktree";
  return "temp_copy";
}
