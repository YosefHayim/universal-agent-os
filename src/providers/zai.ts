import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { LaunchCommand, ModelCatalogEntry, ProviderCapabilities, ProviderContext, ProviderDetection, ProviderResult, ProviderStatus, Task } from "../core/types.js";
import { zaiSource } from "../models/sources/zai.js";
import { limitFromText, type ProviderAdapter } from "./adapter.js";

export const zaiProvider: ProviderAdapter = {
  id: "zai",
  async detect(): Promise<ProviderDetection> {
    const result = spawnSync("claude-zai", ["--version"], { encoding: "utf8" });
    return { available: result.status === 0, detail: result.status === 0 ? `claude-zai wrapper: ${result.stdout.trim()}` : "claude-zai wrapper unavailable" };
  },
  async status(): Promise<ProviderStatus> {
    const detection = await this.detect({} as ProviderContext);
    return {
      provider: "zai",
      availability: detection.available ? "available" : "unavailable",
      detail: detection.available ? `${detection.detail}; account limits require a launch smoke` : detection.detail,
      checkedAt: new Date().toISOString(),
    };
  },
  async capabilities(): Promise<ProviderCapabilities> {
    return { provider: "zai", canLaunch: true, structuredOutput: true, worktree: true, cloudHosted: true };
  },
  async discoverModels(): Promise<ModelCatalogEntry[]> {
    return (await zaiSource.discover()).entries;
  },
  async buildLaunchCommand(_ctx: ProviderContext, task: Task, bundlePath: string, modelId?: string): Promise<LaunchCommand> {
    return {
      command: "claude-zai",
      args: [
        "--output-format",
        "stream-json",
        "--permission-mode",
        "bypassPermissions",
        "--no-session-persistence",
        ...(modelId ? ["--model", modelId] : []),
        "-p",
        providerPrompt(task, bundlePath),
      ],
    };
  },
  async parseOutput(_ctx: ProviderContext, stdout: string, stderr: string): Promise<ProviderResult> {
    const parsed = parseClaudeStream(stdout);
    if (parsed.status) return { status: parsed.status, summary: parsed.summary, changedFiles: [] };
    return { status: stdout.trim() ? "completed" : "failed", summary: (stdout.trim() || stderr.trim()).slice(0, 500), changedFiles: [] };
  },
  async isLimitReached(_ctx, _exitCode, stdout, stderr) {
    return limitFromText(stdout, stderr);
  },
  async supportsWorktree() {
    return true;
  },
  async supportsStructuredOutput() {
    return true;
  },
};

function providerPrompt(task: Task, bundlePath: string): string {
  return [
    `Read the Agent OS bundle at ${basename(bundlePath)}.`,
    `Task goal: ${task.goal}`,
    `Allowed files: ${task.allowedFiles.join(", ")}`,
    "Execute the requested task inside this isolated workspace.",
    "If the task requires creating or editing files, actually create or edit those files before your final response.",
    "Follow the task goal literally; when exact file content is requested, preserve every requested word.",
    "Only change files allowed by the bundle scope.",
    "Do not ask for confirmation.",
    "Do not stop after summarizing the task.",
    "If you do not produce a file diff for an edit task, the run will fail validation.",
    "Return concise JSON with status, summary, and changedFiles.",
  ].join(" ");
}

function parseClaudeStream(stdout: string): { status?: "completed" | "failed"; summary: string } {
  let summary = "";
  let failed = false;
  let completed = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        result?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
        error?: { message?: string };
      };
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        const text = event.message.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("").trim();
        if (text) summary = text;
      }
      if (event.type === "result") {
        completed = event.subtype === "success";
        failed = event.subtype !== undefined && event.subtype !== "success";
        if (event.result) summary = event.result;
      }
      if (event.type === "error") {
        failed = true;
        summary = event.error?.message ?? summary;
      }
    } catch {
      continue;
    }
  }
  if (completed) return { status: "completed", summary: summary || "zai completed" };
  if (failed) return { status: "failed", summary: summary || "zai failed" };
  return { summary };
}
