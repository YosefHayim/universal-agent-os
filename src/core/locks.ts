import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimePaths } from "./types.js";

export interface LockHandle {
  path: string;
  release: () => Promise<void>;
}

export async function acquireTaskLock(taskDir: string, owner = process.pid.toString()): Promise<LockHandle> {
  const lockDir = join(taskDir, "lock");
  await mkdir(taskDir, { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`Task is locked: ${taskDir}`);
    throw error;
  }
  await writeFile(join(lockDir, "owner.json"), `${JSON.stringify({ owner, createdAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return {
    path: lockDir,
    release: async () => {
      await rm(lockDir, { force: true, recursive: true });
    },
  };
}

export async function withTaskLock<T>(taskDir: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireTaskLock(taskDir);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export interface TaskLock {
  taskId: string;
  path: string;
  release(): Promise<void>;
}

export class TaskLockManager {
  constructor(private readonly paths: RuntimePaths) {}

  async acquireTaskLock(taskId: string, owner: string): Promise<TaskLock> {
    let handle: LockHandle;
    try {
      handle = await acquireTaskLock(join(this.paths.tasksDir, taskId), owner);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Task is locked:")) {
        throw new Error(`Task ${taskId} is already locked.`);
      }
      throw error;
    }
    return {
      taskId,
      path: handle.path,
      release: handle.release,
    };
  }

  async withTaskLock<T>(taskId: string, owner: string, fn: () => Promise<T>): Promise<T> {
    const lock = await this.acquireTaskLock(taskId, owner);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }
}
