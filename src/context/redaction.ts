const SECRET_PATTERNS = [
  /([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*=)[^\s]+/gi,
  /(sk-[A-Za-z0-9_-]{16,})/g,
  /(ghp_[A-Za-z0-9_]{20,})/g,
];

export function redactSecrets(input: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, (_match, prefix) => `${prefix || ""}[REDACTED]`), input);
}
