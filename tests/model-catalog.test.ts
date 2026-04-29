import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ModelCatalogEntry } from "../src/core/types.js";
import {
  applyCatalogPolicy,
  createModelCatalog,
  listCatalogEntries,
} from "../src/models/catalog.js";
import { readModelCatalogCache, writeModelCatalogCache } from "../src/models/cache.js";
import { ACTIVE_MODEL_SOURCE_IDS, hasModelSource } from "../src/models/discovery.js";
import { mapCodexModels } from "../src/models/sources/codex.js";
import { mapGitHubModelsCatalog } from "../src/models/sources/github-models.js";
import { mapNvidiaNimCatalog } from "../src/models/sources/nvidia-nim.js";
import { mapOpencodeModels } from "../src/models/sources/opencode.js";
import { mapOpenRouterCatalog } from "../src/models/sources/openrouter.js";

const fixtureDir = new URL("./fixtures/models/", import.meta.url);

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, fixtureDir), "utf8"));
}

test("OpenRouter fixture maps dynamic models with pricing provenance and no canonical allowlist", async () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const payload = await loadFixture("openrouter-models.json");
  const entries = mapOpenRouterCatalog(payload, { now });

  assert.equal(entries.length, 3);
  assert.ok(entries.some((entry) => entry.id === "dynamic/test-coder-free"));
  assert.equal(entries.find((entry) => entry.id === "dynamic/test-coder-free")?.costCategory, "free_api");
  assert.equal(entries.find((entry) => entry.id === "dynamic/test-chat-paid")?.costCategory, "paid_api");
  assert.equal(entries.find((entry) => entry.id === "dynamic/test-coder-free")?.source.kind, "provider_api");
  assert.equal(entries.find((entry) => entry.id === "dynamic/test-coder-free")?.source.fetchedAt, now.toISOString());
});

test("Codex CLI object payload maps dynamic models from debug output", () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const entries = mapCodexModels({
    models: [
      { slug: "gpt-5.3-codex-spark", display_name: "GPT-5.3 Codex Spark" },
      { slug: "gpt-5.5", display_name: "GPT-5.5" },
    ],
  }, {
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.source.kind, "provider_cli");
  assert.equal(entries.find((entry) => entry.id === "gpt-5.3-codex-spark")?.codingGate.eligible, true);
});

test("GitHub Models fixture maps account-level free quota and coding metadata", async () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const payload = await loadFixture("github-models.json");
  const entries = mapGitHubModelsCatalog(payload, { now });

  const codeModel = entries.find((entry) => entry.id === "dynamic/test-github-code-reasoner");
  assert.equal(codeModel?.costCategory, "free_quota");
  assert.equal(codeModel?.capabilities.reasoning, true);
  assert.equal(codeModel?.capabilities.toolUse, true);
  assert.equal(codeModel?.capabilities.structuredOutput, true);
  assert.equal(codeModel?.contextWindow, 131072);
});

test("NVIDIA NIM sparse catalog does not promote legacy code models to coding routes", () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const entries = mapNvidiaNimCatalog({
    data: [
      { id: "bigcode/starcoder2-15b", object: "model", owned_by: "bigcode" },
      { id: "google/codegemma-7b", object: "model", owned_by: "google" },
      { id: "mistralai/codestral-22b-instruct-v0.1", object: "model", owned_by: "mistralai" },
      { id: "mistralai/codestral-22b-instruct-v0.1", object: "model", owned_by: "mistralai" },
      { id: "deepseek-ai/deepseek-v4-pro", object: "model", owned_by: "deepseek-ai" },
      { id: "qwen/qwen3-coder-480b-a35b-instruct", object: "model", owned_by: "qwen" },
    ],
  }, { now });

  assert.deepEqual(
    entries.filter((entry) => entry.codingGate.eligible).map((entry) => entry.id),
    [
      "mistralai/codestral-22b-instruct-v0.1",
      "deepseek-ai/deepseek-v4-pro",
      "qwen/qwen3-coder-480b-a35b-instruct",
    ],
  );
  assert.equal(entries.filter((entry) => entry.id === "mistralai/codestral-22b-instruct-v0.1").length, 1);
  assert.equal(entries.find((entry) => entry.id === "bigcode/starcoder2-15b")?.codingGate.eligible, false);
  assert.ok(entries.find((entry) => entry.id === "google/codegemma-7b")?.codingGate.reasons.includes("missing_tool_or_structured_output"));
});

test("opencode CLI model output maps dynamically without a hardcoded allowlist", () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const entries = mapOpencodeModels([
    "github-copilot/gpt-5.5",
    "openrouter/qwen/qwen3-coder:free",
    "openrouter/black-forest-labs/flux.2-pro",
    "github-copilot/gpt-5.5",
  ].join("\n"), {
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  });

  assert.deepEqual(entries.map((entry) => entry.id), [
    "github-copilot/gpt-5.5",
    "openrouter/qwen/qwen3-coder:free",
    "openrouter/black-forest-labs/flux.2-pro",
  ]);
  assert.equal(entries.find((entry) => entry.id === "openrouter/qwen/qwen3-coder:free")?.costCategory, "free_quota");
  assert.equal(entries.find((entry) => entry.id === "github-copilot/gpt-5.5")?.source.kind, "provider_cli");
  assert.equal(entries.find((entry) => entry.id === "openrouter/black-forest-labs/flux.2-pro")?.codingGate.eligible, false);
});

test("catalog cache writes provider TTL files under .agent-os/cache/models", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "agent-os-model-cache-"));
  try {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const entries = mapOpenRouterCatalog(await loadFixture("openrouter-models.json"), { now });
    const catalog = createModelCatalog("openrouter", entries, {
      fetchedAt: now,
      source: "https://openrouter.ai/api/v1/models",
    });

    await writeModelCatalogCache(rootDir, catalog);
    const cached = await readModelCatalogCache(rootDir, "openrouter", { now });

    assert.equal(cached?.provider, "openrouter");
    assert.equal(cached?.source, "https://openrouter.ai/api/v1/models");
    assert.equal(cached?.entries.length, 3);
    assert.equal(cached?.stale, false);
    assert.match(cached?.path ?? "", /\.agent-os\/cache\/models\/openrouter\.json$/);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test("unknown price and stale paid entries require approval", () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const stalePaid: ModelCatalogEntry = {
    provider: "openrouter",
    id: "dynamic/paid-stale",
    aliases: [],
    availability: "remote",
    costCategory: "paid_api",
    capabilities: { coding: true, structuredOutput: true, toolUse: true, longContext: true },
    contextWindow: 131072,
    source: {
      kind: "provider_api",
      fetchedAt: "2026-04-26T12:00:00.000Z",
      expiresAt: "2026-04-27T12:00:00.000Z",
    },
    confidence: "high",
    requiresApproval: false,
    codingGate: { eligible: true, reasons: [], smoke: "required" },
  };

  const unknown = { ...stalePaid, id: "dynamic/unknown-price", costCategory: "unknown" as const };
  assert.equal(applyCatalogPolicy(stalePaid, { now }).requiresApproval, true);
  assert.equal(applyCatalogPolicy(unknown, { now }).requiresApproval, true);
});

test("catalog filters free coding candidates without exposing non-coding free models", async () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const catalog = createModelCatalog(
    "openrouter",
    mapOpenRouterCatalog(await loadFixture("openrouter-models.json"), { now }),
    { fetchedAt: now, source: "fixture" },
  );

  const freeCoding = listCatalogEntries([catalog], {
    coding: true,
    free: true,
    now,
  });

  assert.deepEqual(
    freeCoding.map((entry) => entry.id),
    ["dynamic/test-coder-free"],
  );
});

test("active model source registry includes only remote-account provider sources", () => {
  assert.deepEqual(ACTIVE_MODEL_SOURCE_IDS, [
    "codex",
    "claude",
    "zai",
    "opencode",
    "kilo",
    "cline",
    "openrouter",
    "github-models",
    "gemini",
    "nvidia-nim",
    "mistral",
    "groq",
  ]);
  assert.equal(hasModelSource("manual"), false);
  assert.equal(ACTIVE_MODEL_SOURCE_IDS.some((provider) => /ollama|lm-studio|local|hugging/i.test(provider)), false);
});
