import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function isGitRepo(cwd: string): boolean {
  return spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" }).status === 0;
}

export async function createGitWorktree(sourceDir: string, destinationDir: string): Promise<string> {
  await rm(destinationDir, { force: true, recursive: true });
  await mkdir(dirname(destinationDir), { recursive: true });
  const result = spawnSync("git", ["worktree", "add", "--detach", destinationDir, "HEAD"], { cwd: sourceDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git worktree add failed");
  return destinationDir;
}

export async function removeGitWorktree(sourceDir: string, destinationDir: string): Promise<void> {
  spawnSync("git", ["worktree", "remove", "--force", destinationDir], { cwd: sourceDir, encoding: "utf8" });
  await rm(destinationDir, { force: true, recursive: true });
}

export interface GitWorktreeWorkspace {
  sourceDir: string;
  runtimeDir: string;
  taskId: string;
  workerId: string;
  workspacePath: string;
  allowedFiles: string[];
  isolation: "git_worktree";
}

export async function createGitWorktreeWorkspace(input: {
  sourceDir: string;
  runtimeDir: string;
  taskId: string;
  workerId: string;
  allowedFiles: string[];
}): Promise<GitWorktreeWorkspace> {
  const workspacePath = join(input.runtimeDir, "tasks", input.taskId, "workers", input.workerId);
  await createGitWorktree(input.sourceDir, workspacePath);
  const workspace: GitWorktreeWorkspace = { ...input, workspacePath, isolation: "git_worktree" };
  await writeFile(join(workspacePath, "workspace.json"), `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
  return workspace;
}

export async function removeGitWorktreeWorkspace(workspace: GitWorktreeWorkspace): Promise<void> {
  await removeGitWorktree(workspace.sourceDir, workspace.workspacePath);
}
