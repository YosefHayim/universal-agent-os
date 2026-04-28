import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";
import type { LaunchCommand, ModelCatalogEntry, ProviderCapabilities, ProviderContext, ProviderDetection, ProviderResult, ProviderStatus, Task } from "../core/types.js";
import { opencodeSource, parseOpencodeModelIds } from "../models/sources/opencode.js";
import { limitFromText, type ProviderAdapter } from "./adapter.js";

export const opencodeProvider: ProviderAdapter = {
  id: "opencode",
  async detect(): Promise<ProviderDetection> {
    const result = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5_000 });
    return { available: result.status === 0, detail: result.status === 0 ? `opencode ${result.stdout.trim()}` : "opencode binary unavailable" };
  },
  async status(): Promise<ProviderStatus> {
    const detection = await this.detect({} as ProviderContext);
    return {
      provider: "opencode",
      availability: detection.available ? "available" : "unavailable",
      detail: detection.available ? `${detection.detail}; provider credentials are managed by opencode` : detection.detail,
      checkedAt: new Date().toISOString(),
    };
  },
  async capabilities(): Promise<ProviderCapabilities> {
    return { provider: "opencode", canLaunch: true, structuredOutput: true, worktree: true, cloudHosted: true };
  },
  async discoverModels(): Promise<ModelCatalogEntry[]> {
    return (await opencodeSource.discover()).entries;
  },
  async buildLaunchCommand(_ctx: ProviderContext, task: Task, bundlePath: string, modelId?: string): Promise<LaunchCommand> {
    const selectedModel = modelId ?? discoverDefaultOpencodeModel();
    return {
      command: "opencode",
      args: [
        "run",
        "--format",
        "json",
        "--dir",
        dirname(bundlePath),
        ...(selectedModel ? ["--model", selectedModel] : []),
        providerPrompt(task, bundlePath),
      ],
    };
  },
  async parseOutput(_ctx: ProviderContext, stdout: string, stderr: string): Promise<ProviderResult> {
    const error = opencodeError(stdout) ?? stderr.trim();
    return { status: error ? "failed" : "completed", summary: (error || stdout.trim()).slice(0, 500), changedFiles: [] };
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

export function selectOpencodeDefaultModel(ids: string[]): string | undefined {
  return ids
    .map((id) => ({ id, score: scoreOpencodeModel(id) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0]?.id;
}

function discoverDefaultOpencodeModel(): string | undefined {
  const result = spawnSync("opencode", ["models"], { encoding: "utf8", timeout: 20_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) return undefined;
  return selectOpencodeDefaultModel(parseOpencodeModelIds(result.stdout));
}

function scoreOpencodeModel(id: string): number {
  const lower = id.toLowerCase();
  if (/image|audio|speech|tts|whisper|embed|rerank|guard|moderation|vision|vl\b/.test(lower)) return 0;
  let score = 0;
  if (lower.startsWith("github-copilot/")) score += 140;
  else if (lower.startsWith("anthropic/")) score += 100;
  else if (lower.startsWith("opencode/")) score += 80;
  else if (lower.startsWith("openrouter/")) score += 70;
  else if (lower.startsWith("zai-coding-plan/")) score += 60;
  else if (lower.startsWith("ollama-cloud/")) score += 50;
  if (lower.startsWith("github-copilot/grok-code-fast")) score += 120;
  if (lower === "github-copilot/gpt-5-mini") score += 100;
  if (lower.startsWith("github-copilot/claude-") || lower.startsWith("github-copilot/gemini-")) score -= 80;
  if (/^github-copilot\/gpt-5(\.|$)/.test(lower) && !lower.endsWith("gpt-5-mini")) score -= 80;
  if (/sonnet/.test(lower)) score += 60;
  if (/codex|coder|coding|gpt-5|qwen3.*coder|deepseek-v[0-9]|glm-[45]|kimi-k2|codestral|devstral|grok-code/.test(lower)) score += 50;
  if (/opus/.test(lower)) score += 30;
  if (/nano|haiku|flash|lite/.test(lower)) score -= 10;
  if (/free/.test(lower)) score += 5;
  return score;
}

function opencodeError(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    try {
      const event = JSON.parse(value) as { type?: string; error?: { name?: string; data?: { message?: string } } };
      if (event.type === "error" || event.error) return event.error?.data?.message ?? event.error?.name ?? value;
    } catch {
      continue;
    }
  }
  return undefined;
}
