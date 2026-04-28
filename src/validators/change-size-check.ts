import type { ValidationItem } from "../core/types.js";

export function validateChangeSize(changedFiles: string[], patch: string, maxFiles = 20, maxPatchBytes = 200_000): ValidationItem {
  if (changedFiles.length > maxFiles) return { id: "change_size_check", status: "failed", message: `too many changed files: ${changedFiles.length}` };
  if (Buffer.byteLength(patch, "utf8") > maxPatchBytes) return { id: "change_size_check", status: "failed", message: "patch is too large" };
  return { id: "change_size_check", status: "passed" };
}
