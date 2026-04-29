import { basename } from "node:path";
import type { ProviderId, Task } from "../core/types.js";

export interface WorkerPromptOptions {
  provider: ProviderId;
  weakModel?: boolean;
}

export function buildWorkerPrompt(task: Task, bundlePath: string, options: WorkerPromptOptions): string {
  const allowedFiles = task.allowedFiles.length > 0 ? task.allowedFiles.join(", ") : "(none)";
  const base = [
    "<agent-os-worker-task>",
    `Provider: ${options.provider}`,
    `Bundle: ${basename(bundlePath)}`,
    `Goal: ${task.goal}`,
    `Allowed files: ${allowedFiles}`,
    "</agent-os-worker-task>",
    "",
    "<execution-rules>",
    "1. Read the Agent OS bundle before editing.",
    "2. Execute the requested task inside this isolated workspace.",
    "3. If the task requires creating or editing files, actually create or edit those files before your final response.",
    "4. Only change files allowed by the bundle scope.",
    "5. Allowed globs may point at files or directories that do not exist yet; create requested files inside the allowed scope.",
    "6. Follow the task goal literally; when exact file content is requested, preserve every requested word and byte.",
    "7. For exact content, copy the requested content literally; do not add punctuation, correct grammar, normalize wording, or infer extra formatting.",
    "8. Prose punctuation after an exact item is not file content unless it is inside quotes, code, JSON, or an explicit fenced block.",
    "9. If the task says pipes are separators, split on `|` and remove the pipe characters from the written content.",
    "10. Do not ask for confirmation and do not stop after summarizing the task.",
    "11. If you do not produce a file diff for an edit task, the run will fail validation.",
    "</execution-rules>",
  ];

  if (!options.weakModel) {
    return [
      ...base,
      "",
      "<final-response>",
      "Return concise JSON with status, summary, and changedFiles.",
      "</final-response>",
    ].join("\n");
  }

  return [
    ...base,
    "",
    "<low-cost-free-worker-system-prompt>",
    "Use this extra contract for low-cost/free worker models.",
    "",
    "<evidence-rules>",
    "- Do not claim file contents, commands, tests, docs, APIs, errors, or execution results unless they are present in the bundle or you actually observed them while working.",
    "- Only report files, commands, tests, and outputs you actually observed.",
    "- If evidence is missing, say what is missing instead of inventing it.",
    "- Missing or blank command output is not passing evidence.",
    "- Do not claim tests passed unless you ran them and saw passing output.",
    "</evidence-rules>",
    "",
    "<scope-rules>",
    "- Respect the allowed files list.",
    "- Missing allowed target files or directories are not blockers; create them when the task asks for new files.",
    "- If the requested change is outside allowed files, return a failed JSON result with changedFiles as an empty array.",
    "- Do not expose secrets or local credentials.",
    "</scope-rules>",
    "",
    "<engineering-rules>",
    "- Use KISS, YAGNI, DRY: make the smallest local change that satisfies the task, reuse existing code, and avoid speculative wrappers, registries, files, or abstractions.",
    "- Run a deslop pass before finishing: no TODOs, placeholders, filler prose, dead code, or unrelated cleanup.",
    "</engineering-rules>",
    "",
    "<examples>",
    "- Exact content example: if the requested line is `hallucination-policy: report missing evidence`, write exactly `hallucination-policy: report missing evidence`, not `hallucination-policy: report missing evidence.`",
    "- Prose punctuation example: if the task says `line: hallucination-policy: report missing evidence. Use real newlines`, the period before `Use` closes the instruction sentence and is not part of the line.",
    "- Pipe separator example: if the task says `a | b | c` and `Use real newlines instead of pipes`, write `a`, `b`, and `c` on separate lines with no `|` characters.",
    "- Verification example: if `claimedTestsPassed` is true and `testOutput` is empty or missing, treat tests as unverified and report missing test evidence.",
    "- Missing target example: if allowed files is `eval-output/**` and `eval-output/` is missing, create `eval-output/` and the requested file.",
    "</examples>",
    "",
    "<final-response>",
    "Raw JSON only: {\"status\":\"completed|failed\",\"summary\":\"...\",\"changedFiles\":[\"...\"]}",
    "Use no markdown fences, no prose before JSON, and no prose after JSON.",
    "</final-response>",
    "</low-cost-free-worker-system-prompt>",
  ].join("\n");
}
