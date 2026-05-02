import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { buildSnapshot } from "../src/tui/runtime/aggregator.js";
import type { RegistryEntry } from "../src/core/global-registry.js";

async function withGlobalFixture<T>(fn: (fixture: { dir: string; repoA: string; repoB: string; registryPath: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-os-aggregator-"));
  const previous = process.env.AGENT_OS_REGISTRY_FILE;
  const registryPath = path.join(dir, "registry.ndjson");
  process.env.AGENT_OS_REGISTRY_FILE = registryPath;
  try {
    const repoA = path.join(dir, "repo-a");
    const repoB = path.join(dir, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    return await fn({ dir, repoA, repoB, registryPath });
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.AGENT_OS_REGISTRY_FILE;
    else process.env.AGENT_OS_REGISTRY_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeTask(repoRoot: string, taskId: string, workerId: string, data: {
  goal: string;
  createdAt: string;
  status: string;
  heartbeatStatus?: string;
  checkedAt?: string;
  resultStatus?: string;
  modelId?: string;
}): Promise<void> {
  const taskDir = path.join(repoRoot, ".agent-os", "tasks", taskId);
  const workerDir = path.join(taskDir, "workers", workerId);
  await mkdir(workerDir, { recursive: true });
  await writeFile(path.join(taskDir, "task.json"), JSON.stringify({
    id: taskId,
    goal: data.goal,
    allowedFiles: ["**/*"],
    risk: "low",
    createdAt: data.createdAt,
    updatedAt: data.createdAt,
    cwd: repoRoot,
    spawnedFromPath: repoRoot,
  }), "utf8");
  await writeFile(path.join(taskDir, "state.json"), JSON.stringify({
    taskId,
    status: data.status,
    provider: "manual",
    workerId,
    modelId: data.modelId,
    updatedAt: data.createdAt,
    message: data.goal,
  }), "utf8");
  await writeFile(path.join(workerDir, "workspace.json"), JSON.stringify({
    taskId,
    workerId,
    provider: "manual",
    workspacePath: workerDir,
    isolation: "temp_copy",
    startedAt: data.createdAt,
    finishedAt: data.resultStatus ? "2026-05-02T00:05:00.000Z" : undefined,
  }), "utf8");
  await writeFile(path.join(workerDir, "heartbeat.json"), JSON.stringify({
    taskId,
    workerId,
    status: data.heartbeatStatus ?? "running",
    checkedAt: data.checkedAt ?? "2026-05-02T00:03:00.000Z",
    lastOutputAt: data.checkedAt ?? "2026-05-02T00:03:00.000Z",
    outputBytes: 25,
  }), "utf8");
  if (data.resultStatus) {
    await writeFile(path.join(workerDir, "result.json"), JSON.stringify({
      status: data.resultStatus,
      summary: `${data.resultStatus} summary`,
      changedFiles: ["src/index.ts"],
    }), "utf8");
  }
}

function registryLine(taskId: string, repoRoot: string, goal: string, createdAt: string): string {
  const entry: RegistryEntry = { taskId, repoRoot, goal, createdAt, provider: "manual", modelId: "manual" };
  return JSON.stringify(entry);
}

test("buildSnapshot returns workers, counts, and project groups across repos", async () => {
  await withGlobalFixture(async ({ repoA, repoB, registryPath }) => {
    await writeTask(repoA, "task-a", "worker-a", { goal: "A", createdAt: "2026-05-02T00:00:00.000Z", status: "running" });
    await writeTask(repoB, "task-b", "worker-b", { goal: "B", createdAt: "2026-05-02T00:00:00.000Z", status: "completed", heartbeatStatus: "finished", resultStatus: "completed" });
    await writeFile(registryPath, [
      registryLine("task-a", repoA, "A", "2026-05-02T00:00:00.000Z"),
      registryLine("task-b", repoB, "B", "2026-05-02T00:00:00.000Z"),
    ].join("\n") + "\n", "utf8");

    const snapshot = await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });

    assert.equal(snapshot.workers.length, 2);
    assert.deepEqual(snapshot.workers.map((worker) => worker.repoRoot).sort(), [repoA, repoB].sort());
    assert.deepEqual(snapshot.workers.map((worker) => worker.repoName).sort(), ["repo-a", "repo-b"]);
    assert.equal(snapshot.counts.active, 1);
    assert.equal(snapshot.counts.completed, 1);
    assert.equal(snapshot.byProject[repoA], 1);
    assert.equal(snapshot.byProject[repoB], 1);
  });
});

test("buildSnapshot sinceMs and includeRoots filters registry candidates", async () => {
  await withGlobalFixture(async ({ repoA, repoB, registryPath }) => {
    await writeTask(repoA, "task-a", "worker-a", { goal: "A", createdAt: "2026-05-02T00:00:00.000Z", status: "running" });
    await writeTask(repoB, "task-b", "worker-b", { goal: "B", createdAt: "2026-05-02T00:00:00.000Z", status: "running" });
    await writeTask(repoB, "task-old", "worker-old", { goal: "old", createdAt: "2026-04-01T00:00:00.000Z", status: "running" });
    await writeFile(registryPath, [
      registryLine("task-a", repoA, "A", "2026-05-02T00:00:00.000Z"),
      registryLine("task-b", repoB, "B", "2026-05-02T00:00:00.000Z"),
      registryLine("task-old", repoB, "old", "2026-04-01T00:00:00.000Z"),
    ].join("\n") + "\n", "utf8");

    const recent = await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });
    const onlyA = await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z"), includeRoots: [repoA] });

    assert.deepEqual(recent.workers.map((worker) => worker.taskId).sort(), ["task-a", "task-b"]);
    assert.deepEqual(onlyA.workers.map((worker) => worker.taskId), ["task-a"]);
  });
});

test("buildSnapshot reuses cached JSON when mtimes are unchanged", async () => {
  await withGlobalFixture(async ({ repoA, registryPath }) => {
    await writeTask(repoA, "task-a", "worker-a", { goal: "A", createdAt: "2026-05-02T00:00:00.000Z", status: "running" });
    await writeFile(registryPath, `${registryLine("task-a", repoA, "A", "2026-05-02T00:00:00.000Z")}\n`, "utf8");
    const heartbeatPath = path.join(repoA, ".agent-os", "tasks", "task-a", "workers", "worker-a", "heartbeat.json");
    let heartbeatReads = 0;
    const originalReadFile = fs.readFile;
    mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>): Promise<Awaited<ReturnType<typeof fs.readFile>>> => {
      if (String(args[0]) === heartbeatPath) heartbeatReads += 1;
      return originalReadFile(...args);
    });

    await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });
    await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });

    assert.equal(heartbeatReads, 1);
  });
});

test("buildSnapshot skips corrupted heartbeat and keeps other workers", async () => {
  await withGlobalFixture(async ({ repoA, repoB, registryPath }) => {
    await writeTask(repoA, "task-a", "worker-a", { goal: "A", createdAt: "2026-05-02T00:00:00.000Z", status: "running" });
    await writeTask(repoB, "task-b", "worker-b", { goal: "B", createdAt: "2026-05-02T00:00:00.000Z", status: "running" });
    await writeFile(path.join(repoA, ".agent-os", "tasks", "task-a", "workers", "worker-a", "heartbeat.json"), "{bad", "utf8");
    await writeFile(registryPath, [
      registryLine("task-a", repoA, "A", "2026-05-02T00:00:00.000Z"),
      registryLine("task-b", repoB, "B", "2026-05-02T00:00:00.000Z"),
    ].join("\n") + "\n", "utf8");

    const snapshot = await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });

    assert.equal(snapshot.workers.length, 2);
    assert.ok(snapshot.workers.some((worker) => worker.taskId === "task-b"));
  });
});
