import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import WorkerSimulator, { type SimScenario } from "../scripts/qa/sim.js";
import { appendRegistryEntry } from "../src/core/global-registry.js";
import { buildSnapshot } from "../src/tui/runtime/aggregator.js";

/**
 * KNOWN AGGREGATOR BUGS:
 * - Symlinked repo roots are not canonicalized via realpath before project grouping,
 *   so identical repos addressed through symlink and real path are split in byProject.
 *   Tracked by test: "symlinked repo root does not split projects" (todo until Phase 5).
 */

const EPSILON = 0.01;

type TestEnv = {
  baseDir: string;
  registryPath: string;
  repoRoots: [string, string, string];
};

async function setupEnv(label: string): Promise<TestEnv> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const baseDir = resolve(`/tmp/agent-os-recon-${suffix}`);
  const registryPath = join(baseDir, "registry.ndjson");
  const repoRoots: [string, string, string] = [
    join(baseDir, "repo-a"),
    join(baseDir, "repo-b"),
    join(baseDir, "repo-c"),
  ];
  await Promise.all([mkdir(baseDir, { recursive: true }), ...repoRoots.map(async (repo) => mkdir(repo, { recursive: true }))]);
  return { baseDir, registryPath, repoRoots };
}

async function withEnv<T>(label: string, fn: (env: TestEnv) => Promise<T>): Promise<T> {
  const env = await setupEnv(label);
  const previousRegistry = process.env.AGENT_OS_REGISTRY_FILE;
  process.env.AGENT_OS_REGISTRY_FILE = env.registryPath;
  try {
    return await fn(env);
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENT_OS_REGISTRY_FILE;
    else process.env.AGENT_OS_REGISTRY_FILE = previousRegistry;
    await rm(env.baseDir, { recursive: true, force: true });
  }
}

function basicScenario(repos: string[]): SimScenario {
  return {
    durationMs: 30_000,
    tickMs: 100,
    workers: [
      {
        repoRoot: repos[0]!,
        provider: "codex",
        initialStatus: "running",
        durationMs: 18_000,
        tokensInRate: 120,
        tokensOutRate: 60,
        finalStatus: "completed",
      },
      {
        repoRoot: repos[0]!,
        provider: "claude",
        initialStatus: "queued",
        durationMs: 20_000,
        tokensInRate: 100,
        tokensOutRate: 50,
        finalStatus: "failed",
        chaos: { duplicateEvents: true },
      },
      {
        repoRoot: repos[1]!,
        provider: "gemini",
        initialStatus: "running",
        durationMs: 16_000,
        tokensInRate: 80,
        tokensOutRate: 35,
        finalStatus: "cancelled",
        chaos: { outOfOrderEvents: true },
      },
      {
        repoRoot: repos[2]!,
        provider: "zai",
        initialStatus: "queued",
        durationMs: 15_000,
        tokensInRate: 70,
        tokensOutRate: 30,
        finalStatus: "stale",
        chaos: { midRunCwdChange: true },
      },
      {
        repoRoot: repos[1]!,
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

async function writeTaskSkeleton(repoRoot: string, taskId: string, goal = "manual goal"): Promise<void> {
  const taskDir = join(repoRoot, ".agent-os", "tasks", taskId);
  await mkdir(taskDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    join(taskDir, "task.json"),
    `${JSON.stringify({
      id: taskId,
      goal,
      allowedFiles: [],
      risk: "low",
      createdAt: now,
      updatedAt: now,
      cwd: repoRoot,
      spawnedFromPath: repoRoot,
    }, null, 2)}\n`,
    "utf8",
  );
}

test("reconcile basic 5-worker scenario", async () => {
  await withEnv("basic", async (env) => {
    const simulator = new WorkerSimulator({ rootDirs: env.repoRoots, registryPath: env.registryPath, seed: 42 });
    try {
      await simulator.start(basicScenario(env.repoRoots));
      const truth = simulator.snapshotTruth();
      const snapshot = await buildSnapshot({ includeRoots: env.repoRoots, excludeStaleAfterMs: 60_000 });

      assert.deepEqual(snapshot.counts, truth.counts);
      assert.ok(Math.abs(snapshot.totals.tokensIn - truth.totals.tokensIn) <= EPSILON);
      assert.ok(Math.abs(snapshot.totals.tokensOut - truth.totals.tokensOut) <= EPSILON);
      assert.equal(snapshot.totals.totalTasks, truth.totals.totalTasks);
      assert.deepEqual(snapshot.byProject, truth.byProject);

      const byProviderFromSnapshot: Record<string, number> = {};
      for (const worker of snapshot.workers) {
        const provider = worker.provider ?? "unknown";
        byProviderFromSnapshot[provider] = (byProviderFromSnapshot[provider] ?? 0) + 1;
      }
      assert.deepEqual(byProviderFromSnapshot, truth.byProvider);
    } finally {
      await simulator.stop();
    }
  });
});

test("reconcile token sum invariant", async () => {
  await withEnv("token-sum", async (env) => {
    const simulator = new WorkerSimulator({ rootDirs: env.repoRoots, registryPath: env.registryPath, seed: 42 });
    try {
      await simulator.start(basicScenario(env.repoRoots));
      const snapshot = await buildSnapshot({ includeRoots: env.repoRoots, excludeStaleAfterMs: 60_000 });
      const sumIn = snapshot.workers.reduce((acc, worker) => acc + (worker.tokensIn ?? 0), 0);
      const sumOut = snapshot.workers.reduce((acc, worker) => acc + (worker.tokensOut ?? 0), 0);
      assert.equal(snapshot.totals.tokensIn, sumIn);
      assert.equal(snapshot.totals.tokensOut, sumOut);
    } finally {
      await simulator.stop();
    }
  });
});

test("reconcile counts sum invariant", async () => {
  await withEnv("counts-sum", async (env) => {
    const simulator = new WorkerSimulator({ rootDirs: env.repoRoots, registryPath: env.registryPath, seed: 42 });
    try {
      await simulator.start(basicScenario(env.repoRoots));
      const snapshot = await buildSnapshot({ includeRoots: env.repoRoots, excludeStaleAfterMs: 60_000 });
      const counts = snapshot.counts;
      assert.equal(
        counts.workers,
        counts.active + counts.idle + counts.completed + counts.failed + counts.cancelled + counts.stale,
      );
    } finally {
      await simulator.stop();
    }
  });
});

test("duplicate registry entries do not double-count tasks", async () => {
  await withEnv("dup-registry", async (env) => {
    const scenario: SimScenario = {
      durationMs: 100,
      tickMs: 100,
      workers: [
        {
          repoRoot: env.repoRoots[0],
          provider: "codex",
          initialStatus: "running",
          durationMs: 100,
          tokensInRate: 1,
          tokensOutRate: 1,
          finalStatus: "completed",
        },
      ],
    };
    const simulator = new WorkerSimulator({ rootDirs: env.repoRoots, registryPath: env.registryPath, seed: 42 });
    try {
      await simulator.start(scenario);
      const [onlyWorker] = simulator.snapshotTruth().workers;
      assert.ok(onlyWorker);

      await appendRegistryEntry({
        taskId: onlyWorker.taskId,
        repoRoot: env.repoRoots[0],
        goal: "duplicate entry",
        createdAt: new Date().toISOString(),
      });

      const snapshot = await buildSnapshot({ includeRoots: env.repoRoots, excludeStaleAfterMs: 60_000 });
      assert.equal(snapshot.totals.totalTasks, 1);
    } finally {
      await simulator.stop();
    }
  });
});

test("symlinked repo root does not split projects", async (_t) => {
  await withEnv("symlink", async (env) => {
    const symlinkBase = join(env.baseDir, "agent-os-sim-symlink");
    const real = join(symlinkBase, "real");
    const link = join(symlinkBase, "link");
    await mkdir(real, { recursive: true });
    await symlink(real, link);

    const taskA = "symlink-task-a";
    const taskB = "symlink-task-b";

    await appendRegistryEntry({ taskId: taskA, repoRoot: real, goal: "real path", createdAt: new Date().toISOString() });
    await appendRegistryEntry({ taskId: taskB, repoRoot: link, goal: "link path", createdAt: new Date().toISOString() });

    await writeTaskSkeleton(real, taskA, "task real");
    await writeTaskSkeleton(link, taskB, "task link");

    await writeFile(
      join(real, ".agent-os", "tasks", taskA, "state.json"),
      `${JSON.stringify({ taskId: taskA, status: "running", updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(link, ".agent-os", "tasks", taskB, "state.json"),
      `${JSON.stringify({ taskId: taskB, status: "running", updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );

    const snapshot = await buildSnapshot({ includeRoots: [real, link], excludeStaleAfterMs: 60_000 });
    assert.equal(Object.keys(snapshot.byProject).length, 1);
    const count = Object.values(snapshot.byProject)[0] ?? 0;
    assert.equal(count, 2);
  });
});

test("stale state from disk classifies as stale not failed", async () => {
  await withEnv("stale-disk", async (env) => {
    const taskId = "stale-disk-task";
    const repoRoot = env.repoRoots[0];
    await appendRegistryEntry({ taskId, repoRoot, goal: "stale test", createdAt: new Date().toISOString() });
    await writeTaskSkeleton(repoRoot, taskId, "stale test");

    await writeFile(
      join(repoRoot, ".agent-os", "tasks", taskId, "state.json"),
      `${JSON.stringify({ taskId, status: "stale", updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );

    const snapshot = await buildSnapshot({ includeRoots: [repoRoot], excludeStaleAfterMs: 60_000 });
    const worker = snapshot.workers.find((item) => item.taskId === taskId);
    assert.ok(worker);
    assert.equal(worker.status, "stale");
    assert.ok(snapshot.counts.stale >= 1);
    assert.equal(snapshot.counts.failed, 0);
  });
});

test("cancelled state classifies as cancelled not failed", async () => {
  await withEnv("cancelled-disk", async (env) => {
    const taskId = "cancelled-disk-task";
    const repoRoot = env.repoRoots[0];
    await appendRegistryEntry({ taskId, repoRoot, goal: "cancelled test", createdAt: new Date().toISOString() });
    await writeTaskSkeleton(repoRoot, taskId, "cancelled test");

    await writeFile(
      join(repoRoot, ".agent-os", "tasks", taskId, "state.json"),
      `${JSON.stringify({ taskId, status: "cancelled", updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );

    const snapshot = await buildSnapshot({ includeRoots: [repoRoot], excludeStaleAfterMs: 60_000 });
    const worker = snapshot.workers.find((item) => item.taskId === taskId);
    assert.ok(worker);
    assert.equal(worker.status, "cancelled");
    assert.ok(snapshot.counts.cancelled >= 1);
    assert.equal(snapshot.counts.failed, 0);
  });
});

test("token undercount: max(exact, estimated) precedence", async () => {
  await withEnv("token-max", async (env) => {
    const taskId = "token-max-task";
    const workerId = "token-max-worker";
    const repoRoot = env.repoRoots[0];
    const now = new Date().toISOString();

    await appendRegistryEntry({ taskId, repoRoot, goal: "token max test", createdAt: now });
    await writeTaskSkeleton(repoRoot, taskId, "token max test");

    const workerDir = join(repoRoot, ".agent-os", "tasks", taskId, "workers", workerId);
    await mkdir(workerDir, { recursive: true });

    await writeFile(
      join(repoRoot, ".agent-os", "tasks", taskId, "state.json"),
      `${JSON.stringify({ taskId, status: "running", workerId, provider: "codex", updatedAt: now }, null, 2)}\n`,
      "utf8",
    );

    await writeFile(
      join(workerDir, "workspace.json"),
      `${JSON.stringify({
        taskId,
        workerId,
        provider: "codex",
        workspacePath: join(repoRoot, ".agent-os", "work", taskId, workerId),
        isolation: "temp_copy",
        startedAt: now,
      }, null, 2)}\n`,
      "utf8",
    );

    await writeFile(
      join(workerDir, "usage.json"),
      `${JSON.stringify({ inputTokens: 0, estimatedInputTokens: 1234, outputTokens: 0, exact: false }, null, 2)}\n`,
      "utf8",
    );

    const snapshot = await buildSnapshot({ includeRoots: [repoRoot], excludeStaleAfterMs: 60_000 });
    const worker = snapshot.workers.find((item) => item.taskId === taskId && item.workerId === workerId);
    assert.ok(worker);
    assert.equal(worker.tokensIn, 1234);
  });
});

test("task without workers folder appears as queued synthetic row", async () => {
  await withEnv("queued-synthetic", async (env) => {
    const taskId = "queued-synthetic-task";
    const repoRoot = env.repoRoots[0];
    await appendRegistryEntry({ taskId, repoRoot, goal: "queued synthetic", createdAt: new Date().toISOString() });
    await writeTaskSkeleton(repoRoot, taskId, "queued synthetic");

    await rm(join(repoRoot, ".agent-os", "tasks", taskId, "workers"), { recursive: true, force: true });
    await writeFile(
      join(repoRoot, ".agent-os", "tasks", taskId, "state.json"),
      `${JSON.stringify({ taskId, status: "created", updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );

    const snapshot = await buildSnapshot({ includeRoots: [repoRoot], excludeStaleAfterMs: 60_000 });
    const worker = snapshot.workers.find((item) => item.taskId === taskId);
    assert.ok(worker);
    assert.equal(worker.workerId, "—");
    assert.equal(worker.status, "queued");
  });
});
