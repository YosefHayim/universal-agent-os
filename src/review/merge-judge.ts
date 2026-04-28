import type { ValidationResult } from "../core/types.js";

export interface MergeDecision {
  status: "approved" | "blocked";
  reason: string;
}

export interface LegacyMergeDecision {
  allowed: boolean;
  reasons: string[];
}

export function judgeMerge(input: { validation: ValidationResult; reviewApproved?: boolean }): LegacyMergeDecision;
export function judgeMerge(validation: ValidationResult, approved?: boolean): MergeDecision;
export function judgeMerge(
  validationOrInput: ValidationResult | { validation: ValidationResult; reviewApproved?: boolean },
  approved = false,
): MergeDecision | LegacyMergeDecision {
  if ("validation" in validationOrInput) {
    const validation = validationOrInput.validation;
    const reasons: string[] = [];
    if (validation.status !== "passed") reasons.push("validators failed");
    if (validation.requiresHuman) reasons.push("human approval required");
    if (!validationOrInput.reviewApproved && validation.requiresHuman) reasons.push("review approval missing");
    return { allowed: reasons.length === 0, reasons };
  }
  const validation = validationOrInput;
  if (validation.status !== "passed") return { status: "blocked", reason: "validators failed" };
  if (validation.requiresHuman && !approved) return { status: "blocked", reason: "human approval required" };
  return { status: "approved", reason: "validation passed" };
}
