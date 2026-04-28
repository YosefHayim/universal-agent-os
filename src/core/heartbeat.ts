import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Heartbeat {
  workerId: string;
  updatedAt: string;
}

export async function writeHeartbeat(path: string, workerId: string): Promise<Heartbeat> {
  const heartbeat = { workerId, updatedAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
  return heartbeat;
}

export async function isHeartbeatStale(path: string, ttlMs: number): Promise<boolean> {
  try {
    const heartbeat = JSON.parse(await readFile(path, "utf8")) as Heartbeat;
    return Date.now() - Date.parse(heartbeat.updatedAt) > ttlMs;
  } catch {
    return true;
  }
}
