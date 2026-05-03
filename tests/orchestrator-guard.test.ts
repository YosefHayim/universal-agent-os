import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardFilePath, readGuardState, writeGuardState } from "../src/core/orchestrator-guard.js";

async function withTempGuardFile<T>(name: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "agent-os-guard-"));
  const path = join(dir, name);
  const previous = process.env.AGENT_OS_GUARD_FILE;
  process.env.AGENT_OS_GUARD_FILE = path;
  try {
    return await fn(path);
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_GUARD_FILE;
    else process.env.AGENT_OS_GUARD_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("guardFilePath honors AGENT_OS_GUARD_FILE override", () => {
  const previous = process.env.AGENT_OS_GUARD_FILE;
  process.env.AGENT_OS_GUARD_FILE = "/tmp/explicit-guard.json";
  try {
    assert.equal(guardFilePath(), "/tmp/explicit-guard.json");
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_GUARD_FILE;
    else process.env.AGENT_OS_GUARD_FILE = previous;
  }
});

test("readGuardState defaults to enabled when file is missing", async () => {
  await withTempGuardFile("missing.json", async (path) => {
    const state = await readGuardState();
    assert.equal(state.enabled, true);
    assert.equal(state.source, "default");
    assert.equal(state.path, path);
  });
});

test("readGuardState returns disabled when file says enabled:false", async () => {
  await withTempGuardFile("disabled.json", async (path) => {
    await writeFile(path, JSON.stringify({ enabled: false }), "utf8");
    const state = await readGuardState();
    assert.equal(state.enabled, false);
    assert.equal(state.source, "file");
  });
});

test("readGuardState falls back to default for malformed JSON content", async () => {
  await withTempGuardFile("bad.json", async (path) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "not json", "utf8");
    await assert.rejects(() => readGuardState());
  });
});

test("writeGuardState creates parent directory and persists value", async () => {
  await withTempGuardFile("nested/dir/state.json", async (path) => {
    const result = await writeGuardState(false);
    assert.equal(result.enabled, false);
    assert.equal(result.path, path);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { enabled: boolean };
    assert.equal(persisted.enabled, false);
  });
});

test("writeGuardState round-trips through readGuardState", async () => {
  await withTempGuardFile("roundtrip.json", async () => {
    await writeGuardState(true);
    const onState = await readGuardState();
    assert.equal(onState.enabled, true);
    assert.equal(onState.source, "file");
    await writeGuardState(false);
    const offState = await readGuardState();
    assert.equal(offState.enabled, false);
  });

test("writeGuardState round-trips three sequential writes", async () => {
  await withTempGuardFile("sequential.json", async (_path) => {
    await writeGuardState(true);
    const state1 = await readGuardState();
    assert.equal(state1.enabled, true);

    await writeGuardState(false);
    const state2 = await readGuardState();
    assert.equal(state2.enabled, false);

    await writeGuardState(true);
    const state3 = await readGuardState();
    assert.equal(state3.enabled, true);
  });
});

test("readGuardState defaults to enabled when JSON is empty object", async () => {
  await withTempGuardFile("empty.json", async (path) => {
    await writeFile(path, "{}", "utf8");
    const state = await readGuardState();
    assert.equal(state.enabled, true);
    assert.equal(state.source, "default");
  });
});

test("readGuardState ignores non-boolean enabled values", async () => {
  await withTempGuardFile("non-boolean.json", async (path) => {
    await writeFile(path, JSON.stringify({ enabled: "false" }), "utf8");
    const state = await readGuardState();
    assert.equal(state.enabled, true);
    assert.equal(state.source, "default");
  });
});

test("guardFilePath uses XDG_CONFIG_HOME when AGENT_OS_GUARD_FILE is unset", () => {
  const previousGuardFile = process.env.AGENT_OS_GUARD_FILE;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

  delete process.env.AGENT_OS_GUARD_FILE;
  process.env.XDG_CONFIG_HOME = "/tmp/xdg-fixture";

  try {
    assert.equal(guardFilePath(), "/tmp/xdg-fixture/agent-os/orchestrator-block.json");
  } finally {
    if (previousGuardFile === undefined) delete process.env.AGENT_OS_GUARD_FILE;
    else process.env.AGENT_OS_GUARD_FILE = previousGuardFile;

    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
});

test("guardFilePath falls back to ~/.config when neither env var is set", () => {
  const previousGuardFile = process.env.AGENT_OS_GUARD_FILE;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

  delete process.env.AGENT_OS_GUARD_FILE;
  delete process.env.XDG_CONFIG_HOME;

  try {
    assert.equal(guardFilePath(), `${homedir()}/.config/agent-os/orchestrator-block.json`);
  } finally {
    if (previousGuardFile === undefined) delete process.env.AGENT_OS_GUARD_FILE;
    else process.env.AGENT_OS_GUARD_FILE = previousGuardFile;

    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
});
});
