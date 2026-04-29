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
  usedBytes?: number;
  budgetBytes?: number;
}

export interface ContextFileMetadata {
  path: string;
  bytes: number;
  included: boolean;
  reason?: "selected" | "max_files" | "byte_budget";
}

export async function compileContext(paths: RuntimePaths, task: Task): Promise<ContextBundle> {
  const contextDir = join(taskDir(paths, task.id), "context");
  await mkdir(contextDir, { recursive: true });
  const repoFiles = await listRepoFiles(paths.rootDir);
  const selection = await selectContextFiles(paths.rootDir, repoFiles.filter((file) => matchesAnyGlob(file, task.allowedFiles)));
  const bundle = [
    "# Agent OS Worker Bundle",
    "",
    `Task: ${task.goal}`,
    `Risk: ${task.risk}`,
    `Allowed files: ${task.allowedFiles.join(", ")}`,
    "",
    "## Repository Context",
    ...selection.renderedFiles,
    "",
    "## Required Output",
    "Return structured JSON with status, summary, and changedFiles. Do not edit outside allowed files.",
    "",
  ].join("\n");
  const bundlePath = join(contextDir, "bundle.md");
  const filesPath = join(contextDir, "files.json");
  await writeFile(bundlePath, bundle, "utf8");
  await writeFile(filesPath, `${JSON.stringify({
    selectedFiles: selection.selectedFiles,
    files: selection.files,
    usedBytes: selection.usedBytes,
    budgetBytes: selection.budgetBytes,
    maxFiles: selection.maxFiles,
    skippedFiles: selection.files.filter((file) => !file.included).length,
  }, null, 2)}\n`, "utf8");
  await writeFile(join(contextDir, "repo-map.json"), `${JSON.stringify({ files: repoFiles }, null, 2)}\n`, "utf8");
  return { bundlePath, filesPath, selectedFiles: selection.selectedFiles, usedBytes: selection.usedBytes, budgetBytes: selection.budgetBytes };
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
  const candidates = repoFiles
    .filter((file) => (file === ".env" ? input.includeEnv === true : true))
    .filter((file) => matchesAnyGlob(file, input.task.allowedFiles));
  const selection = await selectContextFiles(input.repoRoot, candidates);
  const bundlePath = join(contextDir, "bundle.md");
  const filesPath = join(contextDir, "files.json");
  await writeFile(bundlePath, [
    "# Agent OS Worker Bundle",
    "",
    `Task: ${input.task.goal}`,
    `Risk: ${input.task.risk}`,
    "",
    ...selection.renderedFiles,
    "",
  ].join("\n"), "utf8");
  await writeFile(filesPath, `${JSON.stringify({
    selectedFiles: selection.selectedFiles,
    files: selection.files,
    usedBytes: selection.usedBytes,
    budgetBytes: selection.budgetBytes,
    maxFiles: selection.maxFiles,
    skippedFiles: selection.files.filter((file) => !file.included).length,
  }, null, 2)}\n`, "utf8");
  return { bundlePath, filesPath, selectedFiles: selection.selectedFiles, usedBytes: selection.usedBytes, budgetBytes: selection.budgetBytes };
}

interface ContextSelection {
  selectedFiles: string[];
  renderedFiles: string[];
  files: ContextFileMetadata[];
  usedBytes: number;
  budgetBytes: number;
  maxFiles: number;
}

async function selectContextFiles(rootDir: string, candidates: string[]): Promise<ContextSelection> {
  const maxFiles = contextMaxFiles();
  const budgetBytes = contextMaxBytes();
  const selectedFiles: string[] = [];
  const renderedFiles: string[] = [];
  const files: ContextFileMetadata[] = [];
  let usedBytes = 0;

  for (const file of candidates) {
    if (selectedFiles.length >= maxFiles) {
      files.push({ path: file, bytes: 0, included: false, reason: "max_files" });
      continue;
    }
    const content = redactSecrets(await readFile(join(rootDir, file), "utf8"));
    const rendered = wrapProjectFile(file, content);
    const bytes = Buffer.byteLength(rendered, "utf8");
    if (usedBytes + bytes > budgetBytes && selectedFiles.length > 0) {
      files.push({ path: file, bytes, included: false, reason: "byte_budget" });
      continue;
    }
    selectedFiles.push(file);
    renderedFiles.push(rendered);
    usedBytes += bytes;
    files.push({ path: file, bytes, included: true, reason: "selected" });
  }

  return { selectedFiles, renderedFiles, files, usedBytes, budgetBytes, maxFiles };
}

function contextMaxFiles(): number {
  return positiveInteger(process.env.AGENT_OS_CONTEXT_MAX_FILES, 20);
}

function contextMaxBytes(): number {
  return positiveInteger(process.env.AGENT_OS_CONTEXT_MAX_BYTES, 192 * 1024);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
