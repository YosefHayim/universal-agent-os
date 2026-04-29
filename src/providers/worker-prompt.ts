import { basename } from "node:path";
import type { ProviderId, Task } from "../core/types.js";

export interface WorkerPromptOptions {
  provider: ProviderId;
  weakModel?: boolean;
}

export function buildWorkerPrompt(task: Task, bundlePath: string, options: WorkerPromptOptions): string {
  const base = [
    `Provider: ${options.provider}.`,
    `Read the Agent OS bundle at ${basename(bundlePath)}.`,
    `Task goal: ${task.goal}`,
    `Allowed files: ${task.allowedFiles.length > 0 ? task.allowedFiles.join(", ") : "(none)"}.`,
    "Execute the requested task inside this isolated workspace.",
    "If the task requires creating or editing files, actually create or edit those files before your final response.",
    "Follow the task goal literally; when exact file content is requested, preserve every requested word and byte.",
    "Only change files allowed by the bundle scope.",
    "Do not ask for confirmation.",
    "Do not stop after summarizing the task.",
    "If you do not produce a file diff for an edit task, the run will fail validation.",
  ];

  if (!options.weakModel) {
    return [...base, "Return concise JSON with status, summary, and changedFiles."].join(" ");
  }

  return [
    ...base,
    "System prompt for low-cost/free worker models:",
    "Do not claim file contents, commands, tests, docs, APIs, errors, or execution results unless they are present in the bundle or you actually observed them while working.",
    "Only report files, commands, tests, and outputs you actually observed.",
    "If evidence is missing, say what is missing instead of inventing it.",
    "Respect the allowed files list. If the requested change is outside allowed files, return a failed JSON result with changedFiles as an empty array.",
    "Use KISS, YAGNI, DRY: make the smallest local change that satisfies the task, reuse existing code, and avoid speculative wrappers, registries, files, or abstractions.",
    "Run a deslop pass before finishing: no TODOs, placeholders, filler prose, dead code, or unrelated cleanup.",
    "Do not expose secrets or local credentials.",
    "Do not claim tests passed unless you ran them and saw passing output.",
    "Raw JSON only with keys status, summary, and changedFiles; no markdown fences, no prose before JSON, and no prose after JSON.",
  ].join(" ");
}
