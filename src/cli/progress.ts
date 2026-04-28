import type { TaskRunProgress } from "../core/controller.js";
import type { ProviderUsage } from "../core/types.js";
import { formatUsageLine } from "../usage/usage.js";

const TAG = "[universal-agent-os]";

export function writeAgentOsProgress(event: TaskRunProgress): void {
  const line = formatAgentOsProgress(event);
  if (line) process.stderr.write(`${line}\n`);
}

export function formatAgentOsProgress(event: TaskRunProgress): string {
  const task = event.taskId ? `task ${event.taskId}: ` : "";
  if (event.event === "context_compiled") {
    return `${TAG} ${task}context saved (${event.selectedFiles.length} files) -> ${event.bundlePath}`;
  }
  if (event.event === "route_selected") {
    return `${TAG} ${task}route selected: ${event.provider}${event.model ? ` / ${event.model}` : ""}${event.message ? ` (${truncate(event.message, 180)})` : ""}`;
  }

  const worker = `${event.provider}/${event.workerId}`;
  if (event.event === "worker_prepared") {
    return `${TAG} ${task}${worker} workspace ready${event.message ? ` -> ${event.message}` : ""}`;
  }
  if (event.event === "worker_launching") {
    return `${TAG} ${task}${worker} launched${event.message ? `: ${truncate(event.message, 180)}` : ""}`;
  }
  if (event.event === "provider_output" || event.event === "provider_error_output") {
    return event.message ? `${TAG} ${task}${worker}: ${truncate(event.message, 180)}` : "";
  }
  if (event.event === "worker_exited") {
    return `${TAG} ${task}${worker} exited after ${formatDuration(event.durationMs)}`;
  }
  if (event.event === "diff_captured") {
    return `${TAG} ${task}${worker} ${event.message ?? "diff captured"}`;
  }
  if (event.event === "worker_finished") {
    return `${TAG} ${task}${worker} finished - ${formatUsage(event.usage)}`;
  }
  return "";
}

function formatDuration(value: number | undefined): string {
  const ms = value ?? 0;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatUsage(value: ProviderUsage | undefined): string {
  return value ? formatUsageLine(value) : "usage unavailable";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}
