import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupWorkers, type TrackedWorker } from "../src/core/worker-cleanup.js";

/**
 * Spawns a real Node process that ignores SIGTERM (so we can drive both the
 * graceful and SIGKILL paths) or accepts it (graceful path). detached:true
 * matches the production runner so the cleanup helper exercises its real
 * `process.kill(-pid, ...)` path.
 */
function spawnWorker(opts: { ignoreTerm: boolean }): TrackedWorker["child"] {
  const script = opts.ignoreTerm
    ? "process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); setInterval(()=>{},1000);"
    : "setInterval(()=>{},1000);";
  // stdio:'pipe' keeps the child fully attached to streams so its SIGTERM
  // handler is honored — with stdio:'ignore' Node sometimes terminates on
  // SIGTERM before user-land handlers run on macOS.
  return spawn(process.execPath, ["-e", script], { stdio: "pipe", detached: true });
}

test("cleanupWorkers SIGTERMs graceful workers and prunes their workspaces", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "agent-os-cleanup-"));
  writeFileSync(join(workspacePath, "scratch.txt"), "hello", "utf8");
  const child = spawnWorker({ ignoreTerm: false });
  const tracked: TrackedWorker = { child, workspacePath };

  await cleanupWorkers([tracked], 1_500);

  assert.equal(child.exitCode !== null || child.signalCode !== null, true, "child should have exited");
  assert.equal(existsSync(workspacePath), false, "workspace should be pruned");
});

test("cleanupWorkers escalates to SIGKILL when grace period elapses", async () => {
  const child = spawnWorker({ ignoreTerm: true });
  const tracked: TrackedWorker = { child };
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  // Give the child a moment to install its SIGTERM handler before cleanup
  // tries to terminate it; otherwise the test races with Node's startup.
  await new Promise((resolve) => setTimeout(resolve, 200));

  await cleanupWorkers([tracked], 200);
  await exited;

  assert.equal(child.signalCode, "SIGKILL");
});

test("cleanupWorkers is a no-op for empty input", async () => {
  await cleanupWorkers([], 10);
});

test("cleanupWorkers tolerates missing workspace dirs", async () => {
  const child = spawnWorker({ ignoreTerm: false });
  const tracked: TrackedWorker = {
    child,
    workspacePath: join(tmpdir(), "agent-os-cleanup-does-not-exist-xyz"),
  };
  await cleanupWorkers([tracked], 1_500);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});
