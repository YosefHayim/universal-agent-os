import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRuntime, resolveRuntimePaths } from "../src/config/config-loader.js";
import { compileContext } from "../src/context/compiler.js";
import { createTask } from "../src/core/lifecycle.js";
import type { LimitSignal, ProviderCapabilities, ProviderContext, ProviderDetection, ProviderResult, ProviderStatus, Task } from "../src/core/types.js";
import type { ProviderAdapter } from "../src/providers/adapter.js";
import { runExternalProvider } from "../src/providers/external-runner.js";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "agent-os-external-runner-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
}

test("external runner writes live durable logs and suppresses usage-only progress", async () => {
  await withTempProject(async (projectDir) => {
    await mkdir(path.join(projectDir, "src"), { recursive: true });
    await writeFile(path.join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const paths = await ensureRuntime(resolveRuntimePaths(projectDir));
    const task = await createTask("capture provider logs", { rootDir: projectDir, allowedFiles: ["src/**"], risk: "low" });
    const bundle = await compileContext(paths, task);
    const progress: string[] = [];

    const run = await runExternalProvider({ paths, cwd: projectDir }, task, bundle.bundlePath, fakeExternalAdapter([
      "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'runner finished' }] }) + '\\n');",
      "process.stderr.write('provider note\\n');",
    ].join("")), {
      onProgress: (event) => {
        if (event.message) progress.push(event.message);
      },
    });

    const workerDir = path.join(paths.tasksDir, task.id, "workers", run.worker.workerId);
    const stdout = await readFile(path.join(workerDir, "stdout.log"), "utf8");
    const stderr = await readFile(path.join(workerDir, "stderr.log"), "utf8");
    const heartbeat = JSON.parse(await readFile(path.join(workerDir, "heartbeat.json"), "utf8"));

    assert.equal(run.result.status, "completed");
    assert.match(stdout, /runner finished/);
    assert.match(stderr, /provider note/);
    assert.equal(heartbeat.status, "finished");
    assert.ok(progress.some((line) => /runner finished/.test(line)));
    assert.ok(!progress.some((line) => /usage received/.test(line)));
  });
});

test("external runner fails fast when provider output exceeds the configured byte limit", async () => {
  const originalLimit = process.env.AGENT_OS_PROVIDER_MAX_OUTPUT_BYTES;
  process.env.AGENT_OS_PROVIDER_MAX_OUTPUT_BYTES = "64";
  try {
    await withTempProject(async (projectDir) => {
      await mkdir(path.join(projectDir, "src"), { recursive: true });
      await writeFile(path.join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
      const paths = await ensureRuntime(resolveRuntimePaths(projectDir));
      const task = await createTask("trip output guard", { rootDir: projectDir, allowedFiles: ["src/**"], risk: "low" });
      const bundle = await compileContext(paths, task);

      const run = await runExternalProvider({ paths, cwd: projectDir }, task, bundle.bundlePath, fakeExternalAdapter(
        "process.stdout.write('x'.repeat(512));",
      ));

      const workerDir = path.join(paths.tasksDir, task.id, "workers", run.worker.workerId);
      const stderr = await readFile(path.join(workerDir, "stderr.log"), "utf8");

      assert.equal(run.result.status, "failed");
      assert.match(stderr, /exceeded max output bytes/);
    });
  } finally {
    if (originalLimit === undefined) delete process.env.AGENT_OS_PROVIDER_MAX_OUTPUT_BYTES;
    else process.env.AGENT_OS_PROVIDER_MAX_OUTPUT_BYTES = originalLimit;
  }
});

function fakeExternalAdapter(script: string): ProviderAdapter {
  return {
    id: "manual",
    async detect(): Promise<ProviderDetection> {
      return { available: true, detail: "test adapter" };
    },
    async status(): Promise<ProviderStatus> {
      return { provider: "manual", availability: "available", detail: "test adapter", checkedAt: new Date().toISOString() };
    },
    async capabilities(): Promise<ProviderCapabilities> {
      return { provider: "manual", canLaunch: true, structuredOutput: true, worktree: false, cloudHosted: false };
    },
    async discoverModels() {
      return [];
    },
    async buildLaunchCommand(_ctx: ProviderContext, _task: Task, _bundlePath: string) {
      return { command: process.execPath, args: ["-e", script] };
    },
    async parseOutput(_ctx: ProviderContext, stdout: string): Promise<ProviderResult> {
      return {
        status: stdout ? "completed" : "failed",
        summary: stdout ? "fake runner completed" : "fake runner produced no stdout",
        changedFiles: [],
      };
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
}
