import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { chooseIsolationMode } from "../src/workspace/isolation-policy.js";
import { captureWorkspaceDiff } from "../src/workspace/diff.js";
import { createGitWorktreeWorkspace, removeGitWorktreeWorkspace } from "../src/workspace/git-worktree.js";
import { isHeartbeatStale, writeHeartbeat } from "../src/workspace/heartbeat.js";
import { createTempCopyWorkspace, removeTempCopyWorkspace } from "../src/workspace/temp-copy.js";

const execFileAsync = promisify(execFile);

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-os-repo-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "allowed.ts"), "export const value = 1;\n");
  await writeFile(path.join(root, "src", "other.ts"), "export const other = 1;\n");
  await writeFile(path.join(root, ".env"), "OPENROUTER_API_KEY=sk-secret\n");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test User", "commit", "-m", "fixture"],
    { cwd: root },
  );
  return root;
}

test("isolation policy never selects the main checkout for worker edits", () => {
  assert.equal(
    chooseIsolationMode({
      risk: "high",
      isGitRepository: true,
      providerSupportsWorktree: true,
    }),
    "temp_copy",
  );

  assert.equal(
    chooseIsolationMode({
      risk: "low",
      isGitRepository: true,
      providerSupportsWorktree: true,
    }),
    "git_worktree",
  );

  assert.equal(
    chooseIsolationMode({
      risk: "low",
      isGitRepository: false,
      providerSupportsWorktree: true,
    }),
    "temp_copy",
  );
});

test("temp-copy workspace records metadata and captures allowed-file diffs outside main checkout", async () => {
  const repo = await createFixtureRepo();
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "agent-os-runtime-"));

  try {
    const workspace = await createTempCopyWorkspace({
      sourceDir: repo,
      runtimeDir,
      taskId: "task-1",
      workerId: "worker-1",
      allowedFiles: ["src/allowed.ts"],
    });

    assert.notEqual(path.resolve(workspace.workspacePath), path.resolve(repo));
    assert.equal(workspace.isolation, "temp_copy");

    const metadata = JSON.parse(await readFile(path.join(workspace.workspacePath, "workspace.json"), "utf8"));
    assert.equal(metadata.sourceDir, repo);
    assert.deepEqual(metadata.allowedFiles, ["src/allowed.ts"]);

    await writeFile(path.join(workspace.workspacePath, "src", "allowed.ts"), "export const value = 2;\n");
    await writeFile(path.join(workspace.workspacePath, "src", "new.ts"), "export const nope = true;\n");

    const diff = await captureWorkspaceDiff({
      workspacePath: workspace.workspacePath,
      sourceDir: repo,
      allowedFiles: ["src/allowed.ts"],
      isolation: "temp_copy",
    });

    assert.deepEqual(diff.changedFiles, ["src/allowed.ts"]);
    assert.match(diff.patch, /allowed\.ts/);
    assert.match(diff.patch, /value = 2/);

    await removeTempCopyWorkspace(workspace);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("git worktree workspace is created away from the main checkout and removable", async () => {
  const repo = await createFixtureRepo();
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "agent-os-runtime-"));

  try {
    const workspace = await createGitWorktreeWorkspace({
      sourceDir: repo,
      runtimeDir,
      taskId: "task-2",
      workerId: "worker-2",
      allowedFiles: ["src/allowed.ts"],
    });

    assert.notEqual(path.resolve(workspace.workspacePath), path.resolve(repo));
    assert.equal(workspace.isolation, "git_worktree");

    await writeFile(path.join(workspace.workspacePath, "src", "allowed.ts"), "export const value = 3;\n");
    const diff = await captureWorkspaceDiff({
      workspacePath: workspace.workspacePath,
      allowedFiles: ["src/allowed.ts"],
      isolation: "git_worktree",
    });

    assert.deepEqual(diff.changedFiles, ["src/allowed.ts"]);
    assert.match(diff.patch, /value = 3/);

    await removeGitWorktreeWorkspace(workspace);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("heartbeat helper detects stale workers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-os-heartbeat-"));

  try {
    const file = path.join(dir, "heartbeat.json");
    await writeHeartbeat(file, {
      taskId: "task-3",
      workerId: "worker-3",
      status: "running",
      timestamp: "2026-04-28T00:00:00.000Z",
    });

    assert.equal(
      await isHeartbeatStale(file, {
        now: new Date("2026-04-28T00:00:10.000Z"),
        staleAfterMs: 30_000,
      }),
      false,
    );

    assert.equal(
      await isHeartbeatStale(file, {
        now: new Date("2026-04-28T00:02:00.000Z"),
        staleAfterMs: 30_000,
      }),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
