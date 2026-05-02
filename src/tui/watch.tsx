import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useFocus, useInput, useStdout } from "ink";
import chalk from "chalk";
import { buildSnapshot, watchSnapshots, type AggregateSnapshot, type GlobalWorker } from "./runtime/aggregator.js";
import { buildProviderRows, type ProviderRow } from "./runtime/provider-limits.js";
import UsageLimitsPanel from "./components/UsageLimitsPanel.js";

const colors = {
  bg: "#0a0e14",
  green: "#4ade80",
  cyan: "#22d3ee",
  yellow: "#fbbf24",
  red: "#ef4444",
  magenta: "#c084fc",
  blue: "#60a5fa",
  dim: "#6b7280",
  orange: "#f97316",
  border: "#1f2937",
  white: "#e5e7eb",
};

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const h = React.createElement;

import type { WatchDashboardProps } from "./watch-props.js";

type LogLine = {
  id: number;
  text: string;
  color: string;
};

type Kpi = {
  label: string;
  value: string;
  delta: string;
  color: string;
};

type UiWorker = GlobalWorker & {
  uiId: string;
  uiTaskId: string;
  uiGoal: string;
  action: string;
  file: string;
  model: string;
  providerLabel: string;
  spawnedFrom: string;
  context: string;
};

const emptySnapshot = (): AggregateSnapshot => ({
  workers: [],
  counts: { workers: 0, active: 0, idle: 0, completed: 0, failed: 0, cancelled: 0, stale: 0 },
  totals: { tokensIn: 0, tokensOut: 0, totalTasks: 0 },
  byProject: {},
  byModel: {},
  generatedAt: new Date().toISOString(),
});

const formatTime = (date: Date) => date.toTimeString().slice(0, 8);
const formatUptime = (seconds: number) => {
  const hPart = Math.floor(seconds / 3600);
  const mPart = Math.floor((seconds % 3600) / 60);
  const sPart = seconds % 60;
  return `${hPart}h ${mPart}m ${sPart}s`;
};
const runtime = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  const hPart = Math.floor(seconds / 3600);
  const mPart = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const sPart = (seconds % 60).toString().padStart(2, "0");
  return hPart > 0 ? `${hPart}:${mPart}:${sPart}` : `${mPart}:${sPart}`;
};
const compact = (n: number | undefined) => {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
};
/** Renders a coarse relative timestamp ("now", "3s ago", "2m ago"...) for the heartbeat column. */
const formatRelative = (iso?: string): string => {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 2) return "now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const minutes = Math.floor(deltaSec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};
/** Formats RSS megabytes as `145M`/`1.2G`/`512K` for a 5-character column. */
const formatMem = (mb?: number): string => {
  if (mb === undefined || !Number.isFinite(mb)) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  if (mb >= 1) return `${Math.round(mb)}M`;
  return `${Math.round(mb * 1024)}K`;
};
const formatCpu = (cpu?: number): string => cpu === undefined || !Number.isFinite(cpu) ? "—" : `${cpu.toFixed(1)}%`;
const fit = (value: string, width: number) => value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value.padEnd(width);
const fitLeft = (value: string, width: number) => value.length > width ? `…${value.slice(-(Math.max(0, width - 1)))}` : value.padEnd(width);
const percent = (value: number, total: number) => total > 0 ? Math.round((value / total) * 100) : 0;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const sparkline = (values: number[]) => {
  const max = Math.max(...values, 1);
  return values.map((value) => blocks[Math.min(blocks.length - 1, Math.max(0, Math.floor((value / max) * (blocks.length - 1))))]).join("");
};
const workerKey = (worker: GlobalWorker) => `${worker.repoRoot}:${worker.taskId}:${worker.workerId}`;
const shortWorkerId = (worker: GlobalWorker) => worker.workerId === "—" ? "—" : worker.workerId.slice(0, 8);
/** Short stable slice of the registry taskId so users can grep logs / find the task on disk. */
const shortTaskId = (taskId: string | undefined) => !taskId ? "—" : taskId.slice(0, 10);
/** Single-line goal preview for table rows; longer goals get truncated with an ellipsis by `fit`. */
const goalPreview = (goal: string | undefined) => {
  if (!goal) return "—";
  return goal.replace(/\s+/g, " ").trim() || "—";
};
const basename = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
const actionFrom = (worker: GlobalWorker) => {
  switch (worker.status) {
    case "running": return "executing";
    case "queued": return "waiting";
    case "completed": return "done";
    case "failed": return "failed";
    case "paused": return "paused";
    case "stale": return "stale";
    case "cancelled": return "cancelled";
    default: return "—";
  }
};
const fileFrom = (worker: GlobalWorker) => worker.changedFiles?.[0] ?? "—";
const modelFrom = (worker: GlobalWorker) => worker.modelId ?? "—";
const providerFrom = (worker: GlobalWorker) => worker.provider ?? "—";
const contextFrom = (worker: GlobalWorker) => {
  const files = worker.changedFiles ?? [];
  if (files.length === 0) return "—";
  const kinds = new Set(files.map((file) => {
    if (/\.mdx?$/i.test(file)) return "docs";
    if (/\.(tsx?|jsx?)$/i.test(file)) return "codebase";
    return "mixed";
  }));
  if (kinds.size === 1 && kinds.has("docs")) return "docs";
  if (kinds.size === 1 && kinds.has("codebase")) return "codebase";
  return "mixed";
};
const toUiWorker = (worker: GlobalWorker): UiWorker => ({
  ...worker,
  uiId: shortWorkerId(worker),
  uiTaskId: shortTaskId(worker.taskId),
  uiGoal: goalPreview(worker.goal),
  action: actionFrom(worker),
  file: fileFrom(worker),
  model: modelFrom(worker),
  providerLabel: providerFrom(worker),
  spawnedFrom: worker.spawnedFromPath,
  context: contextFrom(worker),
});
const filterSnapshot = (snapshot: AggregateSnapshot, taskIdFilter: string | undefined): AggregateSnapshot => {
  if (!taskIdFilter) return snapshot;
  const workers = taskIdFilter ? snapshot.workers.filter((worker) => worker.taskId === taskIdFilter) : snapshot.workers;
  const counts = { workers: workers.length, active: 0, idle: 0, completed: 0, failed: 0, cancelled: 0, stale: 0 };
  const totals = { tokensIn: 0, tokensOut: 0, totalTasks: snapshot.totals.totalTasks };
  const byProject: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  for (const worker of workers) {
    if (worker.status === "running") counts.active += 1;
    if (worker.status === "completed") counts.completed += 1;
    if (worker.status === "failed") counts.failed += 1;
    if (worker.status === "cancelled") counts.cancelled += 1;
    if (worker.status === "stale") counts.stale += 1;
    totals.tokensIn += worker.tokensIn ?? 0;
    totals.tokensOut += worker.tokensOut ?? 0;
    byProject[worker.repoRoot] = (byProject[worker.repoRoot] ?? 0) + 1;
    byModel[worker.modelId ?? "unknown"] = (byModel[worker.modelId ?? "unknown"] ?? 0) + 1;
  }
  counts.idle = Math.max(0, counts.workers - counts.active - counts.completed - counts.failed);
  return { ...snapshot, workers, counts, totals, byProject, byModel };
};
const lineParts = (text: string, maxLines: number) => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > 34 && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  return lines.slice(0, maxLines);
};


const TOKEN_WINDOWS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "60s", ms: 60_000 },
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "45m", ms: 45 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "3h", ms: 3 * 60 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000 },
  { label: "12h", ms: 12 * 60 * 60_000 },
  { label: "1d", ms: 24 * 60 * 60_000 },
  { label: "1w", ms: 7 * 24 * 60 * 60_000 },
  { label: "1mo", ms: 30 * 24 * 60 * 60_000 },
  { label: "qtr", ms: 90 * 24 * 60 * 60_000 },
  { label: "6mo", ms: 180 * 24 * 60 * 60_000 },
  { label: "1y", ms: 365 * 24 * 60 * 60_000 },
];

const STATUS_LABEL: Record<string, [string, string]> = {
  running:   ["green",  "running"],
  queued:    ["yellow", "queued"],
  failed:    ["red",    "failed"],
  cancelled: ["red",    "cxl"],
  completed: ["dim",    "done"],
  paused:    ["dim",    "paused"],
  stale:     ["dim",    "stale"],
};
const STATUS_GLYPH: Record<string, string> = {
  running: "●", queued: "◐", failed: "●", cancelled: "●", completed: "✓", paused: "⏸", stale: "⏹",
};
const StatusText = ({ worker, spin }: { worker: UiWorker; spin: string }) => {
  const entry = STATUS_LABEL[worker.status] ?? ["dim", worker.status];
  const [colorKey, label] = entry;
  const color = colors[colorKey as keyof typeof colors] ?? colors.dim;
  const glyph = worker.status === "running" ? spin : STATUS_GLYPH[worker.status] ?? "●";
  return h(Text, { color }, `${glyph} ${label}`.padEnd(10));
};

const Progress = ({ worker, width = 12, spinIndex = 0 }: { worker: UiWorker; width?: number; spinIndex?: number }) => {
  const tag = (label: string) => label.slice(0, 6).padEnd(6);
  if (worker.status === "failed" || worker.status === "cancelled") return h(Text, { color: colors.red }, `${"X".repeat(width)} ${tag("failed")}`);
  if (worker.status === "queued") return h(Text, { color: colors.dim }, `${"░".repeat(width)} ${tag("queued")}`);
  if (worker.status === "completed") return h(Text, { color: colors.green }, `${"█".repeat(width)} ${tag("100%")}`);
  if (worker.status !== "running") return h(Text, { color: colors.dim }, `${"░".repeat(width)} ${tag(worker.status)}`);
  const head = spinIndex % width;
  const bar = Array.from({ length: width }, (_, index) => index === head ? "▓" : index === (head + width - 1) % width ? "▒" : "░").join("");
  return h(Text, { color: colors.green }, `${bar} live`);
};

const KpiBox = ({ kpi, width }: { kpi: Kpi; width: number }) => h(
  Box,
  { borderStyle: "single", borderColor: colors.border, width, height: 5, paddingX: 1, flexDirection: "column" },
  h(Text, { color: colors.dim }, fit(kpi.label, Math.max(1, width - 4))),
  h(Text, { color: kpi.color, bold: true }, fit(kpi.value, Math.max(1, width - 4))),
  h(Text, { color: kpi.color }, fit(kpi.delta, Math.max(1, width - 4))),
);

const TopBar = ({ now, uptimeSeconds, spinnerIndex, columns, intervalMs }: { now: Date; uptimeSeconds: number; spinnerIndex: number; columns: number; intervalMs: number }) => {
  const spin = spinnerFrames[spinnerIndex];
  const seconds = Math.max(1, Math.round(intervalMs / 1000));
  const right = `${formatTime(now)}  uptime ${formatUptime(uptimeSeconds)}  ● live`;
  const center = `${spin} syncing every ${seconds}s`;
  const left = `${spin} agent-os  REAL-TIME AGENT WORKER MONITOR`;
  const gap = Math.max(1, columns - left.length - center.length - right.length - 2);
  return h(
    Box,
    { height: 1 },
    h(Text, { color: colors.cyan }, left),
    h(Text, null, " ".repeat(Math.floor(gap / 2))),
    h(Text, { color: colors.dim }, center),
    h(Text, null, " ".repeat(Math.ceil(gap / 2))),
    h(Text, { color: colors.white }, right.replace("● live", "")),
    h(Text, { color: colors.green }, "● live"),
  );
};

const KpiRow = ({ snapshot, load, columns }: { snapshot: AggregateSnapshot; load: number[]; columns: number }) => {
  const idle = Math.max(0, snapshot.counts.workers - snapshot.counts.active - snapshot.counts.completed - snapshot.counts.failed);
  const activePct = percent(snapshot.counts.active, snapshot.counts.workers);
  const idlePct = percent(idle, snapshot.counts.workers);
  const kpis: Kpi[] = [
    { label: "WORKERS", value: compact(snapshot.counts.workers), delta: "all repos", color: colors.cyan },
    { label: "ACTIVE", value: compact(snapshot.counts.active), delta: `${activePct}% live`, color: colors.cyan },
    { label: "IDLE", value: compact(idle), delta: `${idlePct}% queued`, color: colors.yellow },
    { label: "COMPLETED", value: compact(snapshot.counts.completed), delta: "lifetime", color: colors.green },
    { label: "FAILED", value: compact(snapshot.counts.failed), delta: "lifetime", color: colors.red },
    { label: "CANCELLED", value: compact(snapshot.counts.cancelled), delta: "lifetime", color: colors.dim },
    { label: "TOKENS IN", value: compact(snapshot.totals.tokensIn), delta: "all tasks", color: colors.magenta },
    { label: "TOKENS OUT", value: compact(snapshot.totals.tokensOut), delta: "all tasks", color: colors.cyan },
    { label: "TOTAL TASKS", value: compact(snapshot.totals.totalTasks), delta: "registry", color: colors.blue },
  ];
  const sparkWidth = Math.max(18, Math.min(68, Math.floor(columns * 0.22)));
  const width = Math.max(11, Math.floor((columns - sparkWidth - 1) / 9));
  return h(
    Box,
    { height: 5 },
    ...kpis.map((kpi) => h(KpiBox, { key: kpi.label, kpi, width })),
    h(
      Box,
      { borderStyle: "single", borderColor: colors.border, width: sparkWidth, height: 5, paddingX: 1, flexDirection: "column" },
      h(Text, { color: colors.dim }, "SYSTEM LOAD"),
      h(Text, { color: colors.orange }, fit(sparkline(load), Math.max(1, sparkWidth - 4))),
      h(Text, { color: colors.green }, `${activePct}%`),
    ),
  );
};

const WINDOW_SIZE = 10;

const WorkerTable = ({ workers, selected, columns, spinnerIndex, scrollOffset }: { workers: UiWorker[]; selected: number; columns: number; spinnerIndex: number; scrollOffset: number }) => {
  const rows = workers.slice(scrollOffset, scrollOffset + WINDOW_SIZE);
  const fileW = Math.max(12, Math.floor(columns * 0.08));
  const goalW = Math.max(20, Math.floor(columns * 0.18));
  const workerW = 9;
  const taskW = 11;
  const providerW = 9;
  const modelW = 16;
  const spin = spinnerFrames[(spinnerIndex + 2) % spinnerFrames.length];
  const overflow = workers.length > WINDOW_SIZE;
  const lastVisible = Math.min(workers.length, scrollOffset + rows.length);
  return h(
    Box,
    { borderStyle: "double", borderColor: colors.border, height: 15, flexDirection: "column", paddingX: 1 },
    h(Text, { color: colors.orange, bold: true }, "ACTIVE WORKERS"),
    h(Box, null, h(Text, { color: colors.cyan, bold: true }, `${fit("STATUS", 10)} ${fit("WORKER", workerW)} ${fit("TASK", taskW)} ${fit("GOAL", goalW)} ${fit("FILE/TARGET", fileW)} ${fit("PROVIDER", providerW)} ${fit("MODEL", modelW)} ${fit("TOKENS IN", 10)} ${fit("TOKENS OUT", 11)} ${fit("RUNTIME", 8)} ${fit("LAST ACT", 9)} ${fit("CPU", 5)} ${fit("MEM", 5)} PROGRESS`)),
    ...rows.map((worker, absoluteIndex) => {
      const index = scrollOffset + absoluteIndex;
      const rowBg = index === selected ? colors.border : undefined;
      return h(
        Box,
        { key: workerKey(worker) },
        h(Box, { width: 10 }, h(StatusText, { worker, spin })),
        h(Text, { color: colors.white, backgroundColor: rowBg }, ` ${fit(worker.uiId, workerW)} `),
        h(Text, { color: colors.dim, backgroundColor: rowBg }, `${fit(worker.uiTaskId, taskW)} `),
        h(Text, { backgroundColor: rowBg }, `${fit(worker.uiGoal, goalW)} ${fit(worker.file, fileW)} ${fit(worker.providerLabel, providerW)} ${fit(worker.model, modelW)} ${fit(compact(worker.tokensIn), 10)} ${fit(compact(worker.tokensOut), 11)} ${fit(runtime(worker.runtimeMs), 8)} ${fit(formatRelative(worker.lastHeartbeatAt), 9)} ${fit(formatCpu(worker.cpuPercent), 5)} ${fit(formatMem(worker.rssMb), 5)} `),
        h(Progress, { worker, width: 10, spinIndex: spinnerIndex }),
      );
    }),
    overflow
      ? h(Text, { color: colors.dim }, `[ showing ${scrollOffset + 1}–${lastVisible} of ${workers.length}  •  ↑↓ PgUp/PgDn g/G ]`)
      : null,
  );
};

const WorkerDetails = ({ worker, spinnerIndex }: { worker: UiWorker | undefined; spinnerIndex: number }) => {
  if (!worker) {
    return h(
      Box,
      { borderStyle: "double", borderColor: colors.border, flexDirection: "column", paddingX: 1, width: "25%", minWidth: 34 },
      h(Text, { color: colors.orange, bold: true }, "WORKER DETAILS"),
      h(Text, { color: colors.dim }, "← / → to navigate workers"),
      h(Text, { color: colors.dim }, "No worker selected"),
    );
  }
  const promptLines = lineParts(worker.goal || "—", 4);
  const files = worker.changedFiles ?? [];
  return h(
    Box,
    { borderStyle: "double", borderColor: colors.border, flexDirection: "column", paddingX: 1, width: "25%", minWidth: 34 },
    h(Text, { color: colors.orange, bold: true }, "WORKER DETAILS"),
    h(Text, { color: colors.dim }, "← / → to navigate"),
    h(Text, null, "Worker: ", h(Text, { color: colors.cyan }, worker.uiId)),
    h(Text, null, "Task: ", h(Text, { color: colors.dim }, worker.uiTaskId)),
    h(Text, null, "Status: ", h(StatusText, { worker, spin: worker.status === "running" ? "●" : "◐" })),
    h(Text, null, `Action: ${worker.action}`),
    h(Text, null, `File: ${fit(worker.file, 28)}`),
    h(Text, null, `Provider: ${worker.providerLabel}`),
    h(Text, null, `Model: ${worker.model}`),
    h(Text, null, `Spawned from: ${fitLeft(worker.spawnedFrom, 22)}`),
    h(Text, null, `Context: ${worker.context}`),
    h(Text, null, "Tokens In: ", h(Text, { color: colors.magenta }, compact(worker.tokensIn))),
    h(Text, null, "Tokens Out: ", h(Text, { color: colors.cyan }, compact(worker.tokensOut))),
    h(Text, null, `Runtime: ${runtime(worker.runtimeMs)}`),
    h(Text, null, `Goal: ${fit(worker.uiGoal, 28)}`),
    h(Box, null, h(Progress, { worker, width: 18, spinIndex: spinnerIndex })),
    h(Text, { color: colors.orange }, "Current Prompt / Context:"),
    h(Box, { borderStyle: "single", borderColor: colors.border, paddingX: 1, flexDirection: "column" }, ...promptLines.map((line, index) => h(Text, { key: index, color: colors.white }, line))),
    h(Text, { color: colors.orange }, "Files in context:"),
    ...files.slice(0, 4).map((file) => h(Text, { key: file, color: colors.dim }, `• ${fit(file, 30)}`)),
    files.length > 4 ? h(Text, { color: colors.dim }, `... and ${files.length - 4} more`) : null,
  );
};

const ActivityLog = ({ logs }: { logs: LogLine[] }) => h(
  Box,
  { borderStyle: "double", borderColor: colors.border, flexDirection: "column", paddingX: 1, flexGrow: 1 },
  h(Text, { color: colors.orange, bold: true }, "REAL-TIME ACTIVITY LOG"),
  h(Text, { color: colors.dim }, "..."),
  ...logs.slice(0, 14).map((line) => h(Text, { key: line.id, color: line.color }, line.text)),
);

const TokenPanel = ({ tokensIn, tokensOut, windowLabel, windowMs, snapshot }: { tokensIn: number[]; tokensOut: number[]; windowLabel: string; windowMs: number; snapshot: AggregateSnapshot }) => {
  const inRate = tokensIn.at(-1) ?? 0;
  const outRate = tokensOut.at(-1) ?? 0;
  const cutoff = Date.now() - windowMs;
  let winIn = 0;
  let winOut = 0;
  for (const w of snapshot.workers) {
    const ts = Date.parse(w.startedAt);
    if (Number.isFinite(ts) && ts >= cutoff) {
      winIn += w.tokensIn ?? 0;
      winOut += w.tokensOut ?? 0;
    }
  }
  return h(
    Box,
    { borderStyle: "single", borderColor: colors.border, flexDirection: "column", paddingX: 1, height: 6 },
    h(Text, { color: colors.orange, bold: true }, "TOKEN USAGE ", h(Text, { color: colors.dim }, `(${windowLabel})`)),
    h(Text, { color: colors.dim }, "[ / ] change window"),
    h(Text, null, h(Text, { color: colors.magenta }, `In  ${compact(winIn)}`), h(Text, { color: colors.dim }, "  "), h(Text, { color: colors.cyan }, `Out ${compact(winOut)}`)),
    h(Box, null, h(Text, { color: colors.magenta }, fit(`In  ${sparkline(tokensIn)}`, 40)), h(Text, { color: colors.magenta }, `In: ${compact(inRate)} tok/s`)),
    h(Box, null, h(Text, { color: colors.cyan }, fit(`Out ${sparkline(tokensOut)}`, 40)), h(Text, { color: colors.cyan }, `Out: ${compact(outRate)} tok/s`)),
  );
};

const ModelPanel = ({ byModel }: { byModel: Record<string, number> }) => {
  const entries = Object.entries(byModel).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const palette = [colors.cyan, colors.blue, colors.magenta];
  return h(
    Box,
    { borderStyle: "single", borderColor: colors.border, flexDirection: "column", paddingX: 1, height: 8 },
    h(Text, { color: colors.orange, bold: true }, "MODEL USAGE"),
    h(Text, { color: colors.cyan }, "   ◜██◝"),
    h(Text, { color: colors.magenta }, "   ◟██◞"),
    ...entries.map(([model, count], index) => h(Text, { key: model }, h(Text, { color: palette[index] }, "■"), ` ${fit(model, 18)} ${percent(count, total)}% (${count})`)),
  );
};

const ProjectsPanel = ({ byProject }: { byProject: Record<string, number> }) => {
  const entries = Object.entries(byProject).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const palette = [colors.green, colors.cyan, colors.yellow, colors.blue];
  return h(
    Box,
    { borderStyle: "single", borderColor: colors.border, flexDirection: "column", paddingX: 1, flexGrow: 1 },
    h(Text, { color: colors.orange, bold: true }, "TOP PROJECTS"),
    ...entries.map(([project, count], index) => {
      const pct = percent(count, total);
      const filled = clamp(Math.round(pct / 10), 0, 10);
      return h(Text, { key: project }, h(Text, { color: palette[index] }, `${"█".repeat(filled)}${"░".repeat(10 - filled)}`), ` ${fitLeft(project, 28)} ${pct}% (${count})`);
    }),
  );
};

const RightColumn = ({ snapshot, tokensIn, tokensOut, providerRows, tokenWindowLabel, tokenWindowMs }: { snapshot: AggregateSnapshot; tokensIn: number[]; tokensOut: number[]; providerRows: ProviderRow[]; tokenWindowLabel: string; tokenWindowMs: number }) => h(
  Box,
  { flexDirection: "column", width: "30%", minWidth: 56 },
  h(TokenPanel, { tokensIn, tokensOut, windowLabel: tokenWindowLabel, windowMs: tokenWindowMs, snapshot }),
  h(ModelPanel, { byModel: snapshot.byModel }),
  h(ProjectsPanel, { byProject: snapshot.byProject }),
  h(UsageLimitsPanel, { rows: providerRows }),
);

const Footer = ({ columns, paused }: { columns: number; paused: boolean }) => {
  const text = `q Quit  ←/→ Worker  [/] Window  r Refresh  s Sort  p ${paused ? "Resume" : "Pause"}  ? Help    Auto-refresh: ${paused ? "PAUSED" : "ON"}`;
  return h(Box, { height: 1 }, h(Text, { color: colors.dim }, text.padStart(columns)));
};

const EmptyState = () => h(
  Box,
  { borderStyle: "double", borderColor: colors.border, height: 15, alignItems: "center", justifyContent: "center" },
  h(Text, { color: colors.dim }, "No active agent-os workers found in any registered repo. Run agent-os task run somewhere to see live activity."),
);

const logChanges = (previous: Map<string, GlobalWorker>, workers: GlobalWorker[]): LogLine[] => {
  const stamp = formatTime(new Date());
  const lines: LogLine[] = [];
  for (const worker of workers) {
    const previousWorker = previous.get(workerKey(worker));
    if (!previousWorker) {
      lines.push({ id: Date.now() + lines.length, color: colors.cyan, text: `${stamp} [W-${shortWorkerId(worker)}] spawned ${basename(fileFrom(worker))} (${modelFrom(worker)})` });
      continue;
    }
    if (previousWorker.status !== worker.status) {
      const action = worker.status === "completed" ? "completed" : `${previousWorker.status}->${worker.status}`;
      const color = worker.status === "failed" || worker.status === "cancelled" ? colors.red : worker.status === "completed" ? colors.green : colors.yellow;
      lines.push({ id: Date.now() + lines.length, color, text: `${stamp} [W-${shortWorkerId(worker)}] ${action} ${basename(fileFrom(worker))} (${modelFrom(worker)})` });
    }
  }
  return lines;
};

/** Renders the live agent-os global worker dashboard from aggregator snapshots. */
export default function WatchDashboard({ intervalMs, taskIdFilter }: WatchDashboardProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { isFocused } = useFocus({ autoFocus: true });
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(() => new Date());
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [snapshot, setSnapshot] = useState<AggregateSnapshot>(() => emptySnapshot());
  const [providerRows, setProviderRows] = useState<ProviderRow[]>([]);
  const [paused, setPaused] = useState<boolean>(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);
  const [sortMode, setSortMode] = useState<"default" | "runtime" | "tokens" | "status" | "model">("default");
  const [tokenWindowIdx, setTokenWindowIdx] = useState<number>(0);
  const [selected, setSelected] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [size, setSize] = useState({ columns: stdout.columns ?? 160, rows: stdout.rows ?? 48 });
  const [load, setLoad] = useState<number[]>(() => Array.from({ length: 60 }, () => 0));
  const [tokensIn, setTokensIn] = useState<number[]>(() => Array.from({ length: 60 }, () => 0));
  const [tokensOut, setTokensOut] = useState<number[]>(() => Array.from({ length: 60 }, () => 0));
  const [logs, setLogs] = useState<LogLine[]>([]);
  const previousWorkers = useRef<Map<string, GlobalWorker>>(new Map());
  const previousTotals = useRef({ tokensIn: 0, tokensOut: 0 });
  const hasUserSelection = useRef(false);

  useEffect(() => {
    const spinnerTimer = setInterval(() => setSpinnerIndex((value) => (value + 1) % spinnerFrames.length), 80);
    const clockTimer = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(spinnerTimer);
      clearInterval(clockTimer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void watchSnapshots({ intervalMs }, (next) => {
      if (active && !paused) setSnapshot(next);
    }).then((handle) => {
      stop = handle.stop;
      if (!active) stop();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [intervalMs, paused]);

  useEffect(() => {
    let active = true;
    const tick = async () => { try { const r = await buildProviderRows(); if (active) setProviderRows(r); } catch {} };
    void tick();
    const t = setInterval(() => { void tick(); }, Math.max(5000, intervalMs * 5));
    return () => { active = false; clearInterval(t); };
  }, [intervalMs]);

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns ?? 160, rows: stdout.rows ?? 48 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const visibleSnapshot = useMemo(() => filterSnapshot(snapshot, taskIdFilter), [snapshot, taskIdFilter]);
  const workers = useMemo(() => visibleSnapshot.workers.map(toUiWorker), [visibleSnapshot.workers]);

  useEffect(() => {
    setLoad((values) => [...values.slice(1), visibleSnapshot.counts.active]);
    setTokensIn((values) => [...values.slice(1), Math.max(0, visibleSnapshot.totals.tokensIn - previousTotals.current.tokensIn)]);
    setTokensOut((values) => [...values.slice(1), Math.max(0, visibleSnapshot.totals.tokensOut - previousTotals.current.tokensOut)]);
    previousTotals.current = { tokensIn: visibleSnapshot.totals.tokensIn, tokensOut: visibleSnapshot.totals.tokensOut };
    const isFirst = previousWorkers.current.size === 0;
    const changes = isFirst ? [] : logChanges(previousWorkers.current, visibleSnapshot.workers);
    previousWorkers.current = new Map(visibleSnapshot.workers.map((worker) => [workerKey(worker), worker]));
    if (changes.length) setLogs((items) => [...changes, ...items].slice(0, 200));
  }, [visibleSnapshot]);

  useEffect(() => {
    const maxOffset = Math.max(0, workers.length - WINDOW_SIZE);
    setScrollOffset((value) => Math.max(0, Math.min(maxOffset, value)));
  }, [workers.length]);

  useEffect(() => {
    setSelected((value) => {
      if (workers.length === 0) return 0;
      if (!hasUserSelection.current) {
        const runningIndex = workers.findIndex((worker) => worker.status === "running");
        return runningIndex >= 0 ? runningIndex : 0;
      }
      return Math.min(value, workers.length - 1);
    });
  }, [workers]);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 1000);
    return () => clearTimeout(timer);
  }, [toast]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    const maxOffset = Math.max(0, workers.length - WINDOW_SIZE);
    const clampOffset = (next: number) => Math.max(0, Math.min(maxOffset, next));
    if (key.upArrow) {
      setScrollOffset((value) => clampOffset(value - 1));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((value) => clampOffset(value + 1));
      return;
    }
    if (key.pageUp) {
      setScrollOffset((value) => clampOffset(value - WINDOW_SIZE));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((value) => clampOffset(value + WINDOW_SIZE));
      return;
    }
    if (input === "g") {
      setScrollOffset(0);
      return;
    }
    if (input === "G") {
      setScrollOffset(maxOffset);
      return;
    }
    if (input === "l" || key.rightArrow) {
      hasUserSelection.current = true;
      setSelected((value) => Math.min(Math.max(0, workers.length - 1), value + 1));
      return;
    }
    if (input === "h" || key.leftArrow) {
      hasUserSelection.current = true;
      setSelected((value) => Math.max(0, value - 1));
      return;
    }
    if (input === "r") {
      void buildSnapshot().then(setSnapshot);
      setToast("refreshing…");
      return;
    }
    if (input === "p") {
      setPaused((v) => !v);
      setToast(paused ? "resumed" : "paused");
      return;
    }
    if (input === "?") {
      setHelpOpen((v) => !v);
      setToast(helpOpen ? "" : "←/→ worker | [/] window | r refresh | s sort | p pause | q quit | ? help");
      return;
    }
    if (input === "s") {
      const order: Array<"default" | "runtime" | "tokens" | "status" | "model"> = ["default", "runtime", "tokens", "status", "model"];
      setSortMode((cur) => order[(order.indexOf(cur) + 1) % order.length] ?? "default");
      setToast(`sort: ${sortMode}`);
      return;
    }
    if (input === "[") {
      setTokenWindowIdx((v) => Math.max(0, v - 1));
      setToast(`window: ${TOKEN_WINDOWS[Math.max(0, tokenWindowIdx - 1)]!.label}`);
      return;
    }
    if (input === "]") {
      setTokenWindowIdx((v) => Math.min(TOKEN_WINDOWS.length - 1, v + 1));
      setToast(`window: ${TOKEN_WINDOWS[Math.min(TOKEN_WINDOWS.length - 1, tokenWindowIdx + 1)]!.label}`);
      return;
    }
    if (input === "d") {
      setToast(selectedWorker ? `details: ${selectedWorker.taskId.slice(-12)}` : "no worker");
      return;
    }
    if (["f", "t", "m"].includes(input)) setToast(`${input}: not yet implemented (coming next)`);
  });

  const selectedWorker = workers[selected] ?? workers[0];
  const topHeight = 1;
  const kpiHeight = 5;
  const tableHeight = 15;
  const footerHeight = 1;
  const bottomHeight = Math.max(20, size.rows - topHeight - kpiHeight - tableHeight - footerHeight);
  const focusedBorder = useMemo(() => isFocused ? colors.border : colors.dim, [isFocused]);
  const styleProbe = chalk.hex(colors.green)("●");

  return h(
    Box,
    { flexDirection: "column", width: size.columns, height: size.rows },
    h(TopBar, { now, uptimeSeconds: Math.floor((Date.now() - start) / 1000), spinnerIndex, columns: size.columns, intervalMs }),
    h(KpiRow, { snapshot: visibleSnapshot, load, columns: size.columns }),
    workers.length === 0 ? h(EmptyState) : h(WorkerTable, { workers, selected, columns: size.columns, spinnerIndex, scrollOffset }),
    h(
      Box,
      { height: bottomHeight, borderColor: focusedBorder },
      h(WorkerDetails, { worker: selectedWorker, spinnerIndex }),
      h(ActivityLog, { logs }),
      h(RightColumn, { snapshot: visibleSnapshot, tokensIn, tokensOut, providerRows, tokenWindowLabel: TOKEN_WINDOWS[tokenWindowIdx]!.label, tokenWindowMs: TOKEN_WINDOWS[tokenWindowIdx]!.ms }),
    ),
    h(Footer, { columns: size.columns, paused }),
    toast === null ? null : h(Box, { alignSelf: "flex-end", borderStyle: "single", borderColor: colors.orange, paddingX: 1 }, h(Text, { color: colors.orange }, `${toast} ${styleProbe}`)),
  );
}
