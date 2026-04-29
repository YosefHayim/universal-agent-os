import { spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "./adapter.js";
import type { LaunchCommand, ProviderContext, ProviderId, ProviderResult, ProviderUsage, Task, WorkerRecord } from "../core/types.js";
import { createWorkerId } from "../core/ids.js";
import { buildRunUsage } from "../usage/usage.js";
import { captureWorkspaceDiff } from "../workspace/diff.js";
import { createTempCopy } from "../workspace/temp-copy.js";
import { directCliErrorMessage } from "./direct-cli-output.js";

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
  const stdoutPath = join(workerPath, "stdout.log");
  const stderrPath = join(workerPath, "stderr.log");
  const heartbeatPath = join(workerPath, "heartbeat.json");
  await writeFile(stdoutPath, "", "utf8");
  await writeFile(stderrPath, "", "utf8");
  await writeFile(heartbeatPath, `${JSON.stringify({ taskId: task.id, workerId, status: "running", checkedAt: startedAt }, null, 2)}\n`, "utf8");
  const processResult = await runProcess(launchCommand, workspacePath, workerPath, adapter.id, workerId, task.id, options.onProgress);
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
  workerPath: string,
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
    let idleTimedOut = false;
    let outputLimitHit = false;
    let outputBytes = 0;
    let lastOutputAt = new Date().toISOString();
    let lastHeartbeatWriteMs = 0;
    let pendingWrites = Promise.resolve();
    const stdoutPath = join(workerPath, "stdout.log");
    const stderrPath = join(workerPath, "stderr.log");
    const heartbeatPath = join(workerPath, "heartbeat.json");
    const maxOutputBytes = providerMaxOutputBytes();
    const idleTimeoutMs = providerIdleTimeoutMs();
    const child = spawn(launchCommand.command, launchCommand.args, {
      cwd: launchCommand.cwd ?? workspacePath,
      env: {
        ...process.env,
        ...launchCommand.env,
        AGENT_OS_TASK_ID: taskId,
        AGENT_OS_WORKER_ID: workerId,
        AGENT_OS_PROVIDER: provider,
        AGENT_OS_WORKER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let killTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      requestStop(`${provider} timed out after ${providerTimeoutMs()}ms`);
    }, providerTimeoutMs());
    resetIdleTimer();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      recordOutput(stdoutPath, text);
      emitProviderLines(onProgress, provider, workerId, text, "provider_output", taskId);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      recordOutput(stderrPath, text);
      emitProviderLines(onProgress, provider, workerId, text, "provider_error_output", taskId);
      if (isLimitText(text)) {
        requestStop("provider reported quota, rate, or capacity limit");
      }
    });
    child.on("error", (error) => {
      errorMessage = error.message;
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (idleTimer) clearTimeout(idleTimer);
      writeHeartbeat("exited", true);
      await pendingWrites;
      resolve({
        stdout,
        stderr,
        exitCode: timedOut || idleTimedOut || outputLimitHit ? 124 : code ?? (signal ? 124 : 1),
        signal,
        errorMessage,
      });
    });

    function recordOutput(path: string, text: string): void {
      const bytes = Buffer.byteLength(text, "utf8");
      outputBytes += bytes;
      lastOutputAt = new Date().toISOString();
      enqueueWrite(() => appendFile(path, text, "utf8"));
      writeHeartbeat("running");
      resetIdleTimer();
      if (outputBytes > maxOutputBytes && !outputLimitHit) {
        outputLimitHit = true;
        requestStop(`${provider} exceeded max output bytes (${maxOutputBytes})`);
      }
    }

    function resetIdleTimer(): void {
      if (!idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        requestStop(`${provider} produced no output for ${idleTimeoutMs}ms`);
      }, idleTimeoutMs);
    }

    function requestStop(message: string): void {
      if (!errorMessage) errorMessage = message;
      killProcessGroup(child.pid, "SIGTERM");
      killTimer ??= setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 5_000);
    }

    function writeHeartbeat(status: "running" | "exited", force = false): void {
      const now = Date.now();
      if (!force && now - lastHeartbeatWriteMs < 1000) return;
      lastHeartbeatWriteMs = now;
      enqueueWrite(() => writeFile(heartbeatPath, `${JSON.stringify({
        taskId,
        workerId,
        status,
        checkedAt: new Date().toISOString(),
        lastOutputAt,
        outputBytes,
        maxOutputBytes,
      }, null, 2)}\n`, "utf8"));
    }

    function enqueueWrite(action: () => Promise<void>): void {
      pendingWrites = pendingWrites.then(action, action).catch((error: unknown) => {
        if (!errorMessage) errorMessage = `provider log write failed: ${error instanceof Error ? error.message : String(error)}`;
      });
    }
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
      content?: string | Array<{ type?: string; text?: string }>;
      item?: { type?: string; text?: string };
      part?: { type?: string; text?: string };
      result?: string;
      status?: string;
      stats?: unknown;
      error?: unknown;
      message?: unknown;
      usage?: unknown;
    };
    if (event.error || event.type === "error") {
      return `error: ${directCliErrorMessage(event.error) || directCliErrorMessage(event.message) || trimLog(trimmed)}`;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
      return `agent: ${trimLog(event.item.text)}`;
    }
    if (event.type === "text" && event.part?.type === "text" && event.part.text) {
      return `agent: ${trimLog(event.part.text)}`;
    }
    const messageText = contentText(event.content);
    if (event.type === "message" && event.role === "assistant" && messageText) {
      return `agent: ${trimLog(messageText)}`;
    }
    if (event.type === "result" && event.result) return `result: ${trimLog(event.result)}`;
    if (event.type === "result" && event.status) return `result: ${event.status}`;
    if (event.type === "turn.completed" || event.usage || event.stats) return "";
  } catch {
    return "";
  }
  return "";
}

function providerTimeoutMs(): number {
  const value = Number(process.env.AGENT_OS_PROVIDER_TIMEOUT_MS ?? 10 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
}

function providerMaxOutputBytes(): number {
  const value = Number(process.env.AGENT_OS_PROVIDER_MAX_OUTPUT_BYTES ?? 5 * 1024 * 1024);
  return Number.isFinite(value) && value > 0 ? value : 5 * 1024 * 1024;
}

function providerIdleTimeoutMs(): number {
  const value = Number(process.env.AGENT_OS_PROVIDER_IDLE_TIMEOUT_MS ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
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
  if (exitCode !== 0 && parsed.status === "failed") return { ...parsed, changedFiles };
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
      const event = JSON.parse(line) as {
        type?: string;
        role?: string;
        content?: string | Array<{ type?: string; text?: string }>;
        item?: { type?: string; text?: string };
        part?: { type?: string; text?: string };
      };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        finalText = event.item.text;
      }
      if (event.type === "text" && event.part?.type === "text" && event.part.text) {
        finalText = event.part.text;
      }
      const messageText = contentText(event.content);
      if (event.type === "message" && event.role === "assistant" && messageText) {
        finalText = messageText;
      }
    } catch {
      continue;
    }
  }
  return finalText;
}

function contentText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.type === "text" ? part.text ?? "" : "").filter(Boolean).join("\n");
}
