import { randomUUID } from "node:crypto";

export function createTaskId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `task-${stamp}-${randomUUID().slice(0, 8)}`;
}

export function createWorkerId(provider: string, sequence = 1): string {
  return `${provider}-${sequence}`;
}
