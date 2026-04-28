import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Task } from "../core/types.js";
import { readEvents } from "../core/events.js";

export async function buildReviewerInput(task: Task, taskDir: string, workerId: string): Promise<string> {
  const patch = await readOptional(join(taskDir, "workers", workerId, "diff.patch"));
  const validation = await readOptional(join(taskDir, "validation", "validation-result.json"));
  const events = await readEvents(taskDir);
  const content = [
    "# Reviewer Input",
    "",
    `Task: ${task.goal}`,
    `Allowed files: ${task.allowedFiles.join(", ")}`,
    `Risk: ${task.risk}`,
    "",
    "## Diff",
    "```diff",
    patch.trim(),
    "```",
    "",
    "## Validation",
    "```json",
    validation.trim(),
    "```",
    "",
    "## Event Summary",
    ...events.slice(-20).map((event) => `- ${event.timestamp} ${event.event}: ${event.message || event.outcome || ""}`),
    "",
  ].join("\n");
  const outputPath = join(taskDir, "review", "reviewer-input.md");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  return content;
}

export function buildDeltaReviewInput(input: {
  task: Pick<Task, "id" | "goal" | "allowedFiles" | "risk" | "cwd">;
  diffPatch: string;
  tests: string[];
  risks: string[];
  eventSummary: string;
  result: unknown;
  modelSource: string;
  transcript?: string;
}): string {
  return [
    "# Reviewer Input",
    "",
    "## Task",
    `Task: ${input.task.goal}`,
    `Allowed files: ${input.task.allowedFiles.join(", ")}`,
    `Risk: ${input.task.risk}`,
    "",
    "## Diff",
    "```diff",
    input.diffPatch,
    "```",
    "",
    "## Tests",
    ...input.tests.map((item) => `- ${item}`),
    "",
    "## Risks",
    ...input.risks.map((item) => `- ${item}`),
    "",
    "## Event Summary",
    input.eventSummary,
    "",
    "## Result",
    "```json",
    JSON.stringify(input.result, null, 2),
    "```",
    "",
    `Model source: ${input.modelSource}`,
    "",
  ].join("\n");
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
