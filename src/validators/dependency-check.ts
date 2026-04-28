import type { ValidationItem } from "../core/types.js";

const SENSITIVE_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "requirements.txt",
]);

export function validateDependencyGate(changedFiles: string[]): ValidationItem {
  const hits = changedFiles.filter((file) => SENSITIVE_FILES.has(file));
  return hits.length
    ? { id: "dependency_lockfile_gate", status: "failed", message: `dependency or lockfile change requires review: ${hits.join(", ")}` }
    : { id: "dependency_lockfile_gate", status: "passed" };
}
