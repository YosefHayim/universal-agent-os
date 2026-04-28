import assert from "node:assert/strict";
import test from "node:test";

import type { EventRecord } from "../src/core/types.js";
import { buildRunUsage, formatUsageLine, summarizeUsage } from "../src/usage/usage.js";

test("usage parser reads codex and gemini stream usage before falling back to estimates", () => {
  const codex = buildRunUsage({
    prompt: "short prompt",
    stdout: JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 124480,
        cached_input_tokens: 101120,
        output_tokens: 1688,
        reasoning_output_tokens: 1054,
      },
    }),
    stderr: "",
  });
  const gemini = buildRunUsage({
    prompt: "short prompt",
    stdout: JSON.stringify({
      type: "result",
      status: "success",
      stats: {
        total_tokens: 48230,
        input_tokens: 48066,
        output_tokens: 40,
        cached: 7752,
      },
    }),
    stderr: "",
  });
  const estimated = buildRunUsage({ prompt: "abcd efgh", stdout: "ok", stderr: "" });

  assert.equal(codex.exact, true);
  assert.equal(codex.inputTokens, 124480);
  assert.equal(codex.cachedInputTokens, 101120);
  assert.equal(codex.outputTokens, 1688);
  assert.equal(codex.reasoningOutputTokens, 1054);
  assert.equal(gemini.exact, true);
  assert.equal(gemini.totalTokens, 48230);
  assert.equal(gemini.cachedInputTokens, 7752);
  assert.equal(estimated.exact, false);
  assert.match(formatUsageLine(estimated), /estimated/);
});

test("usage summary aggregates provider totals for today and week", () => {
  const events: EventRecord[] = [
    {
      taskId: "task-1",
      timestamp: "2026-04-28T10:00:00.000Z",
      event: "worker_finished",
      provider: "codex",
      usage: { exact: true, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    {
      taskId: "task-2",
      timestamp: "2026-04-27T10:00:00.000Z",
      event: "worker_finished",
      provider: "gemini",
      usage: { exact: false, estimatedTotalTokens: 20 },
    },
  ];

  const summary = summarizeUsage(events, new Date("2026-04-28T12:00:00.000Z"));

  assert.equal(summary.latest?.taskId, "task-1");
  assert.equal(summary.today.length, 1);
  assert.equal(summary.today[0]?.provider, "codex");
  assert.equal(summary.week.length, 2);
  assert.equal(summary.week.find((row) => row.provider === "codex")?.totalTokens, 15);
  assert.equal(summary.week.find((row) => row.provider === "gemini")?.estimatedTokens, 20);
});
