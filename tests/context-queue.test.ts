import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRuntime, resolveRuntimePaths } from "../src/config/config-loader.js";
import { fileSummaryCachePath } from "../src/context/cache-layout.js";
import { compileContext } from "../src/context/compiler.js";
import { TaskQueue } from "../src/core/queue.js";
import { createTask } from "../src/core/lifecycle.js";

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
