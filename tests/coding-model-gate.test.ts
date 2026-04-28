import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogEntry } from "../src/core/types.js";
import { evaluateCodingModelGate } from "../src/models/coding-gate.js";

function entry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    provider: "openrouter",
    id: "dynamic/coder",
    displayName: "Dynamic Coder",
    aliases: [],
    availability: "remote",
    costCategory: "free_api",
    capabilities: {
      coding: true,
      longContext: true,
      structuredOutput: true,
      toolUse: true,
    },
    contextWindow: 131072,
    source: {
      kind: "provider_api",
      fetchedAt: "2026-04-28T12:00:00.000Z",
      expiresAt: "2026-04-29T12:00:00.000Z",
    },
    confidence: "high",
    requiresApproval: false,
    codingGate: {
      eligible: true,
      reasons: [],
      smoke: "required",
    },
    ...overrides,
  };
}

test("eligible cloud coding models are marked smoke-required until proven", () => {
  const gate = evaluateCodingModelGate(entry());

  assert.equal(gate.eligible, true);
  assert.equal(gate.smoke, "required");
  assert.deepEqual(gate.reasons, []);
});

test("a passed smoke result keeps the model eligible without re-requiring smoke", () => {
  const gate = evaluateCodingModelGate(entry(), { smokePassed: true });

  assert.equal(gate.eligible, true);
  assert.equal(gate.smoke, "passed");
});

test("non-coding free models are excluded from coding routes", () => {
  const gate = evaluateCodingModelGate(
    entry({
      id: "dynamic/embedder",
      displayName: "Dynamic Embedder",
      capabilities: {
        structuredOutput: false,
        toolUse: false,
        vision: false,
      },
      contextWindow: 8192,
    }),
  );

  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes("not_coding_capable"));
  assert.ok(gate.reasons.includes("missing_tool_or_structured_output"));
});

test("unknown pricing blocks automatic coding eligibility", () => {
  const gate = evaluateCodingModelGate(
    entry({
      costCategory: "unknown",
      requiresApproval: true,
    }),
  );

  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes("price_requires_approval"));
});

test("repo coding tasks require long context unless explicitly scoped tiny", () => {
  const shortContext = entry({
    contextWindow: 32768,
    capabilities: {
      coding: true,
      structuredOutput: true,
      toolUse: true,
    },
  });

  assert.equal(evaluateCodingModelGate(shortContext).eligible, false);
  assert.equal(evaluateCodingModelGate(shortContext, { allowTinyTask: true }).eligible, true);
});

test("local or unavailable entries are never coding-worker eligible", () => {
  const gate = evaluateCodingModelGate(
    entry({
      availability: "unavailable",
      source: {
        kind: "user_config",
        command: "ollama list",
        fetchedAt: "2026-04-28T12:00:00.000Z",
        expiresAt: "2026-04-29T12:00:00.000Z",
      },
    }),
  );

  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes("not_cloud_available"));
});
