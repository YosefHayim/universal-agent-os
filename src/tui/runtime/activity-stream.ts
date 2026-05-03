import * as fs from "node:fs/promises";
import { join } from "node:path";

/**
 * Live activity entry surfaced to the TUI's REAL-TIME ACTIVITY LOG.
 *
 * Entries are produced from two sources:
 *   1. State-transition events emitted by the dashboard (spawn/complete/fail/...).
 *   2. Stdout/stderr tail of each running worker's `stdout.log`/`stderr.log`,
 *      polled by `pollWorkerLogs` at ~1Hz with byte-offset tracking so we
 *      only read newly-appended bytes.
 *
 * `kind` lets the renderer color-code lines without the buffer caring about
 * formatting. The buffer is kept in insertion order; `getActivityEntries`
 * returns newest-first because the dashboard renders top-to-bottom.
 */
export type ActivityKind = "stdout" | "stderr" | "tool" | "edit" | "status";

export interface ActivityEntry {
  id: number;
  workerId: string;
  shortId: string;
  timestamp: string;
  line: string;
  kind: ActivityKind;
}

interface WatchedWorker {
  /** Absolute path to the worker directory containing stdout.log/stderr.log. */
  dir: string;
  workerId: string;
  shortId: string;
  stdoutOffset: number;
  stderrOffset: number;
}

const BUFFER_CAP = 500;
const MAX_LINE_BYTES = 64 * 1024;
const ANSI_RE = /\[[0-9;?]*[A-Za-z]|\][^]*/g;

const buffer: ActivityEntry[] = [];
const watched = new Map<string, WatchedWorker>();
let nextId = 1;

/** Strip CSI/OSC ANSI escapes; ink renders raw text so these would corrupt the log. */
const stripAnsi = (input: string): string => input.replace(ANSI_RE, "");

const shortenId = (id: string): string => (id === "—" ? "—" : id.slice(0, 8));

const pushEntry = (entry: Omit<ActivityEntry, "id">): void => {
  buffer.push({ ...entry, id: nextId++ });
  if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP);
};

/** Detects structured-event JSON lines (claude/codex stream-json mode) for richer tagging. */
const classify = (line: string, fallback: ActivityKind): { line: string; kind: ActivityKind } => {
  const trimmed = line.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed) as { type?: string; tool?: string; name?: string; path?: string };
      if (typeof obj.type === "string") {
        if (/tool/i.test(obj.type)) return { line: `tool: ${obj.tool ?? obj.name ?? obj.type}${obj.path ? ` ${obj.path}` : ""}`, kind: "tool" };
        if (/edit|write|apply/i.test(obj.type)) return { line: `edit: ${obj.path ?? obj.name ?? obj.type}`, kind: "edit" };
      }
    } catch {
      // Not JSON after all — fall through.
    }
  }
  return { line, kind: fallback };
};

const ingestChunk = (worker: WatchedWorker, text: string, fallback: ActivityKind): void => {
  if (!text) return;
  for (const raw of text.split(/\r?\n/)) {
    const cleaned = stripAnsi(raw).trim();
    if (!cleaned) continue;
    const { line, kind } = classify(cleaned, fallback);
    pushEntry({
      workerId: worker.workerId,
      shortId: worker.shortId,
      timestamp: new Date().toISOString(),
      line,
      kind,
    });
  }
};

/**
 * Read the bytes appended to `path` since `offset` and return the new offset.
 * Uses fs.promises.open + read with an explicit byte position so we never re-read
 * the whole file. Files that have been truncated (offset > size) are reset.
 */
const readSince = async (path: string, offset: number): Promise<{ text: string; nextOffset: number }> => {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, "r");
    const stat = await handle.stat();
    let start = offset;
    if (stat.size < offset) start = 0; // log was rotated/truncated
    const remaining = stat.size - start;
    if (remaining <= 0) return { text: "", nextOffset: stat.size };
    const toRead = Math.min(remaining, MAX_LINE_BYTES);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, start);
    return { text: buf.toString("utf8", 0, bytesRead), nextOffset: start + bytesRead };
  } catch {
    return { text: "", nextOffset: offset };
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/**
 * Reconcile the watch set against the currently running workers and tail their
 * logs. New workers start at end-of-file (so we do not flood the buffer with
 * historical output). Workers that have completed/disappeared are dropped.
 */
export async function pollWorkerLogs(running: Array<{ workerId: string; dir: string }>): Promise<void> {
  const seen = new Set<string>();
  for (const { workerId, dir } of running) {
    seen.add(workerId);
    let entry = watched.get(workerId);
    if (!entry) {
      // Start at EOF so we only stream lines emitted from now on.
      const [stdoutSize, stderrSize] = await Promise.all([
        fs.stat(join(dir, "stdout.log")).then((s) => s.size).catch(() => 0),
        fs.stat(join(dir, "stderr.log")).then((s) => s.size).catch(() => 0),
      ]);
      entry = { dir, workerId, shortId: shortenId(workerId), stdoutOffset: stdoutSize, stderrOffset: stderrSize };
      watched.set(workerId, entry);
      continue;
    }
    const [out, err] = await Promise.all([
      readSince(join(entry.dir, "stdout.log"), entry.stdoutOffset),
      readSince(join(entry.dir, "stderr.log"), entry.stderrOffset),
    ]);
    entry.stdoutOffset = out.nextOffset;
    entry.stderrOffset = err.nextOffset;
    ingestChunk(entry, out.text, "stdout");
    ingestChunk(entry, err.text, "stderr");
  }
  for (const id of [...watched.keys()]) {
    if (!seen.has(id)) watched.delete(id);
  }
}

/** Append a synthetic status-change entry (spawn/complete/fail/...) from the dashboard. */
export function recordStatusEvent(workerId: string, line: string): void {
  pushEntry({
    workerId,
    shortId: shortenId(workerId),
    timestamp: new Date().toISOString(),
    line,
    kind: "status",
  });
}

/** Newest-first snapshot of the activity buffer for the renderer. */
export function getActivityEntries(): ActivityEntry[] {
  return [...buffer].reverse();
}

/** Test/diagnostic helper — drops all watched workers and clears the ring buffer. */
export function resetActivityStream(): void {
  buffer.length = 0;
  watched.clear();
  nextId = 1;
}
