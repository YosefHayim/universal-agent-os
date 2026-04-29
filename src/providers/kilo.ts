import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";
import type { LaunchCommand, ModelCatalogEntry, ProviderCapabilities, ProviderContext, ProviderDetection, ProviderResult, ProviderStatus, Task } from "../core/types.js";
import { kiloSource } from "../models/sources/kilo.js";
import { limitFromText, type ModelSelection, type ProviderAdapter } from "./adapter.js";

export const kiloProvider: ProviderAdapter = {
  id: "kilo",
  async detect(_ctx: ProviderContext): Promise<ProviderDetection> {
    const result = spawnSync("kilo", ["--version"], { encoding: "utf8", timeout: 5_000 });
    return { available: result.status === 0, detail: result.status === 0 ? `kilo ${result.stdout.trim()}` : "kilo binary unavailable" };
  },
  async status(ctx: ProviderContext): Promise<ProviderStatus> {
    const detection = await this.detect(ctx);
    return {
      provider: "kilo",
      availability: detection.available ? "available" : "unavailable",
      detail: detection.available ? `${detection.detail}; provider credentials are managed by kilo` : detection.detail,
      checkedAt: new Date().toISOString(),
    };
  },
  async capabilities(): Promise<ProviderCapabilities> {
    return { provider: "kilo", canLaunch: true, structuredOutput: true, worktree: true, cloudHosted: true };
  },
  async discoverModels(): Promise<ModelCatalogEntry[]> {
    return (await kiloSource.discover()).entries;
  },
  async buildLaunchCommand(_ctx: ProviderContext, task: Task, bundlePath: string, model?: string | ModelSelection): Promise<LaunchCommand> {
    const modelId = typeof model === "string" ? model : model?.modelId;
    return {
      command: "kilo",
      args: [
        "run",
        "--format",
        "json",
        "--dir",
        dirname(bundlePath),
        "--auto",
        ...(modelId ? ["--model", modelId] : []),
        providerPrompt(task, bundlePath),
      ],
    };
  },
  async parseOutput(_ctx: ProviderContext, stdout: string, stderr: string): Promise<ProviderResult> {
    const parsed = parseJsonOutput(stdout);
    if (parsed.status) return { status: parsed.status, summary: parsed.summary, changedFiles: [] };
    return { status: stdout.trim() ? "completed" : "failed", summary: (parsed.summary || stdout.trim() || stderr.trim()).slice(0, 500), changedFiles: [] };
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

function parseJsonOutput(stdout: string): { status?: "completed" | "failed"; summary: string } {
  let summary = "";
  let completed = false;
  let failed = false;
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value.startsWith("{")) continue;
    try {
      const event = JSON.parse(value) as {
        type?: string;
        role?: string;
        content?: string | Array<{ type?: string; text?: string }>;
        item?: { type?: string; text?: string };
        part?: { type?: string; text?: string };
        result?: string;
        status?: string;
        error?: { name?: string; data?: { message?: string } };
      };
      if (event.error || event.type === "error") {
        failed = true;
        summary = event.error?.data?.message ?? event.error?.name ?? value;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        summary = event.item.text;
      }
      if (event.type === "text" && event.part?.type === "text" && event.part.text) {
        summary = event.part.text;
      }
      const messageText = contentText(event.content);
      if (event.type === "message" && event.role === "assistant" && messageText) {
        summary = event.status === "success" ? messageText : `${summary}${messageText}`;
      }
      if (event.type === "result") {
        if (event.result) summary = event.result;
        completed = /^(success|completed)$/i.test(String(event.status ?? "success"));
        failed ||= /^(error|failed|failure)$/i.test(String(event.status ?? ""));
      }
    } catch {
      continue;
    }
  }
  if (failed) return { status: "failed", summary: summary || "kilo failed" };
  if (completed || summary) return { status: "completed", summary: summary || "kilo completed" };
  return { summary };
}

function contentText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.type === "text" ? part.text ?? "" : "").filter(Boolean).join("\n");
}
