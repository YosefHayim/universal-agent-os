import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

/**
 * Tracked worker subprocess paired with the temp workspace it owns.
 *
 * The cleanup logic needs both: SIGTERM the child (so the orchestrator does not
 * leak background CLIs after Ctrl-C) and remove its scratch workspace dir
 * (mkdtemp'd under the OS tmpdir, e.g. ~/.cache/tmp/ or /var/folders/...).
 * Workspaces persist on disk past process exit unless we delete them here.
 */
export interface TrackedWorker {
  child: ChildProcess;
  workspacePath?: string;
}

/**
 * Module-level set of in-flight workers. We store wrappers rather than raw
 * child processes so cleanup can also remove temp workspaces. Entries are
 * removed when a child exits normally, so by the time a SIGINT lands the set
 * only holds genuinely live workers.
 */
const liveWorkers = new Set<TrackedWorker>();

/** Used to make signal handler installation idempotent across re-imports / re-entry. */
let signalHandlersInstalled = false;
let cleanupInProgress = false;

export function registerWorker(worker: TrackedWorker): void {
  liveWorkers.add(worker);
  worker.child.once("close", () => liveWorkers.delete(worker));
  worker.child.once("exit", () => liveWorkers.delete(worker));
}

export function unregisterWorker(worker: TrackedWorker): void {
  liveWorkers.delete(worker);
}

/** Test helper. */
export function snapshotLiveWorkers(): TrackedWorker[] {
  return [...liveWorkers];
}

/**
 * Send SIGTERM to every tracked worker, wait up to `graceMs` for graceful exit,
 * then SIGKILL stragglers. Finally removes each worker's temp workspace dir.
 *
 * Exported so unit tests can drive the logic with synthetic ChildProcess-like
 * objects without installing real signal handlers.
 */
export async function cleanupWorkers(workers: TrackedWorker[], graceMs = 5_000): Promise<void> {
  if (workers.length === 0) return;

  const pending = workers.map((worker) => waitForExit(worker, graceMs));
  for (const worker of workers) sendSignal(worker.child, "SIGTERM");

  const results = await Promise.all(pending);

  for (let index = 0; index < workers.length; index += 1) {
    if (!results[index]) sendSignal(workers[index].child, "SIGKILL");
  }

  // Best-effort workspace prune. Doing this synchronously keeps the SIGINT path
  // simple — the orchestrator is exiting anyway.
  for (const worker of workers) {
    if (!worker.workspacePath) continue;
    try {
      rmSync(worker.workspacePath, { recursive: true, force: true });
    } catch {
      // Workspace may already be gone (e.g. provider cleaned up). Ignore.
    }
  }
}

/**
 * Install SIGINT/SIGTERM handlers on the orchestrator process. Idempotent: a
 * second invocation is a no-op so library consumers and tests can call freely.
 *
 * Exit code 130 follows the UNIX convention for SIGINT (128 + signal number).
 */
export function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const handler = (signal: NodeJS.Signals): void => {
    if (cleanupInProgress) return;
    cleanupInProgress = true;
    const exitCode = signal === "SIGINT" ? 130 : 143;
    void cleanupWorkers(snapshotLiveWorkers()).finally(() => process.exit(exitCode));
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  // Workers are spawned with `detached: true` so they live in their own group.
  // Signalling -pid sweeps the whole tree (e.g. a CLI's spawned helpers).
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall through to direct pid signal — group may not exist on some platforms.
  }
  try {
    child.kill(signal);
  } catch {
    // Process already gone.
  }
}

/** Resolves true when the child exits before `graceMs`, false otherwise. */
function waitForExit(worker: TrackedWorker, graceMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), graceMs);
    worker.child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
