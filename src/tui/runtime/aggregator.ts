import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import { basename, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { readRegistryEntries, type RegistryEntry } from "../../core/global-registry.js";
import type { ProviderId, ProviderResult, ProviderUsage, Task, TaskState, WorkerRecord } from "../../core/types.js";

/** Dashboard status collapses task, worker, and heartbeat states into a small stable vocabulary. */
export type GlobalWorkerStatus = "running" | "queued" | "completed" | "failed" | "paused" | "stale" | "cancelled";

/** A repo-qualified worker row keeps enough denormalized fields for cross-project dashboards to render without rereads. */
export interface GlobalWorker {
  taskId: string;
  workerId: string;
  repoRoot: string;
  repoName: string;
  spawnedFromPath: string;
  goal: string;
  provider?: ProviderId | string;
  modelId?: string;
  status: GlobalWorkerStatus;
  startedAt: string;
  finishedAt?: string;
  lastHeartbeatAt?: string;
  lastOutputAt?: string;
  outputBytes?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  tokensTotal?: number;
  runtimeMs: number;
  changedFiles?: string[];
  summary?: string;
  pid?: number;
  cpuPercent?: number;
  rssMb?: number;
  /** Absolute path to the worker directory holding stdout.log/stderr.log; used by the activity-log tail. */
  workerDir?: string;
}

/** Aggregates are precomputed so UI polling stays cheap and deterministic. */
export interface AggregateSnapshot {
  workers: GlobalWorker[];
  counts: { workers: number; active: number; idle: number; completed: number; failed: number; cancelled: number; stale: number };
  totals: { tokensIn: number; tokensOut: number; totalTasks: number };
  byProject: Record<string, number>;
  byModel: Record<string, number>;
  generatedAt: string;
}

interface WatchHandle {
  stop: () => void;
}

interface JsonCacheEntry {
  path: string;
  mtimeMs: number;
  value: JsonObject;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

const CACHE_LIMIT = 5000;
const jsonCache = new Map<string, JsonCacheEntry>();

/** Builds a best-effort snapshot; corrupt or disappearing task files are skipped so one repo cannot break the dashboard. */
export async function buildSnapshot(opts: { sinceMs?: number; includeRoots?: string[]; excludeStaleAfterMs?: number } = {}): Promise<AggregateSnapshot> {
  const generatedAt = new Date().toISOString();
  const cutoffMs = opts.sinceMs ?? 0;
  const includeRoots = opts.includeRoots ? new Set(opts.includeRoots.map((root) => canonical(root))) : undefined;
  const latestEntries = latestRegistryEntries(await safeRegistryEntries());
  const filtered = latestEntries.filter((entry) => {
    if (Date.parse(entry.createdAt) < cutoffMs) return false;
    if (includeRoots && !includeRoots.has(canonical(entry.repoRoot))) return false;
    return true;
  });

  const workers = (await Promise.all(filtered.map((entry) => workersForEntry(entry, generatedAt, opts.excludeStaleAfterMs)))).flat();
  await annotateProcessStats(workers);
  return aggregate(workers, filtered.length, generatedAt);
}

const execFileAsync = promisify(execFile);

/**
 * Per-tick CPU/RAM sampling for workers with a known PID. macOS and Linux `ps`
 * both accept `-o %cpu=,rss=`; Windows lacks `ps`, so on win32 we leave the
 * fields undefined and the table renders an em-dash.
 */
async function annotateProcessStats(workers: GlobalWorker[]): Promise<void> {
  const live = workers.filter((worker) => worker.pid && worker.status === "running");
  if (live.length === 0) return;
  for (const worker of live) {
    if (!isProcessAlive(worker.pid)) {
      // Worker subprocess exited but heartbeat never recorded a terminal state
      // (controller crash, SIGKILL, ...). Demote to "stale" so dashboards do
      // not advertise dead PIDs as active.
      worker.status = "stale";
    }
  }
  if (os.platform() === "win32") return;
  const stillLive = live.filter((worker) => worker.status === "running");
  if (stillLive.length === 0) return;
  await Promise.all(stillLive.map(async (worker) => {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(worker.pid), "-o", "%cpu=,rss="], { timeout: 1000 });
      const trimmed = stdout.trim();
      if (!trimmed) return;
      const [cpuRaw, rssRaw] = trimmed.split(/\s+/);
      const cpu = Number.parseFloat(cpuRaw);
      const rssKb = Number.parseFloat(rssRaw);
      if (Number.isFinite(cpu)) worker.cpuPercent = cpu;
      if (Number.isFinite(rssKb)) worker.rssMb = rssKb / 1024;
    } catch {
      // Process likely exited between status check and sample. Leave fields undefined.
    }
  }));
}

/** Cross-platform liveness probe; signal 0 never delivers a signal but errors when the pid is gone or denied. */
function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user — treat as alive.
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EPERM";
  }
}

/** Polling keeps the first dashboard version simple; callers can stop cleanly during tests or TUI unmount. */
export async function watchSnapshots(opts: { intervalMs: number }, onSnapshot: (s: AggregateSnapshot) => void): Promise<WatchHandle> {
  const tick = async (): Promise<void> => {
    try {
      onSnapshot(await buildSnapshot());
    } catch (error) {
      debug(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await tick();
  const timer = setInterval(() => {
    void tick();
  }, opts.intervalMs);
  return { stop: () => clearInterval(timer) };
}

function latestRegistryEntries(entries: RegistryEntry[]): RegistryEntry[] {
  const byTask = new Map<string, RegistryEntry>();
  for (const entry of entries) byTask.set(entry.taskId, entry);
  return [...byTask.values()];
}

async function safeRegistryEntries(): Promise<RegistryEntry[]> {
  try {
    return await readRegistryEntries();
  } catch (error) {
    debug(`registry skipped: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

async function workersForEntry(entry: RegistryEntry, generatedAt: string, staleAfterMs: number | undefined): Promise<GlobalWorker[]> {
  const taskRoot = join(entry.repoRoot, ".agent-os", "tasks", entry.taskId);
  const [task, state] = await Promise.all([
    readJsonFile<Task>(join(taskRoot, "task.json")),
    readJsonFile<TaskState>(join(taskRoot, "state.json")),
  ]);
  if (!task && !state) return [];

  const workerRoot = join(taskRoot, "workers");
  const workerIds = await readWorkerIds(workerRoot);
  if (!workerIds.length) {
    return [buildWorker({
      entry,
      task,
      state,
      workerId: "—",
      workspace: undefined,
      heartbeat: undefined,
      result: undefined,
      usage: undefined,
      generatedAt,
      staleAfterMs,
    })];
  }

  const workers = await Promise.all(workerIds.map(async (workerId) => {
    const dir = join(workerRoot, workerId);
    const workerDir = dir;
    const [workspace, heartbeat, result, usage, workerTask] = await Promise.all([
      readJsonFile<WorkerRecord>(join(dir, "workspace.json")),
      readJsonFile<HeartbeatRecord>(join(dir, "heartbeat.json")),
      readJsonFile<ProviderResult>(join(dir, "result.json")),
      readJsonFile<ProviderUsage>(join(dir, "usage.json")),
      readJsonFile<Task>(join(dir, "task.json")),
    ]);
    const sniffedModel = (state?.modelId || entry.modelId) ? undefined : await sniffModelFromStdout(dir);
    return buildWorker({
      entry,
      task: workerTask ?? task,
      state,
      workerId,
      workspace,
      heartbeat,
      result,
      usage,
      generatedAt,
      staleAfterMs,
      sniffedModel,
      workerDir,
    });
  }));
  return workers;
}

function buildWorker(input: {
  entry: RegistryEntry;
  task?: Task;
  state?: TaskState;
  workerId: string;
  workspace?: WorkerRecord;
  heartbeat?: HeartbeatRecord;
  result?: ProviderResult;
  usage?: ProviderUsage;
  generatedAt: string;
  staleAfterMs?: number;
  sniffedModel?: string;
  workerDir?: string;
}): GlobalWorker {
  const startedAt = input.workspace?.startedAt ?? input.task?.createdAt ?? input.entry.createdAt;
  const status = workerStatus(input.state, input.heartbeat, input.result, input.generatedAt, input.staleAfterMs);
  // Terminal statuses must freeze runtime. Prefer the explicit workspace
  // `finishedAt` (set by external-runner on clean exit); fall back to the last
  // heartbeat / output timestamp for crash paths where workspace.json was
  // never finalized. Without this, failed/cancelled/stale workers keep
  // accruing runtime as if they were still live.
  const isTerminal = status === "completed" || status === "failed" || status === "cancelled" || status === "stale";
  const finishedAt = input.workspace?.finishedAt
    ?? (isTerminal ? (input.heartbeat?.checkedAt ?? input.heartbeat?.lastOutputAt) : undefined);
  const tokensIn = Math.max(input.usage?.inputTokens ?? 0, input.usage?.estimatedInputTokens ?? 0) || undefined;
  const tokensOut = Math.max(input.usage?.outputTokens ?? 0, input.usage?.estimatedOutputTokens ?? 0) || undefined;
  const tokensCached = input.usage?.cachedInputTokens;
  const tokensTotal = input.usage?.totalTokens ?? input.usage?.estimatedTotalTokens ?? ((tokensIn ?? 0) + (tokensOut ?? 0));
  return {
    taskId: input.entry.taskId,
    workerId: input.workerId,
    repoRoot: canonical(input.entry.repoRoot),
    repoName: basename(input.entry.repoRoot),
    spawnedFromPath: input.task?.spawnedFromPath ?? input.entry.repoRoot,
    goal: input.task?.goal ?? input.entry.goal,
    provider: input.workspace?.provider ?? input.state?.provider ?? input.entry.provider ?? undefined,
    modelId: input.state?.modelId ?? input.entry.modelId ?? input.sniffedModel ?? undefined,
    status,
    startedAt,
    finishedAt,
    lastHeartbeatAt: input.heartbeat?.checkedAt,
    lastOutputAt: input.heartbeat?.lastOutputAt,
    outputBytes: input.heartbeat?.outputBytes,
    tokensIn,
    tokensOut,
    tokensCached,
    tokensTotal,
    runtimeMs: runtimeMs(startedAt, finishedAt, input.generatedAt),
    changedFiles: input.result?.changedFiles,
    summary: input.result?.summary ?? input.state?.message,
    pid: input.workspace?.pid,
    workerDir: input.workerDir,
  };
}

function workerStatus(
  state: TaskState | undefined,
  heartbeat: HeartbeatRecord | undefined,
  result: ProviderResult | undefined,
  generatedAt: string,
  staleAfterMs: number | undefined,
): GlobalWorkerStatus {
  if (state?.status === "paused") return "paused";
  if (state?.status === "cancelled") return "cancelled";
  if (state?.status === "stale") return "stale";
  if (result?.status === "failed" || state?.status === "failed") return "failed";
  if (result?.status === "completed" || state?.status === "completed" || state?.status === "validated" || state?.status === "reviewed" || state?.status === "accepted") return "completed";
  if (heartbeat?.status === "running") {
    if (staleAfterMs !== undefined && heartbeat.checkedAt && Date.parse(generatedAt) - Date.parse(heartbeat.checkedAt) > staleAfterMs) return "stale";
    return "running";
  }
  if (state?.status === "running") return "running";
  return "queued";
}

function runtimeMs(startedAt: string, finishedAt: string | undefined, generatedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt ?? generatedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}

function aggregate(workers: GlobalWorker[], totalTasks: number, generatedAt: string): AggregateSnapshot {
  const counts = { workers: workers.length, active: 0, idle: 0, completed: 0, failed: 0, cancelled: 0, stale: 0 };
  const totals = { tokensIn: 0, tokensOut: 0, totalTasks };
  const byProject: Record<string, number> = {};
  const byModel: Record<string, number> = {};

  for (const worker of workers) {
    if (worker.status === "running") counts.active += 1;
    if (worker.status === "queued" || worker.status === "paused") counts.idle += 1;
    if (worker.status === "completed") counts.completed += 1;
    if (worker.status === "failed") counts.failed += 1;
    if (worker.status === "cancelled") counts.cancelled += 1;
    if (worker.status === "stale") counts.stale += 1;
    totals.tokensIn += worker.tokensIn ?? 0;
    totals.tokensOut += worker.tokensOut ?? 0;
    byProject[worker.repoRoot] = (byProject[worker.repoRoot] ?? 0) + 1;
    const modelKey = worker.modelId ?? "unknown";
    byModel[modelKey] = (byModel[modelKey] ?? 0) + 1;
  }

  return { workers, counts, totals, byProject, byModel, generatedAt };
}

const stdoutModelCache = new Map<string, string | null>();

async function sniffModelFromStdout(dir: string): Promise<string | undefined> {
  if (stdoutModelCache.has(dir)) return stdoutModelCache.get(dir) ?? undefined;
  try {
    const { open } = await import("node:fs/promises");
    const fh = await open(join(dir, "stdout.log"), "r");
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    await fh.close();
    const text = buf.toString("utf8", 0, bytesRead);
    const m = text.match(/"model"\s*:\s*"([^"]+)"/);
    const value = m ? m[1] : null;
    stdoutModelCache.set(dir, value);
    return value ?? undefined;
  } catch {
    stdoutModelCache.set(dir, null);
    return undefined;
  }
}

async function readWorkerIds(workerRoot: string): Promise<string[]> {
  try {
    return (await fs.readdir(workerRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    debug(`workers skipped ${workerRoot}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function readJsonFile<T extends object>(path: string): Promise<T | undefined> {
  const absolutePath = resolve(path);
  try {
    const stat = await fs.stat(absolutePath);
    const cached = jsonCache.get(absolutePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value as T;
    const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as JsonObject;
    remember({ path: absolutePath, mtimeMs: stat.mtimeMs, value: parsed });
    return parsed as T;
  } catch (error) {
    debug(`json skipped ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function remember(entry: JsonCacheEntry): void {
  if (jsonCache.has(entry.path)) jsonCache.delete(entry.path);
  jsonCache.set(entry.path, entry);
  while (jsonCache.size > CACHE_LIMIT) {
    const oldest = jsonCache.keys().next().value;
    if (!oldest) break;
    jsonCache.delete(oldest);
  }
}

interface HeartbeatRecord {
  taskId?: string;
  workerId?: string;
  status?: string;
  checkedAt?: string;
  lastOutputAt?: string;
  outputBytes?: number;
}

function debug(message: string): void {
  if (process.env.DEBUG?.includes("agent-os:tui")) console.error(`[agent-os:tui] ${message}`);
}
