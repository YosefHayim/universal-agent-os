import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderResult, Task, ValidationItem, ValidationResult } from "../core/types.js";
import { changedFilesFromPatch } from "../workspace/diff.js";
import { validateChangeSize } from "./change-size-check.js";
import { validateDependencyGate } from "./dependency-check.js";
import { validateNoSecrets } from "./secrets-check.js";
import { isInScope } from "./scope-check.js";
import { validateNotNoop } from "./no-op-check.js";
import { validateResultSchema } from "./result-schema.js";

export interface ValidationInput {
  task: Task;
  taskDir: string;
  workerId: string;
}

export interface ValidatorPipelineInput {
  workerResult?: ProviderResult;
  diffPatch: string;
  allowedFiles: string[];
  maxChangedFiles?: number;
  maxDiffLines?: number;
}

export async function validateTaskRun(input: ValidationInput): Promise<ValidationResult> {
  const workerDir = join(input.taskDir, "workers", input.workerId);
  const patch = await readOptional(join(workerDir, "diff.patch"));
  const result = await readJsonOptional<ProviderResult>(join(workerDir, "result.json"));
  const changedFiles = result?.changedFiles?.length ? result.changedFiles : changedFilesFromPatch(patch);
  const scope = isInScope(changedFiles, input.task.allowedFiles);
  const validators: ValidationItem[] = [
    validateResultSchema(result),
    scope.passed ? { id: "scope_check", status: "passed" } : { id: "scope_check", status: "failed", message: `out of scope: ${scope.outOfScope.join(", ")}` },
    validateNoSecrets(patch),
    validateDependencyGate(changedFiles),
    validateNotNoop(changedFiles, patch),
    validateChangeSize(changedFiles, patch),
  ];
  const failed = validators.some((item) => item.status === "failed");
  const warnings = validators.filter((item) => item.status === "warning");
  const output: ValidationResult = {
    status: failed ? "failed" : "passed",
    validators,
    requiresHuman: failed || warnings.length > 0,
    notes: warnings.map((item) => item.message || item.id),
  };
  const outputPath = join(input.taskDir, "validation", "validation-result.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

export async function runValidatorPipeline(input: ValidatorPipelineInput): Promise<ValidationResult> {
  const changedFiles = input.workerResult?.changedFiles?.length ? input.workerResult.changedFiles : changedFilesFromPatch(input.diffPatch);
  const scope = isInScope(changedFiles, input.allowedFiles);
  const validators: ValidationItem[] = [
    validateResultSchema(input.workerResult),
    scope.passed ? { id: "scope_check", status: "passed" } : { id: "scope_check", status: "failed", message: `out of scope: ${scope.outOfScope.join(", ")}` },
    validateNoSecrets(input.diffPatch),
    validateDependencyGate(changedFiles),
    validateNotNoop(changedFiles, input.diffPatch),
    validatePipelineChangeSize(changedFiles, input.diffPatch, input.maxChangedFiles, input.maxDiffLines),
  ];
  const failed = validators.some((item) => item.status === "failed");
  return {
    status: failed ? "failed" : "passed",
    validators,
    requiresHuman: failed || validators.some((item) => item.status === "warning"),
    notes: validators.filter((item) => item.status !== "passed").map((item) => item.message || item.id),
  };
}

function validatePipelineChangeSize(changedFiles: string[], patch: string, maxChangedFiles = 20, maxDiffLines = 1_000): ValidationItem {
  const lineCount = patch.split("\n").filter(Boolean).length;
  if (changedFiles.length > maxChangedFiles) return { id: "change_size_check", status: "failed", message: `too many changed files: ${changedFiles.length}` };
  if (lineCount > maxDiffLines) return { id: "change_size_check", status: "failed", message: `diff has too many lines: ${lineCount}` };
  return { id: "change_size_check", status: "passed" };
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readJsonOptional<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
