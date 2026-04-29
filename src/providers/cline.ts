import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import type { LaunchCommand, ModelCatalogEntry, ProviderCapabilities, ProviderContext, ProviderDetection, ProviderResult, ProviderStatus, Task } from "../core/types.js";
import { clineSource } from "../models/sources/cline.js";
import { limitFromText, type ModelSelection, type ProviderAdapter } from "./adapter.js";
import { parseDirectCliJsonOutput } from "./direct-cli-output.js";
import { buildWorkerPrompt } from "./worker-prompt.js";

export const clineProvider: ProviderAdapter = {
  id: "cline",
  async detect(_ctx: ProviderContext): Promise<ProviderDetection> {
    const result = spawnSync("cline", ["--version"], { encoding: "utf8", timeout: 5_000 });
    return { available: result.status === 0, detail: result.status === 0 ? `cline ${result.stdout.trim()}` : "cline binary unavailable" };
  },
  async status(ctx: ProviderContext): Promise<ProviderStatus> {
    const detection = await this.detect(ctx);
    return {
      provider: "cline",
      availability: detection.available ? "available" : "unavailable",
      detail: detection.available ? `${detection.detail}; account health is verified by launch smoke` : detection.detail,
      checkedAt: new Date().toISOString(),
    };
  },
  async capabilities(): Promise<ProviderCapabilities> {
    return { provider: "cline", canLaunch: true, structuredOutput: true, worktree: true, cloudHosted: true };
  },
  async discoverModels(): Promise<ModelCatalogEntry[]> {
    return (await clineSource.discover()).entries;
  },
  async buildLaunchCommand(_ctx: ProviderContext, task: Task, bundlePath: string, model?: string | ModelSelection): Promise<LaunchCommand> {
    const modelId = typeof model === "string" ? model : model?.modelId;
    return {
      command: "cline",
      args: [
        "task",
        "--act",
        "--yolo",
        "--json",
        "--cwd",
        dirname(bundlePath),
        ...(modelId ? ["--model", modelId] : []),
        buildWorkerPrompt(task, bundlePath, { provider: "cline", weakModel: true }),
      ],
    };
  },
  async parseOutput(_ctx: ProviderContext, stdout: string, stderr: string): Promise<ProviderResult> {
    const parsed = parseDirectCliJsonOutput(stdout, "cline");
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
