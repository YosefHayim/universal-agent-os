import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveRuntimePaths, ensureRuntime, setProviderCredential } from "../src/config/config-loader.js";
import { createCatalogEntry, createModelCatalog } from "../src/models/catalog.js";
import { writeModelCache } from "../src/models/cache.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const agentOsBin = path.join(repoRoot, "src", "bin", "agent-os.ts");

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "agent-os-smoke-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
}

function runCli(projectDir: string, args: string[], env: Record<string, string | undefined> = {}) {
  const result = spawnSync(tsxBin, [agentOsBin, ...args], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  assert.equal(
    result.status,
    0,
    `agent-os ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  return result.stdout.trim();
}

function runCliRaw(projectDir: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(tsxBin, [agentOsBin, ...args], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("CLI can create and complete a manual task in any project directory", async () => {
  await withTempProject(async (projectDir) => {
    const help = runCli(projectDir, []);
    const guide = runCli(projectDir, ["guide"]);
    const taskRunHelp = runCli(projectDir, ["task", "run", "--help"]);
    const doctor = JSON.parse(runCli(projectDir, ["doctor"]));
    const providersStatus = JSON.parse(runCli(projectDir, ["providers", "status"]));
    const passthroughStatus = JSON.parse(runCli(projectDir, ["--", "providers", "status"]));
    const providerOverrides = JSON.parse(runCli(projectDir, ["providers", "overrides"]));
    const providerCredentials = JSON.parse(runCli(projectDir, ["providers", "credentials"]));
    const created = JSON.parse(
      runCli(projectDir, [
        "task",
        "create",
        "prove the CLI manual flow",
        "--allowed-files",
        "src/**",
        "--risk",
        "low",
      ]),
    );
    const dryRun = JSON.parse(runCli(projectDir, ["task", "dry-run", created.id, "--provider", "manual"]));
    const completedRaw = runCliRaw(projectDir, ["task", "run", created.id, "--provider", "manual"]);
    assert.equal(
      completedRaw.status,
      0,
      `agent-os task run failed\nstdout:\n${completedRaw.stdout}\nstderr:\n${completedRaw.stderr}`,
    );
    const completed = JSON.parse(completedRaw.stdout.trim());
    const listed = JSON.parse(runCli(projectDir, ["task", "list"]));
    const events = JSON.parse(runCli(projectDir, ["task", "events", created.id]));
    const status = JSON.parse(runCli(projectDir, ["task", "status", created.id]));
    const queue = JSON.parse(runCli(projectDir, ["queue", "status"]));
    const taskDir = path.join(projectDir, ".agent-os", "tasks", created.id);
    const telemetry = await readFile(path.join(projectDir, ".agent-os", "telemetry.ndjson"), "utf8");
    const contextFiles = JSON.parse(await readFile(path.join(taskDir, "context", "files.json"), "utf8"));

    assert.match(help, /Usage: agent-os/);
    assert.match(help, /agent-os guide/);
    assert.match(guide, /Agent OS quick runbook/);
    assert.match(guide, /gemini-2\.5-flash-lite/);
    assert.match(taskRunHelp, /isolated worker copy/);
    assert.equal(doctor.ok, true);
    assert.ok(Array.isArray(providersStatus.providers));
    assert.equal(typeof passthroughStatus.providers.find((row: { provider: string }) => row.provider === "opencode")?.launchMode, "string");
    assert.equal(providersStatus.providers.find((row: { provider: string }) => row.provider === "manual")?.detected, "available");
    assert.equal(typeof providersStatus.providers.find((row: { provider: string }) => row.provider === "codex")?.availability, "string");
    assert.equal(providerOverrides.providers.manual, "available");
    assert.equal(Array.isArray(providerOverrides.providers), false);
    assert.ok(Array.isArray(providerCredentials.credentials));
    assert.match(created.id, /^task-/);
    assert.equal(dryRun.status, "dry_run");
    assert.equal(completed.status, "completed");
    assert.match(completedRaw.stderr, /\[universal-agent-os\] task task-.*context saved/);
    assert.match(completedRaw.stderr, /\[universal-agent-os\] task task-.*route selected: manual/);
    assert.match(completedRaw.stderr, /\[universal-agent-os\] task task-.*manual\/manual-1 workspace ready/);
    assert.match(completedRaw.stderr, /\[universal-agent-os\] task task-.*manual\/manual-1 finished/);
    assert.equal(listed[0].taskId, created.id);
    assert.ok(events.events.some((event: { event: string }) => event.event === "task_completed"));
    assert.equal(status.status, "completed");
    assert.equal(queue.items.find((item: { taskId: string }) => item.taskId === created.id)?.status, "completed");
    assert.match(telemetry, /"agent_os\.task\.id"/);
    assert.equal(typeof contextFiles.budgetBytes, "number");
    assert.ok(Array.isArray(contextFiles.files));
  });
});

test("CLI dry-run switches explicit cloud models and records launch evidence", async () => {
  await withTempProject(async (projectDir) => {
    const paths = await ensureRuntime(resolveRuntimePaths(projectDir));
    const now = new Date("2026-04-28T12:00:00.000Z");
    await writeModelCache(paths, createModelCatalog("openrouter", [
      createCatalogEntry({
        provider: "openrouter",
        id: "dynamic/first-coder-free",
        aliases: ["first-coder"],
        costCategory: "free_api",
        contextWindow: 131072,
        sourceKind: "provider_api",
        sourceUrl: "fixture",
        fetchedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        toolUse: true,
        structuredOutput: true,
      }),
      createCatalogEntry({
        provider: "openrouter",
        id: "dynamic/second-coder-free",
        aliases: ["second-coder"],
        costCategory: "free_api",
        contextWindow: 131072,
        sourceKind: "provider_api",
        sourceUrl: "fixture",
        fetchedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        toolUse: true,
        structuredOutput: true,
      }),
    ], { fetchedAt: now, source: "fixture" }));

    const created = JSON.parse(runCli(projectDir, [
      "task",
      "create",
      "prove explicit model switching",
      "--allowed-files",
      "src/**",
      "--risk",
      "low",
    ]));
    const unavailable = JSON.parse(runCli(projectDir, [
      "task",
      "dry-run",
      created.id,
      "--provider",
      "openrouter",
      "--model",
      "first-coder",
    ], { OPENROUTER_API_KEY: "" }));

    assert.equal(unavailable.provider, "manual");
    assert.match(unavailable.reason, /openrouter unavailable/);

    await setProviderCredential(paths, "openrouter", "OPENROUTER_API_KEY", "sk-agent-os-test");
    const savedCredential = JSON.parse(runCli(projectDir, ["providers", "credentials"]));
    assert.equal(savedCredential.credentials.find((row: { provider: string }) => row.provider === "openrouter")?.source, "agent-os");
    assert.doesNotMatch(JSON.stringify(savedCredential), /sk-agent-os-test/);
    const first = JSON.parse(runCli(projectDir, [
      "task",
      "dry-run",
      created.id,
      "--provider",
      "openrouter",
      "--model",
      "first-coder",
    ]));
    const second = JSON.parse(runCli(projectDir, [
      "task",
      "dry-run",
      created.id,
      "--provider",
      "openrouter",
      "--model",
      "dynamic/second-coder-free",
    ]));

    assert.equal(first.model.id, "dynamic/first-coder-free");
    assert.equal(second.model.id, "dynamic/second-coder-free");
    assert.equal(second.launchCommand.command, "openrouter");
    assert.deepEqual(second.launchCommand.args.slice(0, 1), ["dynamic/second-coder-free"]);

    const taskDir = path.join(projectDir, ".agent-os", "tasks", created.id);
    const preview = JSON.parse(await readFile(path.join(taskDir, "launch-preview.json"), "utf8"));
    const events = await readFile(path.join(taskDir, "events.ndjson"), "utf8");

    assert.equal(preview.modelId, "dynamic/second-coder-free");
    assert.match(events, /"event":"launch_preview_built"/);
    assert.match(events, /"model":"dynamic\/second-coder-free"/);
  });
});

test("CLI validation blocks no-op worker results before accept", async () => {
  await withTempProject(async (projectDir) => {
    const created = JSON.parse(runCli(projectDir, [
      "task",
      "create",
      "prove no-op validation blocks accept",
      "--allowed-files",
      "src/**",
      "--risk",
      "low",
    ]));
    const completed = JSON.parse(runCli(projectDir, ["task", "run", created.id, "--provider", "manual"]));
    const validation = JSON.parse(runCli(projectDir, ["task", "validate", created.id]));
    const accept = runCliRaw(projectDir, ["task", "accept", created.id]);

    assert.equal(completed.status, "completed");
    assert.equal(validation.status, "failed");
    assert.ok(validation.validators.some((item: { id: string; status: string }) => item.id === "no_op_check" && item.status === "failed"));
    assert.notEqual(accept.status, 0);
    assert.match(accept.stderr, /validators failed/);
  });
});
