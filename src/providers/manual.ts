import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LaunchCommand, LimitSignal, ModelCatalogEntry, ProviderCapabilities, ProviderContext, ProviderDetection, ProviderResult, ProviderStatus, Task } from "../core/types.js";
import { getProviderStatus } from "../config/config-loader.js";
import { createWorkerId } from "../core/ids.js";
import { buildSimplePatch } from "../workspace/diff.js";
import { createTempCopy, workerWorkspaceDir } from "../workspace/temp-copy.js";
import { taskDir } from "../core/lifecycle.js";
import type { ProviderAdapter } from "./adapter.js";

export const manualProvider: ProviderAdapter = {
  id: "manual",
  async detect(): Promise<ProviderDetection> {
    return { available: true, detail: "manual provider is built in" };
  },
  async status(ctx: ProviderContext): Promise<ProviderStatus> {
    return getProviderStatus(ctx.paths, "manual");
  },
  async capabilities(): Promise<ProviderCapabilities> {
    return { provider: "manual", canLaunch: true, structuredOutput: true, worktree: false, cloudHosted: false };
  },
  async discoverModels(): Promise<ModelCatalogEntry[]> {
    return [];
  },
  async buildLaunchCommand(_ctx: ProviderContext, _task: Task, bundlePath: string): Promise<LaunchCommand> {
    return { command: "manual", args: [bundlePath] };
  },
  async parseOutput(): Promise<ProviderResult> {
    return { status: "completed", summary: "manual provider completed", changedFiles: [] };
  },
  async isLimitReached(): Promise<LimitSignal> {
    return { limited: false };
  },
  async supportsWorktree(): Promise<boolean> {
    return false;
  },
  async supportsStructuredOutput(): Promise<boolean> {
    return true;
  },
};

export async function runManualTask(ctx: ProviderContext, task: Task): Promise<{ workerId: string; result: ProviderResult; patch: string }> {
  const workerId = createWorkerId("manual");
  const dir = taskDir(ctx.paths, task.id);
  const workerDir = join(dir, "workers", workerId);
  const workspace = workerWorkspaceDir(dir, workerId);
  await createTempCopy(ctx.cwd, workspace);
  const relativePath = chooseManualOutputPath(task.allowedFiles);
  const fullPath = join(workspace, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  const content = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "",
    `test('agent-os manual smoke for ${task.id}', () => {`,
    "  assert.equal(typeof 'agent-os', 'string');",
    "});",
    "",
  ].join("\n");
  await writeFile(fullPath, content, "utf8");
  const patch = await buildSimplePatch(ctx.cwd, workspace, [relativePath]);
  const result: ProviderResult = {
    status: "completed",
    summary: "manual provider wrote an isolated smoke test artifact",
    changedFiles: [relativePath],
  };
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "workspace.json"), `${JSON.stringify({ taskId: task.id, workerId, provider: "manual", workspacePath: workspace, isolation: "temp_copy", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  await writeFile(join(workerDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(join(workerDir, "diff.patch"), patch, "utf8");
  await writeFile(join(workerDir, "stdout.log"), "manual provider completed\n", "utf8");
  await writeFile(join(workerDir, "stderr.log"), "", "utf8");
  return { workerId, result, patch };
}

export interface ManualRunOptions {
  workerId?: string;
  summary?: string;
}

export async function runManualProvider(
  ctx: ProviderContext,
  task: Task,
  bundlePath: string,
  options: ManualRunOptions = {},
): Promise<{ worker: { taskId: string; workerId: string; provider: "manual"; workspacePath: string; isolation: "temp_copy"; startedAt: string; finishedAt: string }; result: ProviderResult }> {
  const workerId = options.workerId ?? createWorkerId("manual");
  const workerPath = join(ctx.paths.tasksDir, task.id, "workers", workerId);
  await mkdir(workerPath, { recursive: true });

  const bundle = await readFile(bundlePath, "utf8");
  const now = new Date().toISOString();
  const worker = {
    taskId: task.id,
    workerId,
    provider: "manual" as const,
    workspacePath: workerPath,
    isolation: "temp_copy" as const,
    startedAt: now,
    finishedAt: now,
  };
  const result: ProviderResult = {
    status: "completed",
    summary: options.summary ?? `Manual provider completed task ${task.id} without checkout edits.`,
    changedFiles: [],
    raw: {
      bundleBytes: Buffer.byteLength(bundle),
      note: "MVP manual provider records artifacts only.",
    },
  };

  await writeFile(join(workerPath, "workspace.json"), `${JSON.stringify(worker, null, 2)}\n`, "utf8");
  await writeFile(join(workerPath, "heartbeat.json"), `${JSON.stringify({ taskId: task.id, workerId, status: "finished", checkedAt: now }, null, 2)}\n`, "utf8");
  await writeFile(join(workerPath, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(join(workerPath, "stdout.log"), `${result.summary}\n`, "utf8");
  await writeFile(join(workerPath, "stderr.log"), "", "utf8");
  await writeFile(join(workerPath, "diff.patch"), "", "utf8");

  return { worker, result };
}

function chooseManualOutputPath(allowedFiles: string[]): string {
  const preferred = allowedFiles.find((glob) => glob.includes("tests/") || glob.startsWith("tests"));
  if (preferred) return "tests/agent-os-manual-smoke.test.ts";
  const first = allowedFiles[0] || "agent-os-manual-result.txt";
  if (first.endsWith("/**")) return `${first.slice(0, -3)}/agent-os-manual-smoke.test.ts`;
  if (first.includes("*")) return "agent-os-manual-result.txt";
  return first.endsWith(".ts") ? first : `${first.replace(/\/$/, "")}/agent-os-manual-smoke.test.ts`;
}
