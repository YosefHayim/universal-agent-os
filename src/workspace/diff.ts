import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { matchesAnyGlob } from "../validators/scope-check.js";

/**
 * Strip GIT_* env vars before spawning git in a foreign repo. When this code
 * runs from inside a git hook (e.g. husky pre-commit) the parent's
 * GIT_INDEX_FILE/GIT_DIR/GIT_WORK_TREE leak into children and silently
 * pin them to the wrong index, producing empty diffs.
 */
function gitChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_")) continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function buildNewFilePatch(relativePath: string, content: string): Promise<string> {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export async function buildSimplePatch(rootDir: string, workspaceDir: string, changedFiles: string[]): Promise<string> {
  const patches = await Promise.all(changedFiles.map(async (relativePath) => {
    const workspacePath = join(workspaceDir, relativePath);
    const rootPath = join(rootDir, relativePath);
    const content = await readFile(workspacePath, "utf8");
    if (!(await fileExists(rootPath))) return buildNewFilePatch(relativePath, content);
    const previous = await readFile(rootPath, "utf8");
    if (previous === content) return "";
    const previousLines = previous.endsWith("\n") ? previous.slice(0, -1).split("\n") : previous.split("\n");
    const nextLines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    return [
      `diff --git a/${relativePath} b/${relativePath}`,
      `--- a/${relativePath}`,
      `+++ b/${relativePath}`,
      `@@ -1,${previousLines.length} +1,${nextLines.length} @@`,
      ...previousLines.map((line) => `-${line}`),
      ...nextLines.map((line) => `+${line}`),
      "",
    ].join("\n");
  }));
  return patches.filter(Boolean).join("\n");
}

export function changedFilesFromPatch(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2] || match[1]).filter(Boolean);
}

export function parentDir(path: string): string {
  return dirname(path);
}

export async function captureWorkspaceDiff(input: {
  workspacePath: string;
  sourceDir?: string;
  allowedFiles: string[];
  isolation: "temp_copy" | "git_worktree";
}): Promise<{ patch: string; changedFiles: string[] }> {
  if (input.isolation === "git_worktree") {
    const result = spawnSync("git", ["diff", "--", ...input.allowedFiles], { cwd: input.workspacePath, encoding: "utf8", env: gitChildEnv() });
    const patch = result.stdout;
    return { patch, changedFiles: changedFilesFromPatch(patch).filter((file) => matchesAnyGlob(file, input.allowedFiles)) };
  }
  if (!input.sourceDir) throw new Error("sourceDir is required for temp_copy diff capture");
  const changedFiles = await changedAllowedFiles(input.sourceDir, input.workspacePath, input.allowedFiles);
  return { patch: await buildSimplePatch(input.sourceDir, input.workspacePath, changedFiles), changedFiles };
}

async function changedAllowedFiles(sourceDir: string, workspacePath: string, allowedFiles: string[]): Promise<string[]> {
  const files = new Set([...(await listFiles(sourceDir)), ...(await listFiles(workspacePath))]);
  const changed: string[] = [];
  for (const file of [...files].sort()) {
    if (!matchesAnyGlob(file, allowedFiles)) continue;
    const beforePath = join(sourceDir, file);
    const afterPath = join(workspacePath, file);
    const [beforeExists, afterExists] = await Promise.all([fileExists(beforePath), fileExists(afterPath)]);
    if (!afterExists) continue;
    if (!beforeExists || (await readFile(beforePath, "utf8")) !== (await readFile(afterPath, "utf8"))) changed.push(file);
  }
  return changed;
}

async function listFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(rootDir, rootDir, out);
  return out;
}

async function walk(rootDir: string, dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", ".agent-os", "node_modules", "dist"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(rootDir, path, out);
    else if (entry.isFile()) out.push(relative(rootDir, path).replaceAll("\\", "/"));
  }
}
