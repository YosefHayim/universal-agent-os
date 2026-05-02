import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { appendRegistryEntry, pruneRegistry, readRegistryEntries, registryFilePath, type RegistryEntry } from "../src/core/global-registry.js";

async function withTempRegistry<T>(fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "agent-os-registry-"));
  const path = join(dir, "nested", "registry.ndjson");
  const previous = process.env.AGENT_OS_REGISTRY_FILE;
  process.env.AGENT_OS_REGISTRY_FILE = path;
  try {
    return await fn(path, dir);
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_REGISTRY_FILE;
    else process.env.AGENT_OS_REGISTRY_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function entry(taskId: string, createdAt: string, repoRoot = "/tmp/repo"): RegistryEntry {
  return { taskId, repoRoot, goal: `goal ${taskId}`, createdAt };
}

test("registryFilePath honors AGENT_OS_REGISTRY_FILE override", () => {
  const previous = process.env.AGENT_OS_REGISTRY_FILE;
  process.env.AGENT_OS_REGISTRY_FILE = "/tmp/explicit-registry.ndjson";
  try {
    assert.equal(registryFilePath(), "/tmp/explicit-registry.ndjson");
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_REGISTRY_FILE;
    else process.env.AGENT_OS_REGISTRY_FILE = previous;
  }
});

test("registryFilePath uses XDG_DATA_HOME when set", () => {
  const previousRegistry = process.env.AGENT_OS_REGISTRY_FILE;
  const previousXdg = process.env.XDG_DATA_HOME;
  delete process.env.AGENT_OS_REGISTRY_FILE;
  process.env.XDG_DATA_HOME = "/tmp/xdg-data-fixture";
  try {
    assert.equal(registryFilePath(), "/tmp/xdg-data-fixture/agent-os/registry.ndjson");
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENT_OS_REGISTRY_FILE;
    else process.env.AGENT_OS_REGISTRY_FILE = previousRegistry;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
  }
});

test("registryFilePath falls back to ~/.local/share when neither env var is set", () => {
  const previousRegistry = process.env.AGENT_OS_REGISTRY_FILE;
  const previousXdg = process.env.XDG_DATA_HOME;
  delete process.env.AGENT_OS_REGISTRY_FILE;
  delete process.env.XDG_DATA_HOME;
  try {
    assert.equal(registryFilePath(), `${homedir()}/.local/share/agent-os/registry.ndjson`);
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENT_OS_REGISTRY_FILE;
    else process.env.AGENT_OS_REGISTRY_FILE = previousRegistry;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
  }
});

test("appendRegistryEntry creates the file and parent dir if missing", async () => {
  await withTempRegistry(async (path) => {
    await appendRegistryEntry(entry("task-1", "2026-05-01T00:00:00.000Z"));
    const contents = await readFile(path, "utf8");
    assert.match(contents, /task-1/);
  });
});

test("appendRegistryEntry round-trips entries in order", async () => {
  await withTempRegistry(async () => {
    const entries = [
      entry("task-1", "2026-05-01T00:00:00.000Z"),
      entry("task-2", "2026-05-01T00:01:00.000Z"),
      entry("task-3", "2026-05-01T00:02:00.000Z"),
    ];
    for (const item of entries) await appendRegistryEntry(item);
    assert.deepEqual((await readRegistryEntries()).map((item) => item.taskId), ["task-1", "task-2", "task-3"]);
  });
});

test("readRegistryEntries with sinceMs filter excludes older entries", async () => {
  await withTempRegistry(async () => {
    await appendRegistryEntry(entry("old", "2026-05-01T00:00:00.000Z"));
    await appendRegistryEntry(entry("new", "2026-05-02T00:00:00.000Z"));
    const entries = await readRegistryEntries({ sinceMs: Date.parse("2026-05-01T12:00:00.000Z") });
    assert.deepEqual(entries.map((item) => item.taskId), ["new"]);
  });
});

test("readRegistryEntries with repoRoot filter returns only matching entries", async () => {
  await withTempRegistry(async () => {
    await appendRegistryEntry(entry("one", "2026-05-01T00:00:00.000Z", "/tmp/one"));
    await appendRegistryEntry(entry("two", "2026-05-01T00:00:00.000Z", "/tmp/two"));
    const entries = await readRegistryEntries({ repoRoot: "/tmp/two" });
    assert.deepEqual(entries.map((item) => item.repoRoot), [resolve("/tmp/two")]);
  });
});

test("readRegistryEntries skips a malformed final line without throwing", async () => {
  await withTempRegistry(async (path) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(entry("ok", "2026-05-01T00:00:00.000Z"))}\n{"taskId"`, "utf8");
    const entries = await readRegistryEntries();
    assert.deepEqual(entries.map((item) => item.taskId), ["ok"]);
  });
});

test("pruneRegistry removes older entries and leaves valid NDJSON", async () => {
  await withTempRegistry(async (path) => {
    await appendRegistryEntry(entry("old", "2026-05-01T00:00:00.000Z"));
    await appendRegistryEntry(entry("new", "2026-05-03T00:00:00.000Z"));
    const removed = await pruneRegistry({ olderThanMs: Date.parse("2026-05-02T00:00:00.000Z") });
    assert.equal(removed, 1);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] ?? "{}").taskId, "new");
  });
});

test("concurrent appends produce two valid lines without interleaving", async () => {
  await withTempRegistry(async (path) => {
    await Promise.all([
      appendRegistryEntry(entry("task-a", "2026-05-01T00:00:00.000Z")),
      appendRegistryEntry(entry("task-b", "2026-05-01T00:00:00.000Z")),
    ]);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    const taskIds = lines.map((line) => (JSON.parse(line) as RegistryEntry).taskId).sort();
    assert.deepEqual(taskIds, ["task-a", "task-b"]);
  });
});
