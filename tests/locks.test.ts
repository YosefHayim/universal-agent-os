import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAgentOsConfig } from "../src/config/config-loader.js";
import { TaskLockManager } from "../src/core/locks.js";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "agent-os-locks-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
}

test("task locks are exclusive and releasable", async () => {
  await withTempProject(async (projectDir) => {
    const config = await loadAgentOsConfig({ cwd: projectDir });
    const locks = new TaskLockManager(config.paths);
    const first = await locks.acquireTaskLock("task-lock-test", "first owner");

    await assert.rejects(
      () => locks.acquireTaskLock("task-lock-test", "second owner"),
      /already locked/,
    );

    await first.release();
    const second = await locks.acquireTaskLock("task-lock-test", "second owner");
    await second.release();
  });
});
