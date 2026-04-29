import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { RuntimePaths, Task } from "../core/types.js";
import { taskDir } from "../core/lifecycle.js";
import { fileSummaryCachePath } from "./cache-layout.js";
import { FileSummaryCache } from "./file-summary-cache.js";
import { listRepoFiles } from "./repo-index.js";
import { redactSecrets } from "./redaction.js";
import { wrapProjectFile } from "./prompt-injection-guards.js";
import { matchesAnyGlob } from "../validators/scope-check.js";

export interface ContextBundle {
  bundlePath: string;
  filesPath: string;
  selectedFiles: string[];
  summarizedFiles?: string[];
  usedBytes?: number;
  budgetBytes?: number;
  estimatedSavedBytes?: number;
}

export interface ContextFileMetadata {
  path: string;
  bytes: number;
  included: boolean;
  mode: "full" | "summary" | "skipped";
  score: number;
  reason?: "selected" | "summary" | "max_files" | "byte_budget";
  summary?: string;
}

export async function compileContext(paths: RuntimePaths, task: Task): Promise<ContextBundle> {
  const contextDir = join(taskDir(paths, task.id), "context");
  await mkdir(contextDir, { recursive: true });
  const repoFiles = await listRepoFiles(paths.rootDir);
  const summaryCache = await FileSummaryCache.load(fileSummaryCachePath(paths));
  const selection = await selectContextFiles(paths.rootDir, repoFiles.filter((file) => matchesAnyGlob(file, task.allowedFiles)), task, summaryCache);
  const bundle = [
    "# Agent OS Worker Bundle",
    "",
    `Task: ${task.goal}`,
    `Risk: ${task.risk}`,
    `Allowed files: ${task.allowedFiles.join(", ")}`,
    "",
    "## Repository Context",
    ...selection.renderedFiles,
    ...(selection.summaryFiles.length ? ["", "## Repository File Summaries", ...selection.summaryFiles] : []),
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
    summarizedFiles: selection.summarizedFiles,
    files: selection.files,
    usedBytes: selection.usedBytes,
    budgetBytes: selection.budgetBytes,
    maxFiles: selection.maxFiles,
    skippedFiles: selection.files.filter((file) => file.mode === "skipped").length,
    estimatedSavedBytes: selection.estimatedSavedBytes,
  }, null, 2)}\n`, "utf8");
  await writeFile(join(contextDir, "repo-map.json"), `${JSON.stringify({ files: repoFiles }, null, 2)}\n`, "utf8");
  await summaryCache.save(fileSummaryCachePath(paths));
  return {
    bundlePath,
    filesPath,
    selectedFiles: selection.selectedFiles,
    summarizedFiles: selection.summarizedFiles,
    usedBytes: selection.usedBytes,
    budgetBytes: selection.budgetBytes,
    estimatedSavedBytes: selection.estimatedSavedBytes,
  };
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
  const selection = await selectContextFiles(input.repoRoot, candidates, input.task, new FileSummaryCache());
  const bundlePath = join(contextDir, "bundle.md");
  const filesPath = join(contextDir, "files.json");
  await writeFile(bundlePath, [
    "# Agent OS Worker Bundle",
    "",
    `Task: ${input.task.goal}`,
    `Risk: ${input.task.risk}`,
    "",
    ...selection.renderedFiles,
    ...(selection.summaryFiles.length ? ["", "## Repository File Summaries", ...selection.summaryFiles] : []),
    "",
  ].join("\n"), "utf8");
  await writeFile(filesPath, `${JSON.stringify({
    selectedFiles: selection.selectedFiles,
    summarizedFiles: selection.summarizedFiles,
    files: selection.files,
    usedBytes: selection.usedBytes,
    budgetBytes: selection.budgetBytes,
    maxFiles: selection.maxFiles,
    skippedFiles: selection.files.filter((file) => file.mode === "skipped").length,
    estimatedSavedBytes: selection.estimatedSavedBytes,
  }, null, 2)}\n`, "utf8");
  return {
    bundlePath,
    filesPath,
    selectedFiles: selection.selectedFiles,
    summarizedFiles: selection.summarizedFiles,
    usedBytes: selection.usedBytes,
    budgetBytes: selection.budgetBytes,
    estimatedSavedBytes: selection.estimatedSavedBytes,
  };
}

interface ContextSelection {
  selectedFiles: string[];
  summarizedFiles: string[];
  renderedFiles: string[];
  summaryFiles: string[];
  files: ContextFileMetadata[];
  usedBytes: number;
  budgetBytes: number;
  maxFiles: number;
  estimatedSavedBytes: number;
}

interface RankedContextFile {
  path: string;
  rendered: string;
  summary: string;
  renderedBytes: number;
  score: number;
}

async function selectContextFiles(rootDir: string, candidates: string[], task: Task, summaryCache: FileSummaryCache): Promise<ContextSelection> {
  const maxFiles = contextMaxFiles();
  const budgetBytes = contextMaxBytes();
  const maxSummaries = contextMaxSummaries();
  const ranked = (await Promise.all(candidates.map((file) => rankContextFile(rootDir, file, task, summaryCache))))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const selectedFiles: string[] = [];
  const summarizedFiles: string[] = [];
  const renderedFiles: string[] = [];
  const summaryFiles: string[] = [];
  const files: ContextFileMetadata[] = [];
  let usedBytes = 0;
  let fullCandidatesBytes = 0;

  for (const file of ranked) {
    fullCandidatesBytes += file.renderedBytes;
    if (selectedFiles.length < maxFiles && usedBytes + file.renderedBytes <= budgetBytes) {
      selectedFiles.push(file.path);
      renderedFiles.push(file.rendered);
      usedBytes += file.renderedBytes;
      files.push({ path: file.path, bytes: file.renderedBytes, included: true, mode: "full", score: file.score, reason: "selected" });
      continue;
    }

    const summary = wrapSummaryFile(file.path, file.summary);
    const summaryBytes = Buffer.byteLength(summary, "utf8");
    if (summarizedFiles.length < maxSummaries && usedBytes + summaryBytes <= budgetBytes) {
      summarizedFiles.push(file.path);
      summaryFiles.push(summary);
      usedBytes += summaryBytes;
      files.push({
        path: file.path,
        bytes: file.renderedBytes,
        included: true,
        mode: "summary",
        score: file.score,
        reason: "summary",
        summary: file.summary,
      });
      continue;
    }
    files.push({
      path: file.path,
      bytes: file.renderedBytes,
      included: false,
      mode: "skipped",
      score: file.score,
      reason: selectedFiles.length >= maxFiles ? "max_files" : "byte_budget",
    });
  }

  return {
    selectedFiles,
    summarizedFiles,
    renderedFiles,
    summaryFiles,
    files,
    usedBytes,
    budgetBytes,
    maxFiles,
    estimatedSavedBytes: Math.max(0, fullCandidatesBytes - usedBytes),
  };
}

async function rankContextFile(rootDir: string, file: string, task: Task, summaryCache: FileSummaryCache): Promise<RankedContextFile> {
  const content = redactSecrets(await readFile(join(rootDir, file), "utf8"));
  const rendered = wrapProjectFile(file, content);
  const renderedBytes = Buffer.byteLength(rendered, "utf8");
  const info = await stat(join(rootDir, file));
  const hash = createHash("sha256").update(content).digest("hex");
  const cached = summaryCache.get(file);
  const summary = cached?.hash === hash ? cached.summary : summarizeFileContent(content);
  summaryCache.set(file, summary, renderedBytes, hash);
  return {
    path: file,
    rendered,
    summary,
    renderedBytes,
    score: scoreFile(file, content, info.mtimeMs, renderedBytes, task),
  };
}

function scoreFile(path: string, content: string, mtimeMs: number, bytes: number, task: Task): number {
  const tokens = taskKeywords(task);
  const searchablePath = path.toLowerCase();
  const searchableContent = content.toLowerCase();
  let score = 0;
  if (["README.md", "package.json", "plan.md"].includes(path)) score += 8;
  if ([".ts", ".tsx", ".js", ".jsx", ".json", ".md"].includes(extname(path))) score += 2;
  for (const token of tokens) {
    if (searchablePath.includes(token)) score += 12;
    if (basename(searchablePath).includes(token)) score += 8;
    if (searchableContent.includes(token)) score += 4;
  }
  score += Math.max(0, 6 - bytes / 8192);
  score += Math.max(0, Math.min(4, (Date.now() - mtimeMs) / 86_400_000 < 7 ? 4 : 0));
  return Number(score.toFixed(3));
}

function taskKeywords(task: Task): string[] {
  const stopWords = new Set(["agent", "agents", "file", "files", "task", "change", "create", "update", "add", "fix", "the", "and", "for", "with", "that", "this", "from", "into", "only"]);
  return [...new Set([
    ...task.goal.toLowerCase().split(/[^a-z0-9_-]+/),
    ...task.allowedFiles.flatMap((glob) => glob.toLowerCase().split(/[^a-z0-9_-]+/)),
  ].filter((token) => token.length >= 3 && !stopWords.has(token)))].slice(0, 20);
}

function summarizeFileContent(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const imports = lines.filter((line) => /^(import|export|class|interface|type|function|const)\b/.test(line)).slice(0, 6);
  const sample = imports.length ? imports : lines.slice(0, 6);
  return sample.join(" ").slice(0, 700);
}

function wrapSummaryFile(path: string, summary: string): string {
  return [
    `<project-file-summary path="${escapeAttribute(path)}">`,
    summary,
    "</project-file-summary>",
  ].join("\n");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function contextMaxFiles(): number {
  return positiveInteger(process.env.AGENT_OS_CONTEXT_MAX_FILES, 20);
}

function contextMaxBytes(): number {
  return positiveInteger(process.env.AGENT_OS_CONTEXT_MAX_BYTES, 192 * 1024);
}

function contextMaxSummaries(): number {
  return positiveInteger(process.env.AGENT_OS_CONTEXT_MAX_SUMMARIES, 20);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
