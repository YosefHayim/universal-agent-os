import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimePaths, Task } from "../core/types.js";
import { taskDir } from "../core/lifecycle.js";
import { listRepoFiles } from "./repo-index.js";
import { redactSecrets } from "./redaction.js";
import { wrapProjectFile } from "./prompt-injection-guards.js";
import { matchesAnyGlob } from "../validators/scope-check.js";

export interface ContextBundle {
  bundlePath: string;
  filesPath: string;
  selectedFiles: string[];
}

export async function compileContext(paths: RuntimePaths, task: Task): Promise<ContextBundle> {
  const contextDir = join(taskDir(paths, task.id), "context");
  await mkdir(contextDir, { recursive: true });
  const repoFiles = await listRepoFiles(paths.rootDir);
  const selectedFiles = repoFiles.filter((file) => matchesAnyGlob(file, task.allowedFiles)).slice(0, 20);
  const renderedFiles = await Promise.all(selectedFiles.map(async (file) => {
    const content = redactSecrets(await readFile(join(paths.rootDir, file), "utf8"));
    return wrapProjectFile(file, content);
  }));
  const bundle = [
    "# Agent OS Worker Bundle",
    "",
    `Task: ${task.goal}`,
    `Risk: ${task.risk}`,
    `Allowed files: ${task.allowedFiles.join(", ")}`,
    "",
    "## Repository Context",
    ...renderedFiles,
    "",
    "## Required Output",
    "Return structured JSON with status, summary, and changedFiles. Do not edit outside allowed files.",
    "",
  ].join("\n");
  const bundlePath = join(contextDir, "bundle.md");
  const filesPath = join(contextDir, "files.json");
  await writeFile(bundlePath, bundle, "utf8");
  await writeFile(filesPath, `${JSON.stringify({ selectedFiles }, null, 2)}\n`, "utf8");
  await writeFile(join(contextDir, "repo-map.json"), `${JSON.stringify({ files: repoFiles }, null, 2)}\n`, "utf8");
  return { bundlePath, filesPath, selectedFiles };
}

export async function compileContextBundle(input: {
  repoRoot: string;
  outputDir: string;
  task: Task;
  includeEnv?: boolean;
}): Promise<ContextBundle> {
  const contextDir = join(input.outputDir, "context");
  await mkdir(contextDir, { recursive: true });
  const repoFiles = await listRepoFiles(input.repoRoot);
  const selectedFiles = repoFiles
    .filter((file) => (file === ".env" ? input.includeEnv === true : true))
    .filter((file) => matchesAnyGlob(file, input.task.allowedFiles))
    .slice(0, 20);
  const renderedFiles = await Promise.all(selectedFiles.map(async (file) => {
    const content = redactSecrets(await readFile(join(input.repoRoot, file), "utf8"));
    return wrapProjectFile(file, content);
  }));
  const bundlePath = join(contextDir, "bundle.md");
  const filesPath = join(contextDir, "files.json");
  await writeFile(bundlePath, [
    "# Agent OS Worker Bundle",
    "",
    `Task: ${input.task.goal}`,
    `Risk: ${input.task.risk}`,
    "",
    ...renderedFiles,
    "",
  ].join("\n"), "utf8");
  await writeFile(filesPath, `${JSON.stringify({ selectedFiles }, null, 2)}\n`, "utf8");
  return { bundlePath, filesPath, selectedFiles };
}
