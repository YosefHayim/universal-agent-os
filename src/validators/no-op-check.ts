import type { ValidationItem } from "../core/types.js";

export function validateNotNoop(changedFiles: string[], patch: string): ValidationItem {
  return changedFiles.length > 0 && patch.trim().length > 0
    ? { id: "no_op_check", status: "passed" }
    : { id: "no_op_check", status: "failed", message: "worker produced no diff" };
}
