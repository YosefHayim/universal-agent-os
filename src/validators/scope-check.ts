export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}

export function matchesGlob(path: string, glob: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedGlob = normalizePath(glob || "**/*");
  if (normalizedGlob === "**/*" || normalizedGlob === "**") return true;
  if (!normalizedGlob.includes("*")) return normalizedPath === normalizedGlob || normalizedPath.startsWith(`${normalizedGlob}/`);
  const pattern = `^${escapeRegExp(normalizedGlob).replaceAll("\\*\\*", ".*").replaceAll("\\*", "[^/]*")}$`;
  return new RegExp(pattern).test(normalizedPath);
}

export function isInScope(changedFiles: string[], allowedFiles: string[]): { passed: boolean; outOfScope: string[] } {
  const outOfScope = changedFiles.filter((file) => !matchesAnyGlob(file, allowedFiles));
  return { passed: outOfScope.length === 0, outOfScope };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
