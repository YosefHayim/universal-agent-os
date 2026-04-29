import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRuntime, resolveRuntimePaths } from "../src/config/config-loader.js";
import { fileSummaryCachePath } from "../src/context/cache-layout.js";
import { compileContext } from "../src/context/compiler.js";
import { Controller } from "../src/core/controller.js";
import { TaskQueue } from "../src/core/queue.js";
import { createTask, readState, taskDir, updateState } from "../src/core/lifecycle.js";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "agent-os-context-queue-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
}

test("task queue persists lifecycle controls across instances", async () => {
  await withTempProject(async (projectDir) => {
    const paths = await ensureRuntime(resolveRuntimePaths(projectDir));
    const queue = new TaskQueue(paths);

    await queue.enqueue("task-a", "created", "created");
    await queue.update("task-a", "running", "worker started");
    await queue.enqueue("task-b", "created", "created");

    const reloaded = new TaskQueue(paths);
    assert.equal((await reloaded.list()).find((item) => item.taskId === "task-a")?.status, "running");

    await reloaded.pause("task-a");
    await reloaded.resume("task-a");
    await reloaded.cancel("task-a");

    const state = JSON.parse(await readFile(path.join(projectDir, ".agent-os", "queue.json"), "utf8"));
    const taskA = state.items.find((item: { taskId: string }) => item.taskId === "task-a");
    assert.equal(taskA.status, "cancelled");
    assert.equal(taskA.message, "cancelled by user");
    assert.equal(state.items.length, 2);
  });
});

test("controller pause and resume persist task state with queue state", async () => {
  await withTempProject(async (projectDir) => {
    const controller = await Controller.create({ rootDir: projectDir });
    const created = await controller.taskCreate("pause resumable work", {
      allowedFiles: ["src/**"],
      risk: "low",
    });
    const taskId = String(created.id);

    const paused = await controller.queuePause(taskId);
    const pausedState = await readState(controller.paths, taskId);
    const blockedRun = await controller.taskRun(taskId, "manual").then(
      () => "unexpected success",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );

    assert.equal(paused.status, "paused");
    assert.equal(pausedState.status, "paused");
    assert.match(blockedRun, /paused/);

    const resumed = await controller.taskResume(taskId);
    const queue = await controller.queueStatus();

    assert.equal(resumed.status, "planned");
    assert.equal(queue.items.find((item) => item.taskId === taskId)?.status, "planned");
  });
});

test("controller resume refuses terminal tasks", async () => {
  await withTempProject(async (projectDir) => {
    const controller = await Controller.create({ rootDir: projectDir });
    const created = await controller.taskCreate("do not regress completed work", {
      allowedFiles: ["src/**"],
      risk: "low",
    });
    const taskId = String(created.id);
    await updateState(controller.paths, taskId, "completed", { message: "done" });

    const resumeResult = await controller.taskResume(taskId).then(
      () => "unexpected success",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    const pauseResult = await controller.taskPause(taskId).then(
      () => "unexpected success",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    const state = await readState(controller.paths, taskId);

    assert.match(resumeResult, /Cannot resume/);
    assert.match(pauseResult, /Cannot pause/);
    assert.equal(state.status, "completed");
  });
});

test("controller recovery marks stale running workers and restores completed artifacts", async () => {
  await withTempProject(async (projectDir) => {
    const controller = await Controller.create({ rootDir: projectDir });
    const staleTask = await controller.taskCreate("recover stale worker", {
      allowedFiles: ["src/**"],
      risk: "low",
    });
    const completeTask = await controller.taskCreate("recover completed worker", {
      allowedFiles: ["src/**"],
      risk: "low",
    });
    const staleTaskId = String(staleTask.id);
    const completeTaskId = String(completeTask.id);

    await updateState(controller.paths, staleTaskId, "running", {
      provider: "codex",
      workerId: "codex-old",
      message: "worker started",
    });
    const staleWorkerDir = path.join(taskDir(controller.paths, staleTaskId), "workers", "codex-old");
    await mkdir(staleWorkerDir, { recursive: true });
    await writeFile(path.join(staleWorkerDir, "heartbeat.json"), JSON.stringify({
      taskId: staleTaskId,
      workerId: "codex-old",
      status: "running",
      checkedAt: "2026-04-28T00:00:00.000Z",
    }, null, 2));

    await updateState(controller.paths, completeTaskId, "running", {
      provider: "claude",
      workerId: "claude-done",
      message: "worker started",
    });
    const completeWorkerDir = path.join(taskDir(controller.paths, completeTaskId), "workers", "claude-done");
    await mkdir(completeWorkerDir, { recursive: true });
    await writeFile(path.join(completeWorkerDir, "heartbeat.json"), JSON.stringify({
      taskId: completeTaskId,
      workerId: "claude-done",
      status: "finished",
      checkedAt: "2026-04-28T00:00:20.000Z",
    }, null, 2));
    await writeFile(path.join(completeWorkerDir, "result.json"), JSON.stringify({
      status: "completed",
      summary: "survived controller crash",
      changedFiles: ["src/recovered.ts"],
    }, null, 2));

    const report = await controller.taskRecover(undefined, {
      staleAfterMs: 30_000,
      now: new Date("2026-04-28T00:02:00.000Z"),
    });
    const staleState = await readState(controller.paths, staleTaskId);
    const completeState = await readState(controller.paths, completeTaskId);

    assert.equal(staleState.status, "stale");
    assert.equal(completeState.status, "completed");
    assert.equal(report.recovered.find((item) => item.taskId === staleTaskId)?.action, "marked_stale");
    assert.equal(report.recovered.find((item) => item.taskId === completeTaskId)?.action, "restored_completed");
    assert.match(String(report.recovered.find((item) => item.taskId === staleTaskId)?.resumeCommand), /agent-os task resume/);
  });
});

test("context compiler records selected file metadata and respects file and byte budgets", async () => {
  const originalMaxFiles = process.env.AGENT_OS_CONTEXT_MAX_FILES;
  const originalMaxBytes = process.env.AGENT_OS_CONTEXT_MAX_BYTES;
  process.env.AGENT_OS_CONTEXT_MAX_FILES = "2";
  process.env.AGENT_OS_CONTEXT_MAX_BYTES = "220";
  try {
    await withTempProject(async (projectDir) => {
      await mkdir(path.join(projectDir, "src"), { recursive: true });
      await writeFile(path.join(projectDir, "src", "a.ts"), "export const a = 'alpha';\n", "utf8");
      await writeFile(path.join(projectDir, "src", "b.ts"), "export const b = 'beta';\n", "utf8");
      await writeFile(path.join(projectDir, "src", "c.ts"), "export const c = 'gamma';\n", "utf8");
      const paths = await ensureRuntime(resolveRuntimePaths(projectDir));
      const task = await createTask("compile a compact context", {
        rootDir: projectDir,
        allowedFiles: ["src/**"],
        risk: "low",
      });

      const bundle = await compileContext(paths, task);
      const metadata = JSON.parse(await readFile(bundle.filesPath, "utf8"));

      assert.equal(metadata.maxFiles, 2);
      assert.equal(metadata.budgetBytes, 220);
      assert.ok(metadata.selectedFiles.length >= 1);
      assert.ok(metadata.selectedFiles.length <= 2);
      assert.ok(metadata.files.some((file: { included: boolean }) => file.included));
      assert.ok(metadata.files.some((file: { included: boolean; reason?: string }) => !file.included && ["max_files", "byte_budget"].includes(String(file.reason))));
    });
  } finally {
    if (originalMaxFiles === undefined) delete process.env.AGENT_OS_CONTEXT_MAX_FILES;
    else process.env.AGENT_OS_CONTEXT_MAX_FILES = originalMaxFiles;
    if (originalMaxBytes === undefined) delete process.env.AGENT_OS_CONTEXT_MAX_BYTES;
    else process.env.AGENT_OS_CONTEXT_MAX_BYTES = originalMaxBytes;
  }
});

test("context compiler ranks task-relevant files first and includes summaries within budget", async () => {
  const originalMaxFiles = process.env.AGENT_OS_CONTEXT_MAX_FILES;
  const originalMaxBytes = process.env.AGENT_OS_CONTEXT_MAX_BYTES;
  const originalMaxSummaries = process.env.AGENT_OS_CONTEXT_MAX_SUMMARIES;
  process.env.AGENT_OS_CONTEXT_MAX_FILES = "1";
  process.env.AGENT_OS_CONTEXT_MAX_BYTES = "3200";
  process.env.AGENT_OS_CONTEXT_MAX_SUMMARIES = "3";
  try {
    await withTempProject(async (projectDir) => {
      await mkdir(path.join(projectDir, "src"), { recursive: true });
      await writeFile(path.join(projectDir, "src", "billing.ts"), [
        "export function calculateInvoiceTotal(value: number) {",
        "  return value;",
        "}",
        "",
      ].join("\n"), "utf8");
      await writeFile(path.join(projectDir, "src", "queue.ts"), [
        "export function queueWorker() {",
        "  return 'queue';",
        "}",
        "export function enqueueTask() {",
        "  return 'task';",
        "}",
        "",
      ].join("\n").repeat(20), "utf8");
      await writeFile(path.join(projectDir, "src", "telemetry.ts"), [
        "export function appendTelemetrySpan() {",
        "  return 'span';",
        "}",
        "",
      ].join("\n"), "utf8");
      const paths = await ensureRuntime(resolveRuntimePaths(projectDir));
      const task = await createTask("improve queue worker reliability", {
        rootDir: projectDir,
        allowedFiles: ["src/**"],
        risk: "low",
      });

      const bundle = await compileContext(paths, task);
      const metadata = JSON.parse(await readFile(bundle.filesPath, "utf8"));
      const bundleText = await readFile(bundle.bundlePath, "utf8");

      assert.deepEqual(metadata.selectedFiles, ["src/queue.ts"]);
      assert.ok(metadata.summarizedFiles.length >= 1);
      assert.match(bundleText, /project-file-summary/);
      assert.ok(metadata.estimatedSavedBytes > 0);
      assert.equal(metadata.files[0].path, "src/queue.ts");
      assert.equal(metadata.files[0].mode, "full");
    });
  } finally {
    if (originalMaxFiles === undefined) delete process.env.AGENT_OS_CONTEXT_MAX_FILES;
    else process.env.AGENT_OS_CONTEXT_MAX_FILES = originalMaxFiles;
    if (originalMaxBytes === undefined) delete process.env.AGENT_OS_CONTEXT_MAX_BYTES;
    else process.env.AGENT_OS_CONTEXT_MAX_BYTES = originalMaxBytes;
    if (originalMaxSummaries === undefined) delete process.env.AGENT_OS_CONTEXT_MAX_SUMMARIES;
    else process.env.AGENT_OS_CONTEXT_MAX_SUMMARIES = originalMaxSummaries;
  }
});

test("context compiler refreshes cached summaries when file content changes", async () => {
  await withTempProject(async (projectDir) => {
    await mkdir(path.join(projectDir, "src"), { recursive: true });
    const target = path.join(projectDir, "src", "watched.ts");
    await writeFile(target, "export function oldThing() { return 'old'; }\n", "utf8");
    const paths = await ensureRuntime(resolveRuntimePaths(projectDir));
    const firstTask = await createTask("inspect watched summary", {
      rootDir: projectDir,
      allowedFiles: ["src/**"],
      risk: "low",
    });

    await compileContext(paths, firstTask);
    let entries = JSON.parse(await readFile(fileSummaryCachePath(paths), "utf8"));
    let watched = entries.find((entry: { path: string }) => entry.path === "src/watched.ts");
    assert.match(watched.summary, /oldThing/);

    await writeFile(target, "export function newThing() { return 'new'; }\n", "utf8");
    const secondTask = await createTask("inspect watched summary again", {
      rootDir: projectDir,
      allowedFiles: ["src/**"],
      risk: "low",
    });

    await compileContext(paths, secondTask);
    entries = JSON.parse(await readFile(fileSummaryCachePath(paths), "utf8"));
    watched = entries.find((entry: { path: string }) => entry.path === "src/watched.ts");
    assert.match(watched.summary, /newThing/);
    assert.doesNotMatch(watched.summary, /oldThing/);
    assert.equal(typeof watched.hash, "string");
  });
});
