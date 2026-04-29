import { readFile, writeFile } from "node:fs/promises";

export interface HeartbeatRecord {
  taskId: string;
  workerId: string;
  status: "running" | "completed" | "finished" | "failed" | "cancelled" | "stale" | "exited";
  timestamp?: string;
  checkedAt?: string;
  updatedAt?: string;
  lastOutputAt?: string;
  message?: string;
}

export interface StaleHeartbeatOptions {
  now?: Date;
  staleAfterMs: number;
}

export async function writeHeartbeat(filePath: string, heartbeat: HeartbeatRecord): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(heartbeat, null, 2)}\n`);
}

export async function readHeartbeat(filePath: string): Promise<HeartbeatRecord> {
  return JSON.parse(await readFile(filePath, "utf8")) as HeartbeatRecord;
}

export async function isHeartbeatStale(
  filePath: string,
  options: StaleHeartbeatOptions,
): Promise<boolean> {
  const heartbeat = await readHeartbeat(filePath);

  if (heartbeat.status !== "running") {
    return false;
  }

  const now = options.now ?? new Date();
  const rawTimestamp = heartbeat.timestamp ?? heartbeat.checkedAt ?? heartbeat.updatedAt ?? heartbeat.lastOutputAt;
  const timestamp = new Date(rawTimestamp ?? "");

  if (Number.isNaN(timestamp.getTime())) {
    return true;
  }

  return now.getTime() - timestamp.getTime() > options.staleAfterMs;
}
