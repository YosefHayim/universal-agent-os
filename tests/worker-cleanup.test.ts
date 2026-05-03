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
  // Children that ignore SIGTERM print "ready" to stdout once their handlers
  // are installed, so the test can wait for that before driving cleanup.
  const script = opts.ignoreTerm
    ? "process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000);"
    : "process.stdout.write('ready\\n'); setInterval(()=>{},1000);";
  // stdio:'pipe' keeps the child fully attached to streams so its SIGTERM
  // handler is honored — with stdio:'ignore' Node sometimes terminates on
  // SIGTERM before user-land handlers run on macOS.
  return spawn(process.execPath, ["-e", script], { stdio: "pipe", detached: true });
}

async function waitForReady(child: TrackedWorker["child"]): Promise<void> {
  await new Promise<void>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      if (buf.includes("ready")) {
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
  });
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
  // Wait deterministically for the child to install its SIGTERM/SIGINT
  // handlers (signalled by writing "ready" to stdout). Without this, Node
  // startup can race with cleanup and the SIGTERM is honored before the
  // user-land handler runs — making the assertion flake to "SIGTERM".
  await waitForReady(child);

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
