import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRuntime, resolveRuntimePaths, upgradeRuntimeLayout } from "../src/config/config-loader.js";
import { CURRENT_RUNTIME_VERSION, runtimeInfoPath } from "../src/config/migrations.js";
import { Controller } from "../src/core/controller.js";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "agent-os-runtime-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
}

test("runtime upgrade initializes versioned layout and is idempotent", async () => {
  await withTempProject(async (projectDir) => {
    const paths = resolveRuntimePaths(projectDir);

    const first = await upgradeRuntimeLayout(paths);
    const second = await upgradeRuntimeLayout(paths);
    const info = JSON.parse(await readFile(runtimeInfoPath(paths), "utf8"));

    assert.equal(first.fromVersion, 0);
    assert.equal(first.toVersion, CURRENT_RUNTIME_VERSION);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(info.version, CURRENT_RUNTIME_VERSION);
    assert.ok(info.migrations.includes("runtime:initialize"));
  });
});

test("doctor surfaces current runtime metadata", async () => {
  await withTempProject(async (projectDir) => {
    const paths = await ensureRuntime(resolveRuntimePaths(projectDir));
    const doctor = await new Controller({ rootDir: projectDir }).doctor();
    const runtime = (doctor as { runtime?: { version?: number } }).runtime;

    assert.equal(runtime?.version, CURRENT_RUNTIME_VERSION);
    assert.equal(JSON.parse(await readFile(runtimeInfoPath(paths), "utf8")).version, CURRENT_RUNTIME_VERSION);
  });
});
