import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "./adapter.js";
import type { LaunchCommand, ProviderContext, ProviderId, ProviderResult, ProviderUsage, Task, WorkerRecord } from "../core/types.js";
import { createWorkerId } from "../core/ids.js";
import { buildRunUsage } from "../usage/usage.js";
import { captureWorkspaceDiff } from "../workspace/diff.js";
import { createTempCopy } from "../workspace/temp-copy.js";

export interface ExternalProviderRun {
  worker: WorkerRecord;
  result: ProviderResult;
  patch: string;
  durationMs: number;
  usage: ProviderUsage;
}

export interface ExternalProviderProgress {
  taskId?: string;
  event:
    | "worker_prepared"
    | "worker_launching"
    | "provider_output"
    | "provider_error_output"
    | "worker_exited"
    | "diff_captured"
    | "worker_finished";
  provider: ProviderId;
  workerId: string;
  message?: string;
  durationMs?: number;
  usage?: ProviderUsage;
}

export async function runExternalProvider(
  ctx: ProviderContext,
  task: Task,
  bundlePath: string,
  adapter: ProviderAdapter,
  options: { modelId?: string; onProgress?: (event: ExternalProviderProgress) => void | Promise<void> } = {},
): Promise<ExternalProviderRun> {
  const workerId = createWorkerId(adapter.id);
  const workerPath = join(ctx.paths.tasksDir, task.id, "workers", workerId);
  await mkdir(workerPath, { recursive: true });
  const workspacePath = await mkdtemp(join(tmpdir(), `${task.id}-${workerId}-`));
  await createTempCopy(ctx.cwd, workspacePath);
  const workerBundlePath = join(workspacePath, "agent-os-bundle.md");
  await copyFile(bundlePath, workerBundlePath);
  await emitProgress(options.onProgress, { taskId: task.id, event: "worker_prepared", provider: adapter.id, workerId, message: workspacePath });

  const startedAt = new Date().toISOString();
  const launchCommand = await adapter.buildLaunchCommand(ctx, task, workerBundlePath, options.modelId);
  await writeFile(join(workerPath, "launch-command.json"), `${JSON.stringify(launchCommand, null, 2)}\n`, "utf8");
  await emitProgress(options.onProgress, {
    taskId: task.id,
    event: "worker_launching",
    provider: adapter.id,
    workerId,
    message: `${launchCommand.command} ${launchCommand.args.join(" ")}`.trim(),
  });

  const startedMs = Date.now();
  const processResult = await runProcess(launchCommand, workspacePath, adapter.id, workerId, task.id, options.onProgress);
  const durationMs = Date.now() - startedMs;
  await emitProgress(options.onProgress, {
    taskId: task.id,
    event: "worker_exited",
    provider: adapter.id,
    workerId,
    durationMs,
    message: `exit ${processResult.exitCode}${processResult.signal ? ` signal ${processResult.signal}` : ""}`,
  });

  const stdout = processResult.stdout;
  const stderr = [processResult.stderr, processResult.errorMessage].filter(Boolean).join("\n");
  const exitCode = processResult.exitCode;
  const limited = await adapter.isLimitReached(ctx, exitCode, stdout, stderr);
  const diff = await captureWorkspaceDiff({
    sourceDir: ctx.cwd,
    workspacePath,
    allowedFiles: task.allowedFiles,
    isolation: "temp_copy",
  });
  await emitProgress(options.onProgress, {
    taskId: task.id,
    event: "diff_captured",
    provider: adapter.id,
    workerId,
    message: `${diff.changedFiles.length} changed file(s)`,
  });
  const result = await buildProviderResult(ctx, adapter, exitCode, stdout, stderr, limited, diff.changedFiles);
  const finishedAt = new Date().toISOString();
  const usage = buildRunUsage({
    prompt: `${await readFile(workerBundlePath, "utf8")}\n${launchCommand.args.join(" ")}`,
    stdout,
    stderr,
  });
  const worker: WorkerRecord = {
    taskId: task.id,
    workerId,
    provider: adapter.id,
    workspacePath,
    isolation: "temp_copy",
    startedAt,
    finishedAt,
  };

  await writeFile(join(workerPath, "workspace.json"), `${JSON.stringify(worker, null, 2)}\n`, "utf8");
  await writeFile(join(workerPath, "heartbeat.json"), `${JSON.stringify({ taskId: task.id, workerId, status: "finished", checkedAt: finishedAt }, null, 2)}\n`, "utf8");
  await writeFile(join(workerPath, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(join(workerPath, "stdout.log"), stdout, "utf8");
  await writeFile(join(workerPath, "stderr.log"), stderr, "utf8");
  await writeFile(join(workerPath, "diff.patch"), diff.patch, "utf8");
  await writeFile(join(workerPath, "usage.json"), `${JSON.stringify(usage, null, 2)}\n`, "utf8");

  await emitProgress(options.onProgress, {
    taskId: task.id,
    event: "worker_finished",
    provider: adapter.id,
    workerId,
    durationMs,
    usage,
    message: result.summary,
  });

  return { worker, result, patch: diff.patch, durationMs, usage };
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: NodeJS.Signals | null;
  errorMessage?: string;
}

function runProcess(
  launchCommand: LaunchCommand,
  workspacePath: string,
  provider: ProviderId,
  workerId: string,
  taskId: string,
  onProgress?: (event: ExternalProviderProgress) => void | Promise<void>,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let errorMessage = "";
    let timedOut = false;
    const child = spawn(launchCommand.command, launchCommand.args, {
      cwd: launchCommand.cwd ?? workspacePath,
      env: { ...process.env, ...launchCommand.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 5_000);
    }, providerTimeoutMs());

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      emitProviderLines(onProgress, provider, workerId, text, "provider_output", taskId);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      emitProviderLines(onProgress, provider, workerId, text, "provider_error_output", taskId);
      if (isLimitText(text)) {
        errorMessage = "provider reported quota, rate, or capacity limit";
        killProcessGroup(child.pid, "SIGTERM");
      }
    });
    child.on("error", (error) => {
      errorMessage = error.message;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : code ?? (signal ? 124 : 1),
        signal,
        errorMessage: timedOut ? `${provider} timed out after ${providerTimeoutMs()}ms` : errorMessage,
      });
    });
  });
}

function isLimitText(value: string): boolean {
  return /RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|rateLimitExceeded|No capacity available|quota|credit limit/i.test(value);
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between timeout and cleanup.
    }
  }
}

function emitProviderLines(
  onProgress: ((event: ExternalProviderProgress) => void | Promise<void>) | undefined,
  provider: ProviderId,
  workerId: string,
  text: string,
  event: "provider_output" | "provider_error_output",
  taskId?: string,
): void {
  if (!onProgress) return;
  const lines = text.split(/\r?\n/).map((line) => readableProviderLine(line)).filter(Boolean).slice(-3);
  for (const line of lines) {
    void emitProgress(onProgress, { taskId, event, provider, workerId, message: line });
  }
}

async function emitProgress(
  onProgress: ((event: ExternalProviderProgress) => void | Promise<void>) | undefined,
  event: ExternalProviderProgress,
): Promise<void> {
  if (onProgress) await onProgress(event);
}

function readableProviderLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("{")) return trimLog(trimmed);
  try {
    const event = JSON.parse(trimmed) as {
      type?: string;
      role?: string;
      content?: string;
      item?: { type?: string; text?: string };
      part?: { type?: string; text?: string };
      result?: string;
      status?: string;
      stats?: unknown;
      error?: { name?: string; data?: { message?: string } };
      usage?: unknown;
    };
    if (event.error) return `error: ${event.error.data?.message ?? event.error.name ?? "provider error"}`;
    if (event.type === "error") return `error: ${trimLog(trimmed)}`;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
      return `agent: ${trimLog(event.item.text)}`;
    }
    if (event.type === "text" && event.part?.type === "text" && event.part.text) {
      return `agent: ${trimLog(event.part.text)}`;
    }
    if (event.type === "message" && event.role === "assistant" && event.content) {
      return `agent: ${trimLog(event.content)}`;
    }
    if (event.type === "result" && event.result) return `result: ${trimLog(event.result)}`;
    if (event.type === "result" && event.status) return `result: ${event.status}`;
    if (event.type === "turn.completed" || event.usage || event.stats) return "usage received";
  } catch {
    return "";
  }
  return "";
}

function providerTimeoutMs(): number {
  const value = Number(process.env.AGENT_OS_PROVIDER_TIMEOUT_MS ?? 10 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
}

async function buildProviderResult(
  ctx: ProviderContext,
  adapter: ProviderAdapter,
  exitCode: number,
  stdout: string,
  stderr: string,
  limited: { limited: boolean; reason?: string },
  changedFiles: string[],
): Promise<ProviderResult> {
  const provider = adapter.id;
  const parsed = await adapter.parseOutput(ctx, stdout, stderr);
  if (parsed.status === "completed" && changedFiles.length > 0) return { ...parsed, changedFiles };
  if (limited.limited) {
    return { status: "limited", summary: limited.reason ?? `${provider} reported a limit`, changedFiles };
  }
  if (exitCode !== 0) {
    return { status: "failed", summary: `${provider} exited ${exitCode}: ${trimLog(stderr || stdout)}`, changedFiles };
  }
  if (parsed.status !== "completed") return { ...parsed, changedFiles };
  return {
    status: "completed",
    summary: trimLog(finalAgentMessage(stdout) || lastNonEmptyLine(stdout) || `${provider} completed`),
    changedFiles,
  };
}

function trimLog(value: string): string {
  return value.trim().slice(0, 1000);
}

function lastNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

function finalAgentMessage(stdout: string): string {
  let finalText = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; part?: { type?: string; text?: string } };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        finalText = event.item.text;
      }
      if (event.type === "text" && event.part?.type === "text" && event.part.text) {
        finalText = event.part.text;
      }
    } catch {
      continue;
    }
  }
  return finalText;
}
