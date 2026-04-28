import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LaunchCommand, ModelCatalogEntry, ProviderCapabilities, ProviderContext, ProviderDetection, ProviderResult, ProviderStatus, Task } from "../core/types.js";
import { codexSource } from "../models/sources/codex.js";
import { limitFromText, type ProviderAdapter } from "./adapter.js";

export const codexProvider: ProviderAdapter = {
  id: "codex",
  async detect(): Promise<ProviderDetection> {
    const result = spawnSync("codex", ["--version"], { encoding: "utf8" });
    return { available: result.status === 0, detail: result.status === 0 ? result.stdout.trim() : "codex binary unavailable" };
  },
  async status(): Promise<ProviderStatus> {
    const detection = await this.detect({} as ProviderContext);
    return { provider: "codex", availability: detection.available ? "available" : "unavailable", detail: detection.detail, checkedAt: new Date().toISOString() };
  },
  async capabilities(): Promise<ProviderCapabilities> {
    return { provider: "codex", canLaunch: true, structuredOutput: true, worktree: true, cloudHosted: true };
  },
  async discoverModels(): Promise<ModelCatalogEntry[]> {
    return (await codexSource.discover()).entries;
  },
  async buildLaunchCommand(_ctx: ProviderContext, _task: Task, bundlePath: string, modelId?: string): Promise<LaunchCommand> {
    const codexHome = await createIsolatedCodexHome(bundlePath);
    return {
      command: "codex",
      args: [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-s",
        "workspace-write",
        ...(modelId ? ["-m", modelId] : []),
        "--json",
        providerPrompt(_task, bundlePath),
      ],
      env: { CODEX_HOME: codexHome },
    };
  },
  async parseOutput(_ctx: ProviderContext, stdout: string, stderr: string): Promise<ProviderResult> {
    const finalMessage = finalCodexAgentMessage(stdout);
    if (finalMessage && /"status"\s*:\s*"(success|completed)"/i.test(finalMessage)) {
      return { status: "completed", summary: finalMessage.slice(0, 500), changedFiles: [] };
    }
    return { status: stderr && !finalMessage ? "failed" : "completed", summary: (finalMessage || stdout.trim()).slice(0, 500), changedFiles: [] };
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
    "Do not stop after summarizing the task.",
    "If you do not produce a file diff for an edit task, the run will fail validation.",
    "Return concise JSON with status, summary, and changedFiles.",
  ].join(" ");
}

async function createIsolatedCodexHome(bundlePath: string): Promise<string> {
  const codexHome = join(dirname(bundlePath), ".agent-os-codex-home");
  await mkdir(codexHome, { recursive: true });
  const sourceHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  for (const file of ["auth.json", "version.json", "installation_id"]) {
    try {
      await copyFile(join(sourceHome, file), join(codexHome, file));
    } catch {
      // Auth is enough for normal runs; missing optional files should not block launch preview.
    }
  }
  return codexHome;
}

function finalCodexAgentMessage(stdout: string): string {
  let finalText = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        finalText = event.item.text;
      }
    } catch {
      continue;
    }
  }
  return finalText;
}
