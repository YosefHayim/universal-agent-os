import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { LaunchCommand, ModelCatalogEntry, ProviderCapabilities, ProviderContext, ProviderDetection, ProviderResult, ProviderStatus, Task } from "../core/types.js";
import { geminiSource } from "../models/sources/gemini.js";
import { limitFromText, type ProviderAdapter } from "./adapter.js";

export const geminiProvider: ProviderAdapter = {
  id: "gemini",
  async detect(): Promise<ProviderDetection> {
    const result = spawnSync("gemini", ["--version"], { encoding: "utf8", timeout: 5_000 });
    return { available: result.status === 0, detail: result.status === 0 ? `gemini ${result.stdout.trim()}` : "gemini binary unavailable" };
  },
  async status(): Promise<ProviderStatus> {
    const detection = await this.detect({} as ProviderContext);
    return {
      provider: "gemini",
      availability: detection.available ? "available" : "unavailable",
      detail: detection.available ? `${detection.detail}; account health is verified by launch smoke` : detection.detail,
      checkedAt: new Date().toISOString(),
    };
  },
  async capabilities(): Promise<ProviderCapabilities> {
    return { provider: "gemini", canLaunch: true, structuredOutput: true, worktree: true, cloudHosted: true };
  },
  async discoverModels(): Promise<ModelCatalogEntry[]> {
    return (await geminiSource.discover()).entries;
  },
  async buildLaunchCommand(_ctx: ProviderContext, task: Task, bundlePath: string, modelId?: string): Promise<LaunchCommand> {
    return {
      command: "gemini",
      args: [
        "--approval-mode",
        "yolo",
        "--output-format",
        "stream-json",
        ...(modelId ? ["--model", modelId] : []),
        "--prompt",
        providerPrompt(task, bundlePath),
      ],
    };
  },
  async parseOutput(_ctx: ProviderContext, stdout: string, stderr: string): Promise<ProviderResult> {
    const parsed = parseStreamResult(stdout);
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

function parseStreamResult(stdout: string): { status?: "completed" | "failed"; summary: string } {
  let finalText = "";
  let resultStatus = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { type?: string; role?: string; content?: string; delta?: boolean; status?: string; error?: unknown };
      if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
        finalText = event.delta ? `${finalText}${event.content}` : event.content;
      }
      if (event.type === "result") {
        resultStatus = String(event.status ?? "");
      }
    } catch {
      continue;
    }
  }
  if (resultStatus === "success") return { status: "completed", summary: finalText || "gemini completed" };
  if (resultStatus === "error" || resultStatus === "failed") return { status: "failed", summary: finalText || "gemini failed" };
  return { summary: finalText };
}
