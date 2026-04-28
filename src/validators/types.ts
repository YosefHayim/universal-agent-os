import type { ValidationItem, ValidationResult } from "../core/types.js";

export interface ValidatorOutcome extends ValidationItem {
  requiresHuman?: boolean;
}

export function aggregateValidatorOutcomes(
  validators: ValidatorOutcome[],
  notes: string[] = [],
): ValidationResult {
  const status = validators.some((item) => item.status === "failed") ? "failed" : "passed";
  const requiresHuman = validators.some((item) => item.requiresHuman === true);

  return {
    status,
    validators: validators.map(({ id, status: itemStatus, message }) => ({
      id,
      status: itemStatus,
      ...(message ? { message } : {}),
    })),
    requiresHuman,
    notes,
  };
}
