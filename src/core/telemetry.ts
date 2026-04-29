import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderId, ProviderUsage, RuntimePaths } from "./types.js";

type TelemetryAttribute = string | number | boolean | null;

export interface TelemetrySpanInput {
  taskId?: string;
  provider?: ProviderId;
  workerId?: string;
  name: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  usage?: ProviderUsage;
  attributes?: Record<string, TelemetryAttribute | undefined>;
}

export interface TelemetrySpanRecord {
  timestamp: string;
  traceId: string;
  spanId: string;
  name: string;
  taskId?: string;
  provider?: ProviderId;
  workerId?: string;
  startedAt: string;
  endedAt: string;
  durationMs?: number;
  usage?: ProviderUsage;
  attributes: Record<string, TelemetryAttribute>;
}

export function telemetryPath(paths: RuntimePaths): string {
  return join(paths.runtimeDir, "telemetry.ndjson");
}

export async function appendTelemetrySpan(paths: RuntimePaths, input: TelemetrySpanInput): Promise<TelemetrySpanRecord> {
  const endedAt = input.endedAt ?? new Date().toISOString();
  const startedAt = input.startedAt ?? endedAt;
  const attributes = compactAttributes({
    "agent_os.task.id": input.taskId,
    "agent_os.provider": input.provider,
    "agent_os.worker.id": input.workerId,
    ...input.attributes,
  });
  const record: TelemetrySpanRecord = {
    timestamp: endedAt,
    traceId: input.taskId ?? randomUUID(),
    spanId: randomUUID(),
    name: input.name,
    taskId: input.taskId,
    provider: input.provider,
    workerId: input.workerId,
    startedAt,
    endedAt,
    durationMs: input.durationMs,
    usage: input.usage,
    attributes,
  };
  const path = telemetryPath(paths);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function compactAttributes(attributes: Record<string, TelemetryAttribute | undefined>): Record<string, TelemetryAttribute> {
  return Object.fromEntries(Object.entries(attributes).filter((entry): entry is [string, TelemetryAttribute] => entry[1] !== undefined));
}
