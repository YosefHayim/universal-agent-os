import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { QUEUE_FILE } from "../config/defaults.js";
import type { RuntimePaths, TaskStatus } from "./types.js";

export type QueueStatus = TaskStatus | "queued" | "paused";

export interface QueueItem {
  taskId: string;
  status: QueueStatus;
  createdAt: string;
  updatedAt: string;
  message?: string;
}

interface QueueState {
  items: QueueItem[];
}

export class InMemoryQueue {
  private readonly items: QueueItem[] = [];

  enqueue(taskId: string, status: QueueStatus = "queued", message?: string): QueueItem {
    const existing = this.items.find((item) => item.taskId === taskId);
    if (existing) return this.update(taskId, status, message);
    const now = new Date().toISOString();
    const item = { taskId, status, createdAt: now, updatedAt: now, message };
    this.items.push(item);
    return item;
  }

  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  list(): QueueItem[] {
    return [...this.items];
  }

  update(taskId: string, status: QueueStatus, message?: string): QueueItem {
    const existing = this.items.find((item) => item.taskId === taskId);
    if (!existing) return this.enqueue(taskId, status, message);
    existing.status = status;
    existing.updatedAt = new Date().toISOString();
    existing.message = message;
    return { ...existing };
  }
}

export class TaskQueue {
  private readonly queue?: InMemoryQueue;
  private readonly filePath?: string;

  constructor(paths: unknown) {
    if (isRuntimePaths(paths)) {
      this.filePath = join(paths.runtimeDir, QUEUE_FILE);
    } else {
      this.queue = new InMemoryQueue();
    }
  }

  async enqueue(taskId: string, status: QueueStatus = "queued", message?: string): Promise<QueueItem> {
    return this.upsert(taskId, status, message, false);
  }

  async update(taskId: string, status: QueueStatus, message?: string): Promise<QueueItem> {
    return this.upsert(taskId, status, message, true);
  }

  async pause(taskId: string, message = "paused by user"): Promise<QueueItem> {
    return this.update(taskId, "paused", message);
  }

  async resume(taskId: string, message = "ready to resume"): Promise<QueueItem> {
    return this.update(taskId, "planned", message);
  }

  async cancel(taskId: string, message = "cancelled by user"): Promise<QueueItem> {
    return this.update(taskId, "cancelled", message);
  }

  async list(): Promise<QueueItem[]> {
    if (this.queue) return this.queue.list();
    const state = await this.readState();
    return [...state.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async upsert(taskId: string, status: QueueStatus, message: string | undefined, updateExisting: boolean): Promise<QueueItem> {
    if (this.queue) return updateExisting ? this.queue.update(taskId, status, message) : this.queue.enqueue(taskId, status, message);

    const state = await this.readState();
    const existing = state.items.find((item) => item.taskId === taskId);
    const now = new Date().toISOString();
    if (existing) {
      existing.status = status;
      existing.updatedAt = now;
      existing.message = message;
      await this.writeState(state);
      return { ...existing };
    }
    const item: QueueItem = { taskId, status, createdAt: now, updatedAt: now, message };
    state.items.push(item);
    await this.writeState(state);
    return item;
  }

  private async readState(): Promise<QueueState> {
    if (!this.filePath) return { items: [] };
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<QueueState>;
      return { items: Array.isArray(parsed.items) ? parsed.items.filter(isQueueItem) : [] };
    } catch (error) {
      if (isFileMissing(error)) return { items: [] };
      throw error;
    }
  }

  private async writeState(state: QueueState): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify({ items: state.items }, null, 2)}\n`, "utf8");
  }
}

function isRuntimePaths(value: unknown): value is Pick<RuntimePaths, "runtimeDir"> {
  return typeof value === "object" && value !== null && typeof (value as { runtimeDir?: unknown }).runtimeDir === "string";
}

function isQueueItem(value: unknown): value is QueueItem {
  const item = value as QueueItem;
  return typeof item?.taskId === "string" && typeof item.status === "string" && typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

function isFileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
