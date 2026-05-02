import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { appendRegistryEntry, readRegistryEntries } from "../../src/core/global-registry.js";
import { buildSnapshot } from "../../src/tui/runtime/aggregator.js";

/** Supported simulator providers. */
export type SimProvider = "codex" | "claude" | "gemini" | "zai" | "opencode" | "kilo" | "cline";

/** One scenario passed to the simulator runner. */
export type SimScenario = {
  workers: SimWorkerSpec[];
  durationMs: number;
  tickMs?: number;
};

/** Per-worker behavior and lifecycle settings. */
export type SimWorkerSpec = {
  repoRoot: string;
  provider: SimProvider;
  modelId?: string;
  initialStatus: "queued" | "running";
  durationMs: number;
  tokensInRate: number;
  tokensOutRate: number;
  finalStatus: "completed" | "failed" | "cancelled" | "stale";
  parentWorkerId?: string;
  chaos?: {
    duplicateEvents?: boolean;
    outOfOrderEvents?: boolean;
    missingHeartbeat?: boolean;
    midRunCwdChange?: boolean;
  };
};

/** Canonical state from the simulator ledger (never reconstructed from files). */
export type TruthState = {
  counts: { workers: number; active: number; idle: number; completed: number; failed: number; cancelled: number; stale: number };
  totals: { tokensIn: number; tokensOut: number; totalTasks: number };
  byProject: Record<string, number>;
  byProvider: Record<string, number>;
  workers: Array<{ taskId: string; workerId: string; repoRoot: string; status: string; tokensIn: number; tokensOut: number }>;
};

/** Event log entry emitted by the simulator. */
export type SimEvent = {
  taskId: string;
  workerId: string;
  timestamp: string;
  event: string;
  status: string;
  provider: SimProvider;
};

/** Collection of all emitted events and writes. */
export type SimEventLog = {
  events: SimEvent[];
};

type InternalWorker = {
  spec: SimWorkerSpec;
  taskId: string;
  workerId: string;
  repoRoot: string;
  startedAtMs: number;
  runStartMs: number;
  runEndMs: number;
  finishedAtMs?: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "stale";
  tokensIn: number;
  tokensOut: number;
  outputBytes: number;
  heartbeatFrozen: boolean;
  heartbeatStopMs?: number;
  cwdSwitched: boolean;
  outOfOrderWrote: boolean;
  registered: boolean;
};

const DEFAULT_MODEL: Record<SimProvider, string> = {
  codex: "gpt-5",
  claude: "claude-sonnet-4",
  gemini: "gemini-2.5-pro",
  zai: "glm-4.6",
  opencode: "opencode-default",
  kilo: "kilo-code",
  cline: "cline-default",
};

/**
 * Deterministic fake worker simulator for TUI QA phases.
 */
export default class WorkerSimulator {
  private readonly rootDirs: string[];

  private readonly seed: number;

  private readonly clock: () => Date;

  private readonly originalRegistryEnv: string | undefined;

  private readonly registryPath?: string;

  private workers: InternalWorker[] = [];

  private createdTaskDirs: string[] = [];

  private eventLog: SimEventLog = { events: [] };

  private running = false;

  private nowMs = 0;

  private rngState: number;

  /**
   * Creates a simulator bound to a set of allowed repo roots.
   */
  constructor(opts: { rootDirs: string[]; registryPath?: string; seed?: number; clock?: () => Date }) {
    this.rootDirs = opts.rootDirs.map((d) => { try { return realpathSync(d); } catch { return resolve(d); } });
    this.seed = opts.seed ?? 42;
    this.rngState = this.seed >>> 0;
    this.registryPath = opts.registryPath;
    this.clock = opts.clock ?? (() => new Date("2026-01-01T00:00:00.000Z"));
    this.originalRegistryEnv = process.env.AGENT_OS_REGISTRY_FILE;
  }

  /**
   * Starts and runs one full scenario to completion.
   */
  async start(scenario: SimScenario): Promise<void> {
    if (this.running) throw new Error("Simulator already running");
    this.running = true;
    this.eventLog = { events: [] };
    this.workers = [];
    this.createdTaskDirs = [];
    this.nowMs = this.clock().getTime();

    if (this.registryPath) process.env.AGENT_OS_REGISTRY_FILE = this.registryPath;

    const tickMs = Math.max(10, scenario.tickMs ?? 100);
    this.workers = scenario.workers.map((spec, index) => this.initWorker(spec, index));

    await Promise.all(this.workers.map(async (worker) => this.writeTaskSkeleton(worker)));

    const ticks = Math.max(1, Math.ceil(scenario.durationMs / tickMs));
    for (let i = 0; i <= ticks; i += 1) {
      this.nowMs = this.clock().getTime() + (i * tickMs);
      await this.tick(tickMs);
    }

    for (const worker of this.workers) {
      if (worker.status === "running" || worker.status === "queued") {
        await this.finishWorker(worker, worker.spec.finalStatus);
      }
    }

    this.running = false;
  }

  /**
   * Stops the simulator and removes simulator-created task directories.
   */
  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.createdTaskDirs.map(async (dir) => {
      if (dir.includes(`${join(".agent-os", "tasks", "sim-")}`)) {
        await rm(dir, { recursive: true, force: true });
      }
    }));
    this.createdTaskDirs = [];
    if (this.registryPath) {
      if (this.originalRegistryEnv === undefined) delete process.env.AGENT_OS_REGISTRY_FILE;
      else process.env.AGENT_OS_REGISTRY_FILE = this.originalRegistryEnv;
    }
  }

  /**
   * Returns authoritative truth computed from in-memory ledger.
   */
  snapshotTruth(): TruthState {
    const counts = { workers: 0, active: 0, idle: 0, completed: 0, failed: 0, cancelled: 0, stale: 0 };
    const totals = { tokensIn: 0, tokensOut: 0, totalTasks: this.workers.length };
    const byProject: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    const workers = this.workers.map((worker) => {
      counts.workers += 1;
      if (worker.status === "running") counts.active += 1;
      if (worker.status === "queued") counts.idle += 1;
      if (worker.status === "completed") counts.completed += 1;
      if (worker.status === "failed") counts.failed += 1;
      if (worker.status === "cancelled") counts.cancelled += 1;
      if (worker.status === "stale") counts.stale += 1;
      totals.tokensIn += worker.tokensIn;
      totals.tokensOut += worker.tokensOut;
      byProject[worker.repoRoot] = (byProject[worker.repoRoot] ?? 0) + 1;
      byProvider[worker.spec.provider] = (byProvider[worker.spec.provider] ?? 0) + 1;
      return {
        taskId: worker.taskId,
        workerId: worker.workerId,
        repoRoot: worker.repoRoot,
        status: worker.status,
        tokensIn: round3(worker.tokensIn),
        tokensOut: round3(worker.tokensOut),
      };
    });

    return {
      counts,
      totals: {
        tokensIn: round3(totals.tokensIn),
        tokensOut: round3(totals.tokensOut),
        totalTasks: totals.totalTasks,
      },
      byProject,
      byProvider,
      workers,
    };
  }

  /**
   * Returns ordered emitted events.
   */
  getEvents(): SimEventLog {
    return { events: [...this.eventLog.events] };
  }

  private initWorker(spec: SimWorkerSpec, index: number): InternalWorker {
    const repoRoot = (() => { try { return realpathSync(spec.repoRoot); } catch { return resolve(spec.repoRoot); } })();
    if (!this.rootDirs.includes(repoRoot)) {
      throw new Error(`repoRoot must be one of configured rootDirs: ${repoRoot}`);
    }
    const taskId = `sim-${this.idFrom(index, repoRoot, spec.provider, "task")}`;
    const workerId = `simw-${this.idFrom(index, repoRoot, spec.provider, "worker")}`;
    const queueDelayMs = spec.initialStatus === "queued" ? Math.floor(this.nextRand() * 1500) : 0;
    const startedAtMs = this.clock().getTime();
    return {
      spec,
      taskId,
      workerId,
      repoRoot,
      startedAtMs,
      runStartMs: startedAtMs + queueDelayMs,
      runEndMs: startedAtMs + queueDelayMs + spec.durationMs,
      status: spec.initialStatus,
      tokensIn: 0,
      tokensOut: 0,
      outputBytes: 0,
      heartbeatFrozen: false,
      cwdSwitched: false,
      outOfOrderWrote: false,
      registered: false,
    };
  }

  private async tick(tickMs: number): Promise<void> {
    for (const worker of this.workers) {
      if (worker.status === "queued" && this.nowMs >= worker.runStartMs) {
        worker.status = "running";
        await this.onStart(worker);
      }
      if (worker.status !== "running") continue;

      if (worker.spec.chaos?.midRunCwdChange && !worker.cwdSwitched && this.nowMs >= worker.runStartMs + Math.floor(worker.spec.durationMs / 2)) {
        worker.cwdSwitched = true;
        await this.updateTask(worker, {
          cwd: join(worker.repoRoot, "changed-subdir"),
          spawnedFromPath: join(worker.repoRoot, "changed-subdir"),
          updatedAt: this.isoNow(),
        });
        await this.appendEvent(worker, "cwd_changed", "running", this.isoNow());
      }

      if (worker.spec.chaos?.missingHeartbeat && !worker.heartbeatFrozen && this.nowMs >= worker.runStartMs + Math.floor(worker.spec.durationMs / 3)) {
        worker.heartbeatFrozen = true;
        worker.heartbeatStopMs = this.nowMs;
      }

      worker.tokensIn += worker.spec.tokensInRate * (tickMs / 1000);
      worker.tokensOut += worker.spec.tokensOutRate * (tickMs / 1000);
      worker.outputBytes += Math.max(1, Math.floor((worker.spec.tokensOutRate * tickMs) / 10));

      await this.writeState(worker, "running");
      if (!worker.heartbeatFrozen || (worker.heartbeatStopMs !== undefined && this.nowMs - worker.heartbeatStopMs < 90_000)) {
        await this.writeHeartbeat(worker);
      }
      await this.writeUsage(worker);
      await this.appendEvent(worker, "tick", "running", this.isoNow());

      if (worker.spec.chaos?.outOfOrderEvents && !worker.outOfOrderWrote && this.nowMs >= worker.runStartMs + tickMs) {
        worker.outOfOrderWrote = true;
        const future = new Date(this.nowMs + 45_000).toISOString();
        const past = new Date(this.nowMs - 15_000).toISOString();
        await this.appendEvent(worker, "out_of_order_future", "running", future);
        await this.appendEvent(worker, "out_of_order_past", "running", past);
      }

      if (this.nowMs >= worker.runEndMs) {
        await this.finishWorker(worker, worker.spec.finalStatus);
      }
    }
  }

  private async onStart(worker: InternalWorker): Promise<void> {
    if (!worker.registered) {
      await appendRegistryEntry({
        taskId: worker.taskId,
        repoRoot: worker.repoRoot,
        goal: `Simulated goal for ${worker.workerId}`,
        createdAt: this.isoNow(),
        provider: worker.spec.provider,
        modelId: worker.spec.modelId ?? DEFAULT_MODEL[worker.spec.provider],
      });
      worker.registered = true;
    }

    await this.writeWorkspace(worker);
    await this.writeState(worker, "running");
    await this.appendEvent(worker, "worker_started", "running", this.isoNow());
  }

  private async finishWorker(worker: InternalWorker, status: "completed" | "failed" | "cancelled" | "stale"): Promise<void> {
    worker.status = status;
    worker.finishedAtMs = this.nowMs;
    await this.writeWorkspace(worker, true);
    await this.writeState(worker, status);
    await this.writeResult(worker, status);
    await this.appendEvent(worker, "worker_finished", status, this.isoNow());
  }

  private async writeTaskSkeleton(worker: InternalWorker): Promise<void> {
    const taskDir = this.taskDir(worker);
    const workersDir = this.workerDir(worker);
    await mkdir(workersDir, { recursive: true });
    this.createdTaskDirs.push(taskDir);
    if (!worker.registered) {
      await appendRegistryEntry({
        taskId: worker.taskId,
        repoRoot: worker.repoRoot,
        goal: `Simulated goal for ${worker.workerId}`,
        createdAt: this.isoFrom(worker.startedAtMs),
      });
      worker.registered = true;
    }

    await this.writeJson(join(taskDir, "task.json"), {
      id: worker.taskId,
      goal: `Simulated goal for ${worker.workerId}`,
      allowedFiles: ["scripts/qa/sim.ts"],
      risk: "low",
      createdAt: this.isoFrom(worker.startedAtMs),
      updatedAt: this.isoFrom(worker.startedAtMs),
      cwd: worker.repoRoot,
      spawnedFromPath: worker.repoRoot,
    });

    await this.writeState(worker, worker.status);
    await this.writeHeartbeat(worker);
    await this.writeUsage(worker);
  }

  private async writeState(worker: InternalWorker, status: string): Promise<void> {
    await this.writeJson(join(this.taskDir(worker), "state.json"), {
      taskId: worker.taskId,
      status,
      provider: worker.spec.provider,
      workerId: worker.workerId,
      modelId: worker.spec.modelId ?? DEFAULT_MODEL[worker.spec.provider],
      updatedAt: this.isoNow(),
      message: `sim status ${status}`,
    });
  }

  private async writeWorkspace(worker: InternalWorker, finished = false): Promise<void> {
    await this.writeJson(join(this.workerDir(worker), "workspace.json"), {
      taskId: worker.taskId,
      workerId: worker.workerId,
      provider: worker.spec.provider,
      workspacePath: join(worker.repoRoot, ".agent-os", "work", worker.taskId, worker.workerId),
      isolation: "temp_copy",
      startedAt: this.isoFrom(worker.runStartMs),
      finishedAt: finished ? this.isoNow() : undefined,
    });
  }

  private async writeHeartbeat(worker: InternalWorker): Promise<void> {
    await this.writeJson(join(this.workerDir(worker), "heartbeat.json"), {
      taskId: worker.taskId,
      workerId: worker.workerId,
      status: worker.status === "queued" ? "queued" : "running",
      checkedAt: this.isoNow(),
      lastOutputAt: this.isoNow(),
      outputBytes: worker.outputBytes,
    });
  }

  private async writeUsage(worker: InternalWorker): Promise<void> {
    const tokensIn = round3(worker.tokensIn);
    const tokensOut = round3(worker.tokensOut);
    const totalTokens = round3(tokensIn + tokensOut);
    await this.writeJson(join(this.workerDir(worker), "usage.json"), {
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      totalTokens,
      exact: true,
    });
  }

  private async writeResult(worker: InternalWorker, status: "completed" | "failed" | "cancelled" | "stale"): Promise<void> {
    const normalized = status === "stale" ? "failed" : status;
    await this.writeJson(join(this.workerDir(worker), "result.json"), {
      status: normalized,
      summary: `simulated ${status}`,
      changedFiles: status === "completed" ? ["scripts/qa/sim.ts"] : [],
    });
  }

  private async appendEvent(worker: InternalWorker, event: string, status: string, timestamp: string): Promise<void> {
    const entry = {
      taskId: worker.taskId,
      timestamp,
      event,
      provider: worker.spec.provider,
      model: worker.spec.modelId ?? DEFAULT_MODEL[worker.spec.provider],
      workerId: worker.workerId,
      outcome: status,
      usage: {
        inputTokens: round3(worker.tokensIn),
        outputTokens: round3(worker.tokensOut),
        totalTokens: round3(worker.tokensIn + worker.tokensOut),
        exact: true,
      },
      message: `sim event ${event}`,
    };
    await this.appendNdjson(join(this.taskDir(worker), "events.ndjson"), entry);
    if (worker.spec.chaos?.duplicateEvents) {
      await this.appendNdjson(join(this.taskDir(worker), "events.ndjson"), entry);
    }
    this.eventLog.events.push({
      taskId: worker.taskId,
      workerId: worker.workerId,
      timestamp,
      event,
      status,
      provider: worker.spec.provider,
    });
  }

  private async updateTask(worker: InternalWorker, patch: { cwd: string; spawnedFromPath: string; updatedAt: string }): Promise<void> {
    const path = join(this.taskDir(worker), "task.json");
    const raw = await readFile(path, "utf8");
    const task = JSON.parse(raw) as {
      id: string;
      goal: string;
      allowedFiles: string[];
      risk: string;
      createdAt: string;
      updatedAt: string;
      cwd: string;
      spawnedFromPath?: string;
    };
    task.cwd = patch.cwd;
    task.spawnedFromPath = patch.spawnedFromPath;
    task.updatedAt = patch.updatedAt;
    await this.writeJson(path, task);
  }

  private async appendNdjson(path: string, row: object): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = "";
    }
    await writeFile(path, `${existing}${JSON.stringify(row)}\n`, "utf8");
  }

  private async writeJson(path: string, value: object): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const normalized = JSON.parse(JSON.stringify(value)) as object;
    await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  }

  private taskDir(worker: InternalWorker): string {
    return join(worker.repoRoot, ".agent-os", "tasks", worker.taskId);
  }

  private workerDir(worker: InternalWorker): string {
    return join(this.taskDir(worker), "workers", worker.workerId);
  }

  private isoNow(): string {
    return this.isoFrom(this.nowMs);
  }

  private isoFrom(ms: number): string {
    return new Date(ms).toISOString();
  }

  private nextRand(): number {
    this.rngState = (1664525 * this.rngState + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }

  private idFrom(index: number, repoRoot: string, provider: string, suffix: string): string {
    return createHash("sha1")
      .update(`${this.seed}:${index}:${repoRoot}:${provider}:${suffix}`)
      .digest("hex")
      .slice(0, 10);
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

type CliView = {
  counts: { workers: number; active: number; idle: number; completed: number; failed: number; cancelled: number; stale: number };
  totals: { tokensIn: number; tokensOut: number; totalTasks: number };
  byProject: Record<string, number>;
  byProvider: Record<string, number>;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scenarioArg = readArg(args, "--scenario") ?? "default";

  const simBase = "/tmp/agent-os-sim";
  const repos = [join(simBase, "repo-a"), join(simBase, "repo-b"), join(simBase, "repo-c")].map((p) => { try { return realpathSync(p); } catch { return resolve(p); } });
  await Promise.all(repos.map(async (repo) => mkdir(repo, { recursive: true })));

  const registryPath = join(simBase, "registry.ndjson");
  await rm(registryPath, { force: true });

  const scenario = buildScenario(scenarioArg, repos);
  const simulator = new WorkerSimulator({ rootDirs: repos, registryPath, seed: 42 });
  try {
    await simulator.start(scenario);

    const truth = simulator.snapshotTruth();
    const snapshot = await buildSnapshot({ includeRoots: repos, excludeStaleAfterMs: 60_000 });
    const agg = snapshotToView(snapshot);
    const diff = diffViews(toView(truth), agg);

    // Ensure registry is materialized and readable for QA traces.
    await readRegistryEntries();

    console.log(`SIM TRUTH: ${JSON.stringify(toView(truth))}`);
    console.log(`AGGREGATOR SNAPSHOT: ${JSON.stringify(agg)}`);
    console.log(`DIFF: ${diff.length ? JSON.stringify(diff) : "PERFECT MATCH"}`);
  } finally {
    await simulator.stop();
  }
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function buildScenario(name: string, repos: string[]): SimScenario {
  if (name === "basic") {
    return {
      durationMs: 30_000,
      tickMs: 100,
      workers: [
        {
          repoRoot: repos[0],
          provider: "codex",
          initialStatus: "running",
          durationMs: 18_000,
          tokensInRate: 120,
          tokensOutRate: 60,
          finalStatus: "completed",
        },
        {
          repoRoot: repos[0],
          provider: "claude",
          initialStatus: "queued",
          durationMs: 20_000,
          tokensInRate: 100,
          tokensOutRate: 50,
          finalStatus: "failed",
          chaos: { duplicateEvents: true },
        },
        {
          repoRoot: repos[1],
          provider: "gemini",
          initialStatus: "running",
          durationMs: 16_000,
          tokensInRate: 80,
          tokensOutRate: 35,
          finalStatus: "cancelled",
          chaos: { outOfOrderEvents: true },
        },
        {
          repoRoot: repos[2],
          provider: "zai",
          initialStatus: "queued",
          durationMs: 15_000,
          tokensInRate: 70,
          tokensOutRate: 30,
          finalStatus: "stale",
          chaos: { midRunCwdChange: true },
        },
        {
          repoRoot: repos[1],
          provider: "opencode",
          initialStatus: "running",
          durationMs: 22_000,
          tokensInRate: 90,
          tokensOutRate: 45,
          finalStatus: "completed",
        },
      ],
    };
  }

  return {
    durationMs: 30_000,
    tickMs: 100,
    workers: [
      {
        repoRoot: repos[0],
        provider: "codex",
        initialStatus: "running",
        durationMs: 17_000,
        tokensInRate: 120,
        tokensOutRate: 65,
        finalStatus: "completed",
      },
      {
        repoRoot: repos[0],
        provider: "claude",
        initialStatus: "queued",
        durationMs: 19_000,
        tokensInRate: 95,
        tokensOutRate: 48,
        finalStatus: "failed",
        chaos: { duplicateEvents: true },
      },
      {
        repoRoot: repos[1],
        provider: "gemini",
        initialStatus: "running",
        durationMs: 14_000,
        tokensInRate: 88,
        tokensOutRate: 42,
        finalStatus: "cancelled",
        chaos: { outOfOrderEvents: true },
      },
      {
        repoRoot: repos[2],
        provider: "zai",
        initialStatus: "queued",
        durationMs: 21_000,
        tokensInRate: 72,
        tokensOutRate: 33,
        finalStatus: "stale",
        chaos: { midRunCwdChange: true, missingHeartbeat: true },
      },
      {
        repoRoot: repos[1],
        provider: "opencode",
        initialStatus: "running",
        durationMs: 24_000,
        tokensInRate: 91,
        tokensOutRate: 46,
        finalStatus: "completed",
      },
    ],
  };
}

function toView(truth: TruthState): CliView {
  return {
    counts: truth.counts,
    totals: truth.totals,
    byProject: truth.byProject,
    byProvider: truth.byProvider,
  };
}

function snapshotToView(snapshot: Awaited<ReturnType<typeof buildSnapshot>>): CliView {
  const byProvider: Record<string, number> = {};
  let stale = 0;
  for (const worker of snapshot.workers) {
    const provider = worker.provider ?? "unknown";
    byProvider[provider] = (byProvider[provider] ?? 0) + 1;
    if (worker.status === "stale") stale += 1;
  }

  return {
    counts: {
      workers: snapshot.counts.workers,
      active: snapshot.counts.active,
      idle: snapshot.counts.idle,
      completed: snapshot.counts.completed,
      failed: snapshot.counts.failed,
      cancelled: snapshot.counts.cancelled,
      stale,
    },
    totals: {
      tokensIn: round3(snapshot.totals.tokensIn),
      tokensOut: round3(snapshot.totals.tokensOut),
      totalTasks: snapshot.totals.totalTasks,
    },
    byProject: snapshot.byProject,
    byProvider,
  };
}

function diffViews(expected: CliView, actual: CliView): string[] {
  const diffs: string[] = [];
  const keys = ["workers", "active", "idle", "completed", "failed", "cancelled", "stale"] as const;
  for (const key of keys) {
    if (expected.counts[key] !== actual.counts[key]) {
      diffs.push(`counts.${key}: expected=${expected.counts[key]} actual=${actual.counts[key]}`);
    }
  }

  const totals = ["tokensIn", "tokensOut", "totalTasks"] as const;
  for (const key of totals) {
    if (expected.totals[key] !== actual.totals[key]) {
      diffs.push(`totals.${key}: expected=${expected.totals[key]} actual=${actual.totals[key]}`);
    }
  }

  diffs.push(...diffRecord("byProject", expected.byProject, actual.byProject));
  diffs.push(...diffRecord("byProvider", expected.byProvider, actual.byProvider));
  return diffs;
}

function diffRecord(name: string, expected: Record<string, number>, actual: Record<string, number>): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const diffs: string[] = [];
  for (const key of [...keys].sort()) {
    const a = expected[key] ?? 0;
    const b = actual[key] ?? 0;
    if (a !== b) diffs.push(`${name}.${key}: expected=${a} actual=${b}`);
  }
  return diffs;
}

const directRun = process.argv[1]?.endsWith("sim.ts") || process.argv[1]?.endsWith("sim.js");
if (directRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
