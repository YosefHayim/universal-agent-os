import assert from "node:assert/strict";
import test from "node:test";

import type { Controller } from "../src/core/controller.js";
import { runAction } from "../src/cli/interactive.js";

test("interactive status actions use live provider health, not persisted overrides", async () => {
  const calls: string[] = [];
  const fakeController = {
    async status() {
      calls.push("status");
      return { rootDir: "/tmp/project", taskCount: 0 };
    },
    async providersDoctor() {
      calls.push("providersDoctor");
      return {
        providers: [
          {
            provider: "manual",
            detected: "available",
            availability: "available",
            override: "available",
            canLaunch: true,
            launchMode: "direct",
            detail: "manual provider is built in",
          },
        ],
      };
    },
    async providersStatus() {
      calls.push("providersStatus");
      throw new Error("interactive status must not print raw provider overrides");
    },
    async queueStatus() {
      calls.push("queueStatus");
      return { items: [{ taskId: "task-a", status: "completed", updatedAt: "2026-04-29T00:00:00.000Z" }] };
    },
  } as unknown as Controller;

  await captureLogs(async () => runAction(fakeController, "status"));
  assert.deepEqual(calls, ["status", "providersDoctor"]);

  calls.length = 0;
  await captureLogs(async () => runAction(fakeController, "provider-status"));
  assert.deepEqual(calls, ["providersDoctor"]);

  calls.length = 0;
  await captureLogs(async () => runAction(fakeController, "queue-status"));
  assert.deepEqual(calls, ["queueStatus"]);
});

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
    return logs;
  } finally {
    console.log = original;
  }
}
