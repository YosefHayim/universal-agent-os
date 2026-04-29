import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_PROVIDERS } from "../src/config/defaults.js";
import { loadAgentOsConfig, providerCredentialsPath, setProviderStatusOverride } from "../src/config/config-loader.js";
import { Controller } from "../src/core/controller.js";
import type { ProviderContext, Task } from "../src/core/types.js";
import { claudeProvider } from "../src/providers/claude.js";
import { clineProvider } from "../src/providers/cline.js";
import { codexProvider } from "../src/providers/codex.js";
import { geminiProvider } from "../src/providers/gemini.js";
import { kiloProvider } from "../src/providers/kilo.js";
import { manualProvider } from "../src/providers/manual.js";
import { opencodeProvider, selectOpencodeDefaultModel } from "../src/providers/opencode.js";
import { cloudCatalogProvider } from "../src/providers/provider-factory.js";
import { buildWorkerPrompt } from "../src/providers/worker-prompt.js";
import { zaiProvider } from "../src/providers/zai.js";
import { mapClineConfigModels, parseClineConfigModelIds } from "../src/models/sources/cline.js";
import { mapKiloModels, parseKiloModelIds } from "../src/models/sources/kilo.js";
import { writeModelCache } from "../src/models/cache.js";
import { catalogFile } from "../src/models/sources/common.js";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "agent-os-provider-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
}

test("manual provider is available by default and follows status overrides", async () => {
  await withTempProject(async (projectDir) => {
    const config = await loadAgentOsConfig({ cwd: projectDir });

    const detected = await manualProvider.detect(config);
    const defaultStatus = await manualProvider.status(config);
    await setProviderStatusOverride(config.paths, "manual", "limited", "quota review");
    const overriddenStatus = await manualProvider.status(config);

    assert.equal(detected.available, true);
    assert.equal(defaultStatus.availability, "available");
    assert.equal(overriddenStatus.availability, "limited");
    assert.match(overriddenStatus.detail, /quota review/);
  });
});

test("provider doctor reports live health separately from manual overrides", async () => {
  await withTempProject(async (projectDir) => {
    const controller = await Controller.create({ rootDir: projectDir });

    const providerDoctor = await controller.providersDoctor() as {
      rootDir: string;
      providers: Array<Record<string, unknown>>;
    };
    const doctor = await controller.doctor() as {
      providerOverrides: Record<string, string>;
      providerHealth: Array<Record<string, unknown>>;
    };

    assert.equal(providerDoctor.rootDir, projectDir);
    assert.equal(providerDoctor.providers.length, DEFAULT_PROVIDERS.length);
    assert.equal(doctor.providerOverrides.manual, "available");
    assert.equal(doctor.providerHealth.length, DEFAULT_PROVIDERS.length);
    assert.ok(!("providers" in doctor), "doctor output must not label manual overrides as provider health");

    const manual = providerDoctor.providers.find((row) => row.provider === "manual");
    assert.ok(manual);
    assert.equal(manual.detected, "available");
    assert.equal(manual.availability, "available");
    assert.equal(manual.override, "available");
    assert.equal(manual.canLaunch, true);
    assert.equal(manual.cloudHosted, false);

    for (const row of providerDoctor.providers) {
      assert.equal(typeof row.provider, "string");
      assert.match(String(row.detected), /^(available|unavailable)$/);
      assert.match(String(row.availability), /^(available|unavailable|limited|unknown)$/);
      assert.match(String(row.override), /^(available|unavailable|limited|unknown)$/);
      assert.equal(typeof row.canLaunch, "boolean");
      assert.match(String(row.launchMode), /^(direct|preview-only|blocked)$/);
      assert.equal(typeof row.cloudHosted, "boolean");
      assert.equal(typeof row.detail, "string");
      assert.equal(typeof row.checkedAt, "string");
    }
  });
});

test("cloud provider status distinguishes catalog wiring from missing account credentials", async () => {
  const envName = "AGENT_OS_TEST_PROVIDER_KEY";
  const original = process.env[envName];
  try {
    delete process.env[envName];
    const provider = cloudCatalogProvider("openrouter", {
      provider: "openrouter",
      async discover() {
        return { provider: "openrouter", fetchedAt: "", expiresAt: "", source: "test", entries: [] };
      },
    }, { envVars: [envName] });

    const missingDetection = await provider.detect({} as never);
    const missingStatus = await provider.status({} as never);
    process.env[envName] = "present";
    const configuredDetection = await provider.detect({} as never);
    const configuredStatus = await provider.status({} as never);

    assert.equal(missingDetection.available, false);
    assert.equal(missingStatus.availability, "unavailable");
    assert.match(missingStatus.detail, /not set/);
    assert.equal(configuredDetection.available, true);
    assert.equal(configuredStatus.availability, "limited");
    assert.match(configuredStatus.detail, /smoke/);
  } finally {
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
  }
});

test("controller stores provider API keys locally and applies them to live provider health", async () => {
  await withTempProject(async (projectDir) => {
    const original = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const controller = await Controller.create({ rootDir: projectDir });
      const before = await controller.providerCredentials() as { credentials: Array<Record<string, unknown>> };
      assert.equal(before.credentials.find((row) => row.provider === "openrouter")?.source, "missing");

      await controller.setProviderCredential("openrouter", "OPENROUTER_API_KEY", "sk-agent-os-test");
      const credentials = await controller.providerCredentials() as { credentials: Array<Record<string, unknown>> };
      const openrouterCredential = credentials.credentials.find((row) => row.provider === "openrouter");
      const doctor = await controller.providersDoctor() as { providers: Array<Record<string, unknown>> };
      const openrouterHealth = doctor.providers.find((row) => row.provider === "openrouter");
      const mode = (await stat(providerCredentialsPath(controller.paths))).mode & 0o777;

      assert.equal(openrouterCredential?.configured, true);
      assert.equal(openrouterCredential?.source, "agent-os");
      assert.equal(openrouterCredential?.envVar, "OPENROUTER_API_KEY");
      assert.equal(openrouterHealth?.detected, "available");
      assert.equal(openrouterHealth?.availability, "limited");
      assert.equal(mode, 0o600);

      await controller.clearProviderCredential("openrouter");
      const after = await controller.providerCredentials() as { credentials: Array<Record<string, unknown>> };
      assert.equal(after.credentials.find((row) => row.provider === "openrouter")?.source, "missing");
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });
});

test("model refresh reports provider failures in the same result", async () => {
  await withTempProject(async (projectDir) => {
    const originalGemini = process.env.GEMINI_API_KEY;
    const originalGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const controller = await Controller.create({ rootDir: projectDir });
      const result = await controller.modelsRefresh("gemini") as {
        refreshed: string;
        entries: number;
        failures: Array<Record<string, unknown>>;
      };

      assert.equal(result.refreshed, "gemini");
      assert.equal(result.entries, 0);
      assert.equal(result.failures[0]?.provider, "gemini");
      assert.match(String(result.failures[0]?.error), /GEMINI_API_KEY/);
    } finally {
      if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGemini;
      if (originalGoogle === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = originalGoogle;
    }
  });
});

test("installed coding CLIs build headless auto-edit launch commands", async () => {
  await withTempProject(async (projectDir) => {
    const ctx: ProviderContext = {
      cwd: projectDir,
      paths: (await loadAgentOsConfig({ cwd: projectDir })).paths,
    };
    const task: Task = {
      id: "task-direct-cli",
      goal: "Create src/agent-os-provider-test.txt",
      allowedFiles: ["src/**"],
      risk: "low",
      createdAt: "2026-04-28T12:00:00.000Z",
      updatedAt: "2026-04-28T12:00:00.000Z",
      cwd: projectDir,
    };
    const bundlePath = path.join(projectDir, "agent-os-bundle.md");

    const codex = await codexProvider.buildLaunchCommand(ctx, task, bundlePath, "gpt-5.3-codex");
    assert.equal(codex.command, "codex");
    assert.ok(codex.args.includes("--ignore-user-config"));
    assert.ok(codex.args.includes("--ignore-rules"));
    assert.ok(codex.args.includes("--json"));
    assert.ok(codex.args.includes("gpt-5.3-codex"));

    const claude = await claudeProvider.buildLaunchCommand(ctx, task, bundlePath, "sonnet");
    assert.equal(claude.command, "claude");
    assert.ok(claude.args.includes("-p"));
    assert.ok(claude.args.includes("--permission-mode"));
    assert.ok(claude.args.includes("bypassPermissions"));
    assert.ok(claude.args.includes("--output-format"));
    assert.ok(claude.args.includes("stream-json"));
    assert.ok(claude.args.includes("--verbose"));
    assert.ok(claude.args.includes("--model"));
    assert.ok(claude.args.includes("sonnet"));
    assert.match(claude.args.join(" "), /isolated workspace/);

    const zai = await zaiProvider.buildLaunchCommand(ctx, task, bundlePath, "glm-4.6");
    assert.equal(zai.command, "claude-zai");
    assert.ok(zai.args.includes("-p"));
    assert.ok(zai.args.includes("--output-format"));
    assert.ok(zai.args.includes("stream-json"));
    assert.ok(zai.args.includes("--verbose"));
    assert.ok(zai.args.includes("--model"));
    assert.ok(zai.args.includes("glm-4.6"));

    const gemini = await geminiProvider.buildLaunchCommand(ctx, task, bundlePath, "gemini-2.5-pro");
    assert.equal(gemini.command, "gemini");
    assert.ok(gemini.args.includes("--prompt"));
    assert.ok(gemini.args.includes("--approval-mode"));
    assert.ok(gemini.args.includes("yolo"));
    assert.ok(gemini.args.includes("--output-format"));
    assert.ok(gemini.args.includes("stream-json"));
    assert.ok(gemini.args.includes("--model"));
    assert.ok(gemini.args.includes("gemini-2.5-pro"));
    assert.match(gemini.args.join(" "), /isolated workspace/);

    const opencode = await opencodeProvider.buildLaunchCommand(ctx, task, bundlePath, "anthropic/claude-sonnet-4-5");
    assert.equal(opencode.command, "opencode");
    assert.deepEqual(opencode.args.slice(0, 2), ["run", "--format"]);
    assert.ok(opencode.args.includes("json"));
    assert.ok(opencode.args.includes("--dir"));
    assert.ok(opencode.args.includes(projectDir));
    assert.ok(opencode.args.includes("--model"));
    assert.ok(opencode.args.includes("anthropic/claude-sonnet-4-5"));
    assert.match(opencode.args.join(" "), /isolated workspace/);

    const kilo = await kiloProvider.buildLaunchCommand(ctx, task, bundlePath, "kilo/kilo-auto/free");
    assert.equal(kilo.command, "kilo");
    assert.deepEqual(kilo.args.slice(0, 4), ["run", "--format", "json", "--dir"]);
    assert.ok(kilo.args.includes(projectDir));
    assert.ok(kilo.args.includes("--auto"));
    assert.ok(kilo.args.includes("--model"));
    assert.ok(kilo.args.includes("kilo/kilo-auto/free"));
    assert.match(kilo.args.join(" "), /isolated workspace/);
    assert.match(kilo.args.join(" "), /low-cost\/free worker models/);
    assert.match(kilo.args.join(" "), /Raw JSON only/);

    const cline = await clineProvider.buildLaunchCommand(ctx, task, bundlePath, "qwen/qwen3.6-plus-preview:free");
    assert.equal(cline.command, "cline");
    assert.deepEqual(cline.args.slice(0, 5), ["task", "--act", "--yolo", "--json", "--cwd"]);
    assert.ok(cline.args.includes(projectDir));
    assert.ok(cline.args.includes("--model"));
    assert.ok(cline.args.includes("qwen/qwen3.6-plus-preview:free"));
    assert.match(cline.args.join(" "), /isolated workspace/);
    assert.match(cline.args.join(" "), /low-cost\/free worker models/);
    assert.match(cline.args.join(" "), /Raw JSON only/);
  });
});

test("weak worker prompt carries principles and anti-hallucination output contract", () => {
  const task: Task = {
    id: "task-weak-worker-prompt",
    goal: "Create src/example.txt with exact content ok",
    allowedFiles: ["src/**"],
    risk: "low",
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
    cwd: "/tmp/project",
  };

  const prompt = buildWorkerPrompt(task, "/tmp/project/agent-os-bundle.md", {
    provider: "kilo",
    weakModel: true,
  });

  assert.match(prompt, /low-cost\/free worker models/);
  assert.match(prompt, /Do not claim/);
  assert.match(prompt, /Only report files, commands, tests, and outputs you actually observed/);
  assert.match(prompt, /KISS, YAGNI, DRY/);
  assert.match(prompt, /no TODOs/);
  assert.match(prompt, /Raw JSON only/);
  assert.match(prompt, /no markdown fences/);
  assert.match(prompt, /allowed files/i);
  assert.doesNotMatch(prompt, /\n{3,}/);
});

test("opencode default model selection avoids stale config and output errors are failures", async () => {
  const selected = selectOpencodeDefaultModel([
    "zai-coding-plan/glm-4.6",
    "openrouter/black-forest-labs/flux.2-pro",
    "github-copilot/claude-sonnet-4.6",
    "opencode/gpt-5.3-codex-spark",
    "github-copilot/grok-code-fast-1",
  ]);
  const parsed = await opencodeProvider.parseOutput({} as never, JSON.stringify({
    type: "error",
    error: { name: "UnknownError", data: { message: "Model not found: zai-coding-plan/glm-4.6." } },
  }), "");

  assert.equal(selected, "github-copilot/grok-code-fast-1");
  assert.equal(parsed.status, "failed");
  assert.match(parsed.summary, /Model not found/);
});

test("kilo and cline model sources parse installed CLI output", () => {
  const kiloOutput = [
    "kilo/kilo-auto/free",
    "kilo/google/gemini-2.5-flash-lite",
    "kilo/~anthropic/claude-sonnet-latest",
    "a/model-code",
    "not a model row",
    "kilo/kilo-auto/free",
  ].join("\n");
  const kiloIds = parseKiloModelIds(kiloOutput);
  const kiloModels = mapKiloModels(kiloOutput);

  assert.deepEqual(kiloIds, [
    "kilo/kilo-auto/free",
    "kilo/google/gemini-2.5-flash-lite",
    "kilo/~anthropic/claude-sonnet-latest",
    "a/model-code",
  ]);
  assert.equal(kiloModels[0]?.provider, "kilo");
  assert.equal(kiloModels.find((entry) => entry.id === "kilo/kilo-auto/free")?.costCategory, "free_quota");
  assert.equal(kiloModels.find((entry) => entry.id === "kilo/kilo-auto/free")?.codingGate.eligible, true);

  const clineOutput = [
    "\u001b[2JactModeApiModelId: claude-sonnet-4-6",
    "actModeClineModelId: qwen/qwen3.6-plus-preview:free",
    "actModeOpenRouterModelId: kwaipilot/kat-coder-pro",
    "autoApprovalSettings: {\"enabled\":true}",
    "SIGTERM received, shutting down...",
  ].join("\n");
  const clineIds = parseClineConfigModelIds(clineOutput);
  const clineModels = mapClineConfigModels(clineOutput);

  assert.deepEqual(clineIds, [
    "claude-sonnet-4-6",
    "qwen/qwen3.6-plus-preview:free",
    "kwaipilot/kat-coder-pro",
  ]);
  assert.equal(clineModels[0]?.provider, "cline");
  assert.equal(clineModels.find((entry) => entry.id === "qwen/qwen3.6-plus-preview:free")?.costCategory, "free_quota");
  assert.equal(clineModels.find((entry) => entry.id === "qwen/qwen3.6-plus-preview:free")?.codingGate.eligible, true);
});

test("codex parser honors final structured success despite noisy stderr", async () => {
  const stdout = [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "failed" } }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "{\"status\":\"success\",\"summary\":\"Created file\",\"changedFiles\":[\"src/example.txt\"]}",
      },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");

  const parsed = await codexProvider.parseOutput({} as never, stdout, "Reading additional input from stdin...");

  assert.equal(parsed.status, "completed");
  assert.match(parsed.summary, /Created file/);
});

test("stream-json providers can complete with non-fatal stderr", async () => {
  const geminiStdout = [
    JSON.stringify({ type: "message", role: "assistant", content: "done", delta: true }),
    JSON.stringify({ type: "result", status: "success", stats: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } }),
  ].join("\n");
  const claudeStdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "done" }),
  ].join("\n");

  const gemini = await geminiProvider.parseOutput({} as never, geminiStdout, "MCP issues detected");
  const claude = await claudeProvider.parseOutput({} as never, claudeStdout, "non-fatal warning");

  assert.equal(gemini.status, "completed");
  assert.equal(gemini.summary, "done");
  assert.equal(claude.status, "completed");
  assert.equal(claude.summary, "done");
});

test("kilo and cline parsers handle JSON events and failures", async () => {
  const success = [
    JSON.stringify({ type: "message", role: "assistant", content: "done", delta: false }),
    JSON.stringify({ type: "result", status: "success" }),
  ].join("\n");
  const failure = JSON.stringify({
    type: "error",
    error: { name: "UnknownError", data: { message: "Model not found" } },
  });

  const kiloSuccess = await kiloProvider.parseOutput({} as never, success, "non-fatal warning");
  const clineSuccess = await clineProvider.parseOutput({} as never, success, "non-fatal warning");
  const kiloFailure = await kiloProvider.parseOutput({} as never, failure, "");
  const clineFailure = await clineProvider.parseOutput({} as never, failure, "");

  assert.equal(kiloSuccess.status, "completed");
  assert.equal(kiloSuccess.summary, "done");
  assert.equal(clineSuccess.status, "completed");
  assert.equal(clineSuccess.summary, "done");
  assert.equal(kiloFailure.status, "failed");
  assert.match(kiloFailure.summary, /Model not found/);
  assert.equal(clineFailure.status, "failed");
  assert.match(clineFailure.summary, /Model not found/);
});

test("cline parser unwraps nested auth errors from free-model runner output", async () => {
  const stdout = [
    JSON.stringify({ type: "task_started", taskId: "task-unauthorized" }),
    JSON.stringify({
      type: "error",
      message: JSON.stringify({
        message: "Unauthorized: Please sign in to Cline before trying again.",
        providerId: "cline",
        modelId: "qwen/qwen3.6-plus-preview:free",
      }),
    }),
  ].join("\n");

  const parsed = await clineProvider.parseOutput({} as never, stdout, "");

  assert.equal(parsed.status, "failed");
  assert.match(parsed.summary, /Unauthorized: Please sign in to Cline/);
  assert.doesNotMatch(parsed.summary, /\\\"providerId\\\"/);
});

test("direct CLI dry-run accepts an uncached explicit model id", async () => {
  await withTempProject(async (projectDir) => {
    const controller = await Controller.create({ rootDir: projectDir });
    const created = await controller.taskCreate("prove uncached model passthrough", {
      allowedFiles: ["src/**"],
      risk: "low",
    }) as { id: string };

    const dryRun = await controller.taskDryRun(created.id, "gemini", "gemini-2.5-flash-lite") as {
      provider: string;
      model?: { id?: string };
      launchCommand: { args: string[] };
    };
    await writeModelCache(controller.paths, catalogFile("kilo", "test", mapKiloModels("kilo/kilo-auto/free")));
    await writeModelCache(controller.paths, catalogFile("cline", "test", mapClineConfigModels("actModeClineModelId: qwen/qwen3.6-plus-preview:free")));
    const kiloDryRun = await controller.taskDryRun(created.id, "kilo", "kilo/kilo-auto/free") as {
      provider: string;
      model?: { id?: string };
      launchCommand: { command: string; args: string[] };
    };
    const clineDryRun = await controller.taskDryRun(created.id, "cline", "qwen/qwen3.6-plus-preview:free") as {
      provider: string;
      model?: { id?: string };
      launchCommand: { command: string; args: string[] };
    };

    assert.equal(dryRun.provider, "gemini");
    assert.equal(dryRun.model?.id, "gemini-2.5-flash-lite");
    assert.ok(dryRun.launchCommand.args.includes("--model"));
    assert.ok(dryRun.launchCommand.args.includes("gemini-2.5-flash-lite"));
    assert.equal(kiloDryRun.provider, "kilo");
    assert.equal(kiloDryRun.model?.id, "kilo/kilo-auto/free");
    assert.equal(kiloDryRun.launchCommand.command, "kilo");
    assert.ok(kiloDryRun.launchCommand.args.includes("kilo/kilo-auto/free"));
    assert.equal(clineDryRun.provider, "cline");
    assert.equal(clineDryRun.model?.id, "qwen/qwen3.6-plus-preview:free");
    assert.equal(clineDryRun.launchCommand.command, "cline");
    assert.ok(clineDryRun.launchCommand.args.includes("qwen/qwen3.6-plus-preview:free"));
  });
});
