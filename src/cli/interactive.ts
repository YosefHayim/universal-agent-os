import { confirm, input, password, select } from "@inquirer/prompts";
import { DEFAULT_PROVIDERS, DIRECT_LAUNCH_PROVIDERS, PROVIDER_CREDENTIAL_ENV_VARS } from "../config/defaults.js";
import { Controller, type TaskRunProgress } from "../core/controller.js";
import type { ModelCatalogEntry, ProviderAvailability, ProviderId, RiskLevel } from "../core/types.js";
import { formatUsageLine, type UsageSummaryRow } from "../usage/usage.js";
import { printTable } from "./format.js";
import { formatAgentOsProgress } from "./progress.js";
import { parseCsv } from "./prompts.js";

export type MainAction =
  | "status"
  | "upgrade"
  | "create-task"
  | "dry-run"
  | "run"
  | "validate"
  | "review"
  | "accept"
  | "reject"
  | "task-status"
  | "task-logs"
  | "queue-status"
  | "usage"
  | "models-refresh"
  | "models-list"
  | "provider-status"
  | "provider-credentials"
  | "set-provider"
  | "quit";

export async function runInteractive(controller = new Controller()): Promise<void> {
  console.log("Agent OS");
  console.log(`Project: ${controller.paths.rootDir}`);
  let running = true;
  while (running) {
    const action = await select<MainAction>({
      message: "Choose an action",
      choices: [
        { name: "Status", value: "status" },
        { name: "Upgrade runtime", value: "upgrade" },
        { name: "Create + run task", value: "create-task" },
        { name: "Dry-run task", value: "dry-run" },
        { name: "Run existing task", value: "run" },
        { name: "Validate task", value: "validate" },
        { name: "Review task", value: "review" },
        { name: "Accept task", value: "accept" },
        { name: "Reject task", value: "reject" },
        { name: "Task status", value: "task-status" },
        { name: "Task logs", value: "task-logs" },
        { name: "Queue status", value: "queue-status" },
        { name: "Usage summary", value: "usage" },
        { name: "Refresh models", value: "models-refresh" },
        { name: "List models", value: "models-list" },
        { name: "Provider status", value: "provider-status" },
        { name: "Provider API keys", value: "provider-credentials" },
        { name: "Set provider status", value: "set-provider" },
        { name: "Quit", value: "quit" },
      ],
    });
    try {
      if (action === "quit") running = false;
      else await runAction(controller, action);
    } catch (error) {
      console.error(`[agent-os] ${error instanceof Error ? error.message : String(error)}`);
    }
    if (running) await input({ message: "Press Enter to continue" });
  }
}

export async function runAction(controller: Controller, action: MainAction): Promise<void> {
  if (action === "status") {
    printRuntimeStatus(await controller.status());
    await showProviderHealth(controller);
    return;
  }
  if (action === "upgrade") {
    printTaskAction("Runtime upgrade", await controller.upgrade());
    return;
  }
  if (action === "create-task") {
    await createTask(controller);
    return;
  }
  if (action === "dry-run") {
    await routeTask(controller, false);
    return;
  }
  if (action === "run") {
    await routeTask(controller, true);
    return;
  }
  if (action === "validate") {
    const taskId = await chooseTask(controller);
    if (taskId) printValidationResult(await controller.taskValidate(taskId));
    return;
  }
  if (action === "review") {
    const taskId = await chooseTask(controller);
    if (taskId) printTaskAction("Review packet", await controller.taskReview(taskId));
    return;
  }
  if (action === "accept") {
    const taskId = await chooseTask(controller);
    if (taskId) printTaskAction("Accept", await controller.taskAccept(taskId));
    return;
  }
  if (action === "reject") {
    const taskId = await chooseTask(controller);
    if (taskId) printTaskAction("Reject", await controller.taskReject(taskId));
    return;
  }
  if (action === "task-status") {
    const taskId = await chooseTask(controller);
    if (taskId) printTaskDetails(await controller.taskStatus(taskId));
    return;
  }
  if (action === "task-logs") {
    const taskId = await chooseTask(controller);
    if (taskId) await showTaskLogs(controller, taskId);
    return;
  }
  if (action === "queue-status") {
    printQueueStatus(await controller.queueStatus());
    return;
  }
  if (action === "usage") {
    await showUsageSummary(controller);
    return;
  }
  if (action === "models-refresh") {
    await refreshModels(controller);
    return;
  }
  if (action === "models-list") {
    await listModels(controller);
    return;
  }
  if (action === "provider-status") {
    await showProviderHealth(controller);
    return;
  }
  if (action === "provider-credentials") {
    await manageProviderCredentials(controller);
    return;
  }
  if (action === "set-provider") {
    await setProvider(controller);
  }
}

async function createTask(controller: Controller): Promise<void> {
  const goal = await input({ message: "Task goal", required: true });
  const allowedFiles = await input({ message: "Allowed files, comma-separated", default: "**/*" });
  const risk = await select<RiskLevel>({
    message: "Risk",
    choices: [
      { name: "low", value: "low" },
      { name: "medium", value: "medium" },
      { name: "high", value: "high" },
    ],
    default: "medium",
  });
  const created = await controller.taskCreate(goal.trim(), { allowedFiles: parseCsv(allowedFiles), risk });
  printTaskCreated(created);
  const taskId = String((created as { taskId?: unknown }).taskId ?? (created as { id?: unknown }).id ?? "");
  if (!taskId) return;
  const runNow = await confirm({ message: "Run now?", default: true });
  if (runNow) await routeTask(controller, true, taskId);
}

async function routeTask(controller: Controller, execute: boolean, selectedTaskId?: string): Promise<void> {
  const taskId = selectedTaskId ?? await chooseTask(controller);
  if (!taskId) return;
  const provider = await chooseProvider("Provider", controller);
  const modelId = await chooseModel(controller, provider);
  if (execute) {
    const direct = DIRECT_LAUNCH_PROVIDERS.includes(provider);
    const proceed = await confirm({
      message: direct ? `Run ${provider} now${modelId ? ` with ${modelId}` : ""}?` : `Run ${provider}? This provider is catalog-only until smoke activation.`,
      default: direct,
    });
    if (!proceed) return;
    await runTaskWithLiveOutput(controller, taskId, provider, modelId);
    return;
  }
  printDryRunResult(await controller.taskDryRun(taskId, provider, modelId));
}

async function refreshModels(controller: Controller): Promise<void> {
  const provider = await select<ProviderId | "all">({
    message: "Refresh provider",
    choices: [
      { name: "all providers", value: "all" },
      ...DEFAULT_PROVIDERS.map((value) => ({ name: value, value })),
    ],
  });
  printModelsRefresh(await controller.modelsRefresh(provider === "all" ? undefined : provider));
}

async function listModels(controller: Controller): Promise<void> {
  const provider = await select<ProviderId | "all">({
    message: "Provider",
    choices: [
      { name: "all providers", value: "all" },
      ...DEFAULT_PROVIDERS.map((value) => ({ name: value, value })),
    ],
  });
  const coding = await confirm({ message: "Coding models only?", default: true });
  const free = await confirm({ message: "Free/free-quota only?", default: false });
  const entries = await controller.modelsList({
    provider: provider === "all" ? undefined : provider,
    coding,
    free,
  });
  printModelRows(entries);
}

async function setProvider(controller: Controller): Promise<void> {
  const provider = await chooseProvider("Provider", controller);
  const availability = await select<ProviderAvailability>({
    message: "Availability",
    choices: [
      { name: "available", value: "available" },
      { name: "limited", value: "limited" },
      { name: "unknown", value: "unknown" },
      { name: "unavailable", value: "unavailable" },
    ],
  });
  printProviderStatusUpdate(await controller.setProviderStatus(provider, availability));
}

async function manageProviderCredentials(controller: Controller): Promise<void> {
  await showProviderCredentials(controller);
  const action = await select<"set" | "clear" | "back">({
    message: "API key action",
    choices: [
      { name: "Add/update API key", value: "set" },
      { name: "Clear stored API key", value: "clear" },
      { name: "Back", value: "back" },
    ],
  });
  if (action === "back") return;

  const provider = await chooseCredentialProvider(action === "set" ? "Provider to configure" : "Provider to clear");
  if (action === "clear") {
    printCredentialResult("Cleared API key", await controller.clearProviderCredential(provider));
    await showProviderHealth(controller);
    return;
  }

  const envVars = PROVIDER_CREDENTIAL_ENV_VARS[provider] ?? [];
  const envVar = envVars.length === 1
    ? envVars[0]
    : await select<string>({
        message: "Credential env var",
        choices: envVars.map((value) => ({ name: value, value })),
      });
  const value = await password({ message: `${envVar} value`, mask: "*" });
  printCredentialResult("Saved API key", await controller.setProviderCredential(provider, envVar, value));
  await showProviderHealth(controller);
  const refresh = await confirm({ message: `Refresh ${provider} models now?`, default: true });
  if (refresh) printModelsRefresh(await controller.modelsRefresh(provider));
}

async function chooseTask(controller: Controller): Promise<string | undefined> {
  const tasks = await controller.taskList();
  if (!tasks.length) {
    const manual = await input({ message: "No tasks found. Enter task id manually, or leave blank" });
    return manual.trim() || undefined;
  }
  return select<string>({
    message: "Task",
    choices: tasks.slice(0, 30).map((task) => ({
      name: `${String(task.status).padEnd(10)} ${String(task.taskId)} ${truncate(String(task.goal), 80)}`,
      value: String(task.taskId),
    })),
  });
}

async function chooseCredentialProvider(message: string): Promise<ProviderId> {
  const providers = DEFAULT_PROVIDERS.filter((provider) => (PROVIDER_CREDENTIAL_ENV_VARS[provider] ?? []).length > 0);
  return select<ProviderId>({
    message,
    choices: providers.map((value) => ({ name: `${value} (${PROVIDER_CREDENTIAL_ENV_VARS[value].join(" or ")})`, value })),
  });
}

async function chooseProvider(message: string, controller?: Controller): Promise<ProviderId> {
  const health = controller ? await providerHealthMap(controller) : new Map<ProviderId, Record<string, unknown>>();
  const preferred = DEFAULT_PROVIDERS.find((provider) => provider !== "manual" && health.get(provider)?.canLaunch === true) ?? "manual";
  return select<ProviderId>({
    message,
    choices: DEFAULT_PROVIDERS.map((value) => {
      const row = health.get(value);
      const launch = row?.canLaunch ? "ready" : row ? String(row.launchMode ?? row.availability ?? "unknown") : "unknown";
      return { name: `${value} - ${launch}`, value };
    }),
    default: preferred,
  });
}

async function chooseModel(controller: Controller, provider: ProviderId): Promise<string | undefined> {
  if (provider === "manual") return undefined;
  const entries = await controller.modelsList({ provider, coding: true });
  if (!entries.length) {
    const manual = await input({
      message: `No cached coding models for ${provider}. Enter model id manually, or leave blank for provider default`,
    });
    return manual.trim() || undefined;
  }
  const choice = await select<string>({
    message: "Model",
    choices: [
      { name: "auto-select", value: "__auto__" },
      { name: "enter model id manually", value: "__manual__" },
      ...entries.slice(0, 25).map((entry) => ({
        name: `${entry.id} (${entry.costCategory}, ${entry.codingGate.smoke})`,
        value: entry.id,
      })),
    ],
  });
  if (choice === "__auto__") return undefined;
  if (choice === "__manual__") {
    const manual = await input({ message: "Model id", required: true });
    return manual.trim();
  }
  return choice;
}

async function showTaskLogs(controller: Controller, taskId: string): Promise<void> {
  const output = await controller.taskEvents(taskId) as { events?: Array<Record<string, unknown>> };
  const events = output.events ?? [];
  printTable(events.map((event) => ({
    time: shortTime(String(event.timestamp)),
    event: event.event,
    provider: event.provider ?? "",
    model: event.model ?? "",
    usage: event.usage ? formatUsageLine(event.usage as never) : "",
    message: truncate(String(event.message ?? ""), 120),
  })));
}

async function showProviderHealth(controller: Controller): Promise<void> {
  const output = await controller.providersDoctor() as { providers?: Array<Record<string, unknown>> };
  const rows = output.providers ?? [];
  printTable(rows.map((row) => ({
    provider: row.provider,
    detected: row.detected,
    account: row.availability,
    override: row.override,
    launch: row.canLaunch ? "yes" : "no",
    mode: row.launchMode,
    detail: row.detail,
  })));
}

async function showUsageSummary(controller: Controller): Promise<void> {
  const output = await controller.usageSummary() as {
    latest?: Record<string, unknown>;
    today?: UsageSummaryRow[];
    week?: UsageSummaryRow[];
    all?: UsageSummaryRow[];
  };
  if (output.latest?.usage) {
    console.log(`Latest run: ${output.latest.provider ?? "unknown"} ${formatUsageLine(output.latest.usage as never)}`);
  } else {
    console.log("Latest run: no provider usage recorded yet");
  }
  console.log("");
  console.log("Today");
  printUsageRows(output.today ?? []);
  console.log("");
  console.log("Last 7 days");
  printUsageRows(output.week ?? []);
  console.log("");
  console.log("All recorded runs");
  printUsageRows(output.all ?? []);
}

async function showProviderCredentials(controller: Controller): Promise<void> {
  const output = await controller.providerCredentials() as { credentials?: Array<Record<string, unknown>> };
  const rows = (output.credentials ?? []).filter((row) => row.source !== "not-supported");
  printTable(rows.map((row) => ({
    provider: row.provider,
    configured: row.configured ? "yes" : "no",
    source: row.source,
    envVar: row.envVar ?? "",
    accepted: Array.isArray(row.envVars) ? row.envVars.join(" or ") : "",
    updatedAt: row.updatedAt ?? "",
  })));
}

function printModelRows(entries: ModelCatalogEntry[]): void {
  printTable(entries.map((entry) => ({
    provider: entry.provider,
    id: entry.id,
    cost: entry.costCategory,
    smoke: entry.codingGate.smoke,
    approval: entry.requiresApproval ? "yes" : "no",
  })));
}

async function runTaskWithLiveOutput(controller: Controller, taskId: string, provider: ProviderId, modelId?: string): Promise<void> {
  console.log("");
  console.log(`Running ${taskId}`);
  console.log(`Provider: ${provider}${modelId ? ` / ${modelId}` : ""}`);
  const result = await controller.taskRun(taskId, provider, modelId, {
    onProgress: (event) => printProgressEvent(event),
  });
  console.log("");
  printRunResult(result);
}

function printProgressEvent(event: TaskRunProgress): void {
  const line = formatAgentOsProgress(event);
  if (line) console.log(line);
}

function printRuntimeStatus(value: unknown): void {
  const record = asRecord(value);
  console.log(`Root: ${record.rootDir ?? ""}`);
  console.log(`Tasks: ${record.taskCount ?? 0}${record.latestTaskId ? ` (latest ${record.latestTaskId})` : ""}`);
}

function printTaskCreated(value: unknown): void {
  const record = asRecord(value);
  const task = asRecord(record.task);
  console.log("");
  console.log("Task created");
  console.log(`ID: ${record.taskId ?? record.id ?? task.id ?? ""}`);
  console.log(`Goal: ${task.goal ?? ""}`);
  console.log(`Files: ${Array.isArray(task.allowedFiles) ? task.allowedFiles.join(", ") : ""}`);
  console.log(`Risk: ${task.risk ?? ""}`);
}

function printTaskDetails(value: unknown): void {
  const record = asRecord(value);
  const task = asRecord(record.task);
  const state = asRecord(record.state);
  console.log("");
  console.log(`Task: ${record.taskId ?? task.id ?? ""}`);
  console.log(`Status: ${record.status ?? state.status ?? ""}`);
  console.log(`Provider: ${state.provider ?? ""}${state.modelId ? ` / ${state.modelId}` : ""}`);
  console.log(`Worker: ${state.workerId ?? ""}`);
  console.log(`Goal: ${task.goal ?? ""}`);
  console.log(`Files: ${Array.isArray(task.allowedFiles) ? task.allowedFiles.join(", ") : ""}`);
  console.log(`Events: ${record.events ?? ""}`);
  if (state.message) console.log(`Message: ${state.message}`);
}

function printQueueStatus(value: unknown): void {
  const record = asRecord(value);
  const items = Array.isArray(record.items) ? record.items as Array<Record<string, unknown>> : [];
  console.log("");
  console.log(`Queue: ${items.length} task${items.length === 1 ? "" : "s"}`);
  printTable(items.map((item) => ({
    task: item.taskId,
    status: item.status,
    updated: item.updatedAt ?? "",
    message: truncate(String(item.message ?? ""), 120),
  })));
}

function printRunResult(value: unknown): void {
  const record = asRecord(value);
  const result = asRecord(record.result);
  console.log("Run complete");
  console.log(`Task: ${record.taskId ?? ""}`);
  console.log(`Status: ${record.status ?? result.status ?? ""}`);
  console.log(`Provider: ${record.provider ?? ""}${record.model ? ` / ${record.model}` : ""}`);
  console.log(`Worker: ${record.workerId ?? ""}`);
  console.log(`Duration: ${formatDuration(toNumber(record.durationMs))}`);
  console.log(`Patch: ${formatNumber(toNumber(record.patchBytes))} bytes`);
  console.log(`Usage: ${formatUsageLine(record.usage as never)}`);
  const changedFiles = Array.isArray(result.changedFiles) ? result.changedFiles : [];
  if (changedFiles.length) console.log(`Changed: ${changedFiles.join(", ")}`);
  if (result.summary) console.log(`Summary: ${truncate(String(result.summary), 500)}`);
}

function printDryRunResult(value: unknown): void {
  const record = asRecord(value);
  const selectedFiles = Array.isArray(record.selectedFiles) ? record.selectedFiles : [];
  const model = asRecord(record.model);
  console.log("");
  console.log("Dry run");
  console.log(`Task: ${record.taskId ?? ""}`);
  console.log(`Provider: ${record.provider ?? ""}${model.id ? ` / ${model.id}` : ""}`);
  console.log(`Reason: ${record.reason ?? ""}`);
  console.log(`Selected files: ${selectedFiles.length}`);
  console.log(`Bundle: ${record.bundlePath ?? ""}`);
}

function printValidationResult(value: unknown): void {
  const record = asRecord(value);
  console.log("");
  console.log(`Validation: ${record.status ?? ""}`);
  const validators = Array.isArray(record.validators) ? record.validators as Array<Record<string, unknown>> : [];
  printTable(validators.map((item) => ({
    validator: item.id,
    status: item.status,
    message: item.message ?? "",
  })));
  const notes = Array.isArray(record.notes) ? record.notes : [];
  if (notes.length) console.log(`Notes: ${notes.join("; ")}`);
}

function printTaskAction(title: string, value: unknown): void {
  const record = asRecord(value);
  console.log("");
  console.log(title);
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "object" && item !== null) continue;
    console.log(`${key}: ${item}`);
  }
  const decision = asRecord(record.decision);
  if (decision.status) console.log(`decision: ${decision.status} - ${decision.reason ?? ""}`);
}

function printModelsRefresh(value: unknown): void {
  const record = asRecord(value);
  const entries = Array.isArray(record.entries) ? record.entries : [];
  const providers = Array.isArray(record.providers) ? record.providers as Array<Record<string, unknown>> : [];
  const failures = Array.isArray(record.failures) ? record.failures : [];
  console.log("");
  console.log(`Refreshed: ${record.refreshed ?? ""}`);
  console.log(`Models cached: ${entries.length}`);
  if (providers.length) {
    printTable(providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      entries: provider.entries ?? "",
      source: provider.source ?? "",
      detail: truncate(String(provider.detail ?? ""), 100),
    })));
  }
  if (failures.length) console.log(`Failures: ${failures.length}`);
}

function printProviderStatusUpdate(value: unknown): void {
  const record = asRecord(value);
  console.log(`Provider status: ${record.provider ?? ""} ${record.availability ?? ""}`);
}

function printCredentialResult(title: string, value: unknown): void {
  const credential = asRecord(asRecord(value).credential);
  console.log(`${title}: ${credential.provider ?? ""} ${credential.envVar ?? ""}`);
}

function printUsageRows(rows: UsageSummaryRow[]): void {
  printTable(rows.map((row) => ({
    provider: row.provider,
    runs: row.runs,
    exact: row.exactRuns,
    input: formatNumber(row.inputTokens),
    cached: formatNumber(row.cachedInputTokens),
    output: formatNumber(row.outputTokens),
    reasoning: formatNumber(row.reasoningOutputTokens),
    total: row.totalTokens ? formatNumber(row.totalTokens) : "",
    estimated: formatNumber(row.estimatedTokens),
  })));
}

async function providerHealthMap(controller: Controller): Promise<Map<ProviderId, Record<string, unknown>>> {
  try {
    const output = await controller.providersDoctor() as { providers?: Array<Record<string, unknown>> };
    return new Map((output.providers ?? []).map((row) => [row.provider as ProviderId, row]));
  } catch {
    return new Map();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value ? value as Record<string, unknown> : {};
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatDuration(value: number | undefined): string {
  const ms = value ?? 0;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}
