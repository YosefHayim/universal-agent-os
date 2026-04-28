import type { ValidationItem } from "../core/types.js";

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*[^\s]+/i,
];

export function validateNoSecrets(patch: string): ValidationItem {
  const leaked = SECRET_PATTERNS.some((pattern) => pattern.test(patch));
  return leaked
    ? { id: "secret_scan", status: "failed", message: "patch appears to contain a secret" }
    : { id: "secret_scan", status: "passed" };
}
