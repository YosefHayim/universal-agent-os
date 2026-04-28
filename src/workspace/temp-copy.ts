import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const EXCLUDED = new Set([".git", ".agent-os", "node_modules", "dist", "coverage", ".coverage"]);

export async function createTempCopy(sourceDir: string, destinationDir: string): Promise<string> {
  await rm(destinationDir, { force: true, recursive: true });
  await mkdir(destinationDir, { recursive: true });
  await cp(sourceDir, destinationDir, {
    dereference: false,
    errorOnExist: false,
    filter: (source) => !source.split(/[\\/]/).some((part) => EXCLUDED.has(part)),
    force: true,
    recursive: true,
  });
  return destinationDir;
}

export function workerWorkspaceDir(taskDir: string, workerId: string): string {
  return join(taskDir, "workers", workerId, "workspace");
}

export interface TempCopyWorkspace {
  sourceDir: string;
  runtimeDir: string;
  taskId: string;
  workerId: string;
  workspacePath: string;
  allowedFiles: string[];
  isolation: "temp_copy";
}

export async function createTempCopyWorkspace(input: {
  sourceDir: string;
  runtimeDir: string;
  taskId: string;
  workerId: string;
  allowedFiles: string[];
}): Promise<TempCopyWorkspace> {
  const workspacePath = join(input.runtimeDir, "tasks", input.taskId, "workers", input.workerId);
  await createTempCopy(input.sourceDir, workspacePath);
  const workspace: TempCopyWorkspace = { ...input, workspacePath, isolation: "temp_copy" };
  await writeFile(join(workspacePath, "workspace.json"), `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
  return workspace;
}

export async function removeTempCopyWorkspace(workspace: Pick<TempCopyWorkspace, "workspacePath">): Promise<void> {
  await rm(workspace.workspacePath, { force: true, recursive: true });
}
