import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentOsController } from "../src/core/controller.js";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "agent-os-artifacts-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
}

test("manual task lifecycle writes durable artifacts without editing the checkout", async () => {
  await withTempProject(async (projectDir) => {
    const controller = await AgentOsController.create({ cwd: projectDir });

    const task = await controller.createTask({
      allowedFiles: ["src/**"],
      goal: "prove the manual lifecycle",
      risk: "low",
    });
    const plan = await controller.planTask(task.id);
    const dryRun = await controller.dryRunTask(task.id, { provider: "manual" });
    const run = await controller.runTask(task.id, { provider: "manual" });

    assert.equal(plan.taskId, task.id);
    assert.equal(dryRun.status, "dry_run");
    assert.equal(run.status, "completed");
    assert.equal(run.provider, "manual");

    const taskDir = path.join(projectDir, ".agent-os", "tasks", task.id);
    const artifacts = [
      "task.json",
      "plan.json",
      "state.json",
      "events.ndjson",
      "context/bundle.md",
      "context/files.json",
      "workers/manual-1/workspace.json",
      "workers/manual-1/result.json",
      "workers/manual-1/stdout.log",
      "workers/manual-1/stderr.log",
      "workers/manual-1/diff.patch",
    ];

    for (const artifact of artifacts) {
      const contents = await readFile(path.join(taskDir, artifact), "utf8");
      assert.ok(contents.length >= 0, `${artifact} should be readable`);
    }

    const state = JSON.parse(await readFile(path.join(taskDir, "state.json"), "utf8"));
    const result = JSON.parse(
      await readFile(path.join(taskDir, "workers", "manual-1", "result.json"), "utf8"),
    );
    const rootEntries = await readdir(projectDir);

    assert.equal(state.status, "completed");
    assert.equal(result.status, "completed");
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(rootEntries, [".agent-os"]);
  });
});
