import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentOsController } from "../src/core/controller.js";
import { readRegistryEntries } from "../src/core/global-registry.js";
import type { Task } from "../src/core/types.js";

async function withTempProject<T>(fn: (projectDir: string, registryPath: string) => Promise<T>): Promise<T> {
  // Resolve symlinks (e.g. macOS /var → /private/var) so test path comparisons match
  // the realpath-resolved form that controller code persists.
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "agent-os-controller-")));
  const previous = process.env.AGENT_OS_REGISTRY_FILE;
  process.env.AGENT_OS_REGISTRY_FILE = path.join(projectDir, "registry.ndjson");
  try {
    return await fn(projectDir, process.env.AGENT_OS_REGISTRY_FILE);
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_REGISTRY_FILE;
    else process.env.AGENT_OS_REGISTRY_FILE = previous;
    await rm(projectDir, { recursive: true, force: true });
  }
}

test("taskCreate writes spawnedFromPath and appends registry entry", async () => {
  await withTempProject(async (projectDir) => {
    const controller = await AgentOsController.create({ cwd: projectDir });
    const task = await controller.createTask({ goal: "record origin", risk: "low" });
    const persisted = JSON.parse(await readFile(path.join(projectDir, ".agent-os", "tasks", task.id, "task.json"), "utf8")) as Task;
    const entries = await readRegistryEntries();

    assert.equal(persisted.spawnedFromPath, projectDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.taskId, task.id);
    assert.equal(entries[0]?.repoRoot, projectDir);
  });
});
