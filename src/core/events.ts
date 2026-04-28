import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventRecord, RuntimePaths } from "./types.js";

export function eventsPath(taskDir: string): string {
  return join(taskDir, "events.ndjson");
}

export async function appendEvent(
  taskDirOrPaths: string | RuntimePaths,
  eventOrTaskId: (Omit<EventRecord, "timestamp"> & Partial<Pick<EventRecord, "timestamp">>) | string | undefined,
  maybeEvent?: Omit<EventRecord, "timestamp" | "taskId">,
): Promise<EventRecord> {
  const taskDirValue =
    typeof taskDirOrPaths === "string"
      ? taskDirOrPaths
      : eventOrTaskId
        ? join(taskDirOrPaths.tasksDir, String(eventOrTaskId))
        : taskDirOrPaths.runtimeDir;
  const event =
    typeof taskDirOrPaths === "string"
      ? (eventOrTaskId as Omit<EventRecord, "timestamp"> & Partial<Pick<EventRecord, "timestamp">>)
      : ({ ...maybeEvent, taskId: eventOrTaskId } as Omit<EventRecord, "timestamp"> & Partial<Pick<EventRecord, "timestamp">>);
  const record: EventRecord = {
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...event,
  };
  const path = eventsPath(taskDirValue);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  return record;
}

export async function readEvents(taskDir: string): Promise<EventRecord[]> {
  try {
    const content = await readFile(eventsPath(taskDir), "utf8");
    return content.split(/\n+/).filter(Boolean).map((line) => JSON.parse(line) as EventRecord);
  } catch {
    return [];
  }
}

export async function readTaskEvents(paths: RuntimePaths, taskId: string): Promise<EventRecord[]> {
  return readEvents(join(paths.tasksDir, taskId));
}
