import type { ProviderResult, ValidationItem } from "../core/types.js";

export function validateResultSchema(result: ProviderResult | undefined): ValidationItem {
  if (!result) return { id: "result_schema", status: "failed", message: "missing result artifact" };
  if (!["completed", "failed", "limited"].includes(result.status)) return { id: "result_schema", status: "failed", message: "invalid result status" };
  if (!result.summary?.trim()) return { id: "result_schema", status: "failed", message: "summary is required" };
  if (!Array.isArray(result.changedFiles)) return { id: "result_schema", status: "failed", message: "changedFiles must be an array" };
  return { id: "result_schema", status: result.status === "completed" ? "passed" : "failed", message: result.summary };
}
