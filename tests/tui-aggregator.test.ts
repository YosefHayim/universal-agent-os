import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSnapshot } from "../src/tui/runtime/aggregator.js";
import type { RegistryEntry } from "../src/core/global-registry.js";

async function withGlobalFixture<T>(fn: (fixture: { dir: string; repoA: string; repoB: string; registryPath: string }) => Promise<T>): Promise<T> {
  // Resolve symlinks (e.g. macOS /var → /private/var) so test path comparisons match
  // the realpath-resolved form aggregator/registry code persists.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "agent-os-aggregator-")));
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
    await writeTask(repoA, "task-a", "worker-a", { goal: "A", createdAt: "2026-05-02T00:00:00.000Z", status: "running", checkedAt: "2026-05-02T00:03:00.000Z" });
    await writeFile(registryPath, `${registryLine("task-a", repoA, "A", "2026-05-02T00:00:00.000Z")}\n`, "utf8");
    const heartbeatPath = path.join(repoA, ".agent-os", "tasks", "task-a", "workers", "worker-a", "heartbeat.json");

    // Pin atime/mtime to a whole-second epoch so we round-trip through `utimes`
    // without float precision loss across filesystems (Linux ext4 has ns
    // precision; some macOS filesystems quantize to lower resolution and JS
    // numbers cannot exactly represent every ns mtime as ms).
    const pinnedSec = 1777_500_000;
    await utimes(heartbeatPath, pinnedSec, pinnedSec);
    const originalStat = await stat(heartbeatPath);

    const first = await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });
    assert.equal(first.workers[0]?.outputBytes, 25);

    // Overwrite heartbeat with new content but preserve mtime. If the JSON
    // cache honors mtime equality the second snapshot should still report
    // the originally cached outputBytes (25) rather than the new value (999).
    await writeFile(heartbeatPath, JSON.stringify({
      taskId: "task-a",
      workerId: "worker-a",
      status: "running",
      checkedAt: "2026-05-02T00:03:00.000Z",
      lastOutputAt: "2026-05-02T00:03:00.000Z",
      outputBytes: 999,
    }), "utf8");
    await utimes(heartbeatPath, pinnedSec, pinnedSec);
    const restored = await stat(heartbeatPath);
    assert.equal(restored.mtimeMs, originalStat.mtimeMs, "mtime restoration failed; cannot validate caching");

    const second = await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });
    assert.equal(second.workers[0]?.outputBytes, 25);
  });
});

test("buildSnapshot annotates running workers with cpuPercent and rssMb when pid is alive", async () => {
  if (process.platform === "win32") return; // ps unavailable on Windows; skip.
  await withGlobalFixture(async ({ repoA, registryPath }) => {
    await writeTask(repoA, "task-pid", "worker-pid", {
      goal: "pid",
      createdAt: "2026-05-02T00:00:00.000Z",
      status: "running",
      checkedAt: new Date().toISOString(),
    });
    // Overwrite workspace.json with a pid the OS knows about (this test process).
    const workspacePath = path.join(repoA, ".agent-os", "tasks", "task-pid", "workers", "worker-pid", "workspace.json");
    await writeFile(workspacePath, JSON.stringify({
      taskId: "task-pid",
      workerId: "worker-pid",
      provider: "manual",
      workspacePath: path.dirname(workspacePath),
      isolation: "temp_copy",
      startedAt: "2026-05-02T00:00:00.000Z",
      pid: process.pid,
    }), "utf8");
    await writeFile(registryPath, `${registryLine("task-pid", repoA, "pid", "2026-05-02T00:00:00.000Z")}\n`, "utf8");

    const snapshot = await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });
    const worker = snapshot.workers.find((w) => w.workerId === "worker-pid");
    assert.ok(worker, "expected pid worker in snapshot");
    assert.equal(worker?.pid, process.pid);
    assert.equal(worker?.status, "running");
    assert.equal(typeof worker?.cpuPercent, "number");
    assert.equal(typeof worker?.rssMb, "number");
    assert.ok((worker?.rssMb ?? 0) > 0, "expected non-zero RSS sample");
  });
});

test("buildSnapshot demotes running workers whose pid is no longer alive to stale", async () => {
  if (process.platform === "win32") return;
  await withGlobalFixture(async ({ repoA, registryPath }) => {
    await writeTask(repoA, "task-dead", "worker-dead", {
      goal: "dead",
      createdAt: "2026-05-02T00:00:00.000Z",
      status: "running",
      checkedAt: new Date().toISOString(),
    });
    const workspacePath = path.join(repoA, ".agent-os", "tasks", "task-dead", "workers", "worker-dead", "workspace.json");
    // 2^31 - 1 — guaranteed not to be a live pid on the test host.
    await writeFile(workspacePath, JSON.stringify({
      taskId: "task-dead",
      workerId: "worker-dead",
      provider: "manual",
      workspacePath: path.dirname(workspacePath),
      isolation: "temp_copy",
      startedAt: "2026-05-02T00:00:00.000Z",
      pid: 2147483646,
    }), "utf8");
    await writeFile(registryPath, `${registryLine("task-dead", repoA, "dead", "2026-05-02T00:00:00.000Z")}\n`, "utf8");

    const snapshot = await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });
    const worker = snapshot.workers.find((w) => w.workerId === "worker-dead");
    assert.equal(worker?.status, "stale");
    assert.equal(worker?.cpuPercent, undefined);
    assert.equal(worker?.rssMb, undefined);
  });
});

test("buildSnapshot freezes runtime for terminal workers using last heartbeat when finishedAt is missing", async () => {
  await withGlobalFixture(async ({ repoA, registryPath }) => {
    // Failed worker without workspace.finishedAt — simulates a crash before
    // external-runner finalized workspace.json. Runtime must freeze at
    // (lastHeartbeatAt - startedAt) instead of growing toward generatedAt.
    const taskDir = path.join(repoA, ".agent-os", "tasks", "task-fail", "workers", "worker-fail");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(repoA, ".agent-os", "tasks", "task-fail", "task.json"), JSON.stringify({
      id: "task-fail", goal: "boom", allowedFiles: ["**/*"], risk: "low",
      createdAt: "2026-05-02T00:00:00.000Z", updatedAt: "2026-05-02T00:00:00.000Z",
      cwd: repoA, spawnedFromPath: repoA,
    }), "utf8");
    await writeFile(path.join(repoA, ".agent-os", "tasks", "task-fail", "state.json"), JSON.stringify({
      taskId: "task-fail", status: "failed", provider: "manual", workerId: "worker-fail",
      updatedAt: "2026-05-02T00:02:00.000Z", message: "crashed",
    }), "utf8");
    await writeFile(path.join(taskDir, "workspace.json"), JSON.stringify({
      taskId: "task-fail", workerId: "worker-fail", provider: "manual",
      workspacePath: taskDir, isolation: "temp_copy",
      startedAt: "2026-05-02T00:00:00.000Z",
    }), "utf8");
    await writeFile(path.join(taskDir, "heartbeat.json"), JSON.stringify({
      taskId: "task-fail", workerId: "worker-fail", status: "running",
      checkedAt: "2026-05-02T00:02:00.000Z", lastOutputAt: "2026-05-02T00:02:00.000Z", outputBytes: 10,
    }), "utf8");
    await writeFile(path.join(taskDir, "result.json"), JSON.stringify({
      status: "failed", summary: "crashed", changedFiles: [],
    }), "utf8");
    await writeFile(registryPath, `${registryLine("task-fail", repoA, "boom", "2026-05-02T00:00:00.000Z")}\n`, "utf8");

    const snapshot = await buildSnapshot({ sinceMs: Date.parse("2026-05-01T00:00:00.000Z") });
    const worker = snapshot.workers.find((w) => w.workerId === "worker-fail");
    assert.equal(worker?.status, "failed");
    // 2 minutes between startedAt and last heartbeat.
    assert.equal(worker?.runtimeMs, 2 * 60 * 1000);
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
