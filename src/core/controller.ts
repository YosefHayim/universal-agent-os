import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROVIDERS, DIRECT_LAUNCH_PROVIDERS } from "../config/defaults.js";
import {
  applyProviderCredentialEnv,
  clearProviderCredential,
  ensureRuntime,
  providerCredentialSummaries,
  readProviderStatus,
  resolveRuntimePaths,
  runtimeStatus,
  setProviderAvailability,
  setProviderCredential,
  upgradeRuntimeLayout,
} from "../config/config-loader.js";
import type { ProviderAvailability, ProviderId, ProviderResult, RiskLevel, RuntimePaths, SourceKind, Task, TaskPlan, TaskState, ValidationResult } from "./types.js";
import { appendEvent, readTaskEvents } from "./events.js";
import { appendRegistryEntry } from "./global-registry.js";
import { compileContext } from "../context/compiler.js";
import { listModels, modelsDoctor, refreshModels } from "../models/index.js";
import { runExternalProvider, type ExternalProviderProgress } from "../providers/external-runner.js";
import { runManualProvider, runManualTask } from "../providers/manual.js";
import { notifyWorkerFinished } from "./notifications.js";

async function safeNotify(rootDir: string, event: { taskId: string; workerId: string; provider: string; status: string; durationMs: number; message: string }): Promise<void> {
  try {
    await notifyWorkerFinished({ rootDir }, event);
  } catch (error) {
    console.error(`[agent-os] notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
import { providerAdapter } from "../providers/registry.js";
import { buildReviewerInput } from "../review/delta-review.js";
import { judgeMerge } from "../review/merge-judge.js";
import { chooseRoute } from "../routing/broker.js";
import { summarizeUsage, type UsageSummary } from "../usage/usage.js";
import { validateTaskRun } from "../validators/pipeline.js";
import { taskDir, createTask, latestTaskId, listTaskIds, readPlan, readState, readTask, readTaskSummary, readTextIfExists, updateState } from "./lifecycle.js";
import { withTaskLock } from "./locks.js";
import { TaskQueue, type QueueItem } from "./queue.js";
import { appendTelemetrySpan } from "./telemetry.js";

export type TaskRunProgress = ExternalProviderProgress | {
  taskId: string;
  event: "context_compiled";
  bundlePath: string;
  selectedFiles: string[];
  message?: string;
} | {
  taskId: string;
  event: "route_selected";
  provider: ProviderId;
  model?: string;
  modelCatalogSource?: SourceKind;
  message?: string;
};

export interface ControllerOptions {
  rootDir?: string;
  cwd?: string;
}

export interface ProviderHealthRow {
  provider: ProviderId;
  override: ProviderAvailability;
  detected: "available" | "unavailable";
  availability: ProviderAvailability;
  detail: string;
  canLaunch: boolean;
  launchMode: "direct" | "preview-only" | "blocked";
  cloudHosted: boolean;
  checkedAt: string;
}

export interface TaskRecoveryOptions {
  staleAfterMs?: number;
  now?: Date;
}

export interface TaskRecoveryItem {
  taskId: string;
  previousStatus: TaskState["status"];
  status: TaskState["status"];
  action: "skipped" | "fresh" | "marked_stale" | "restored_completed" | "restored_failed";
  reason: string;
  workerId?: string;
  heartbeatPath?: string;
  resumeCommand?: string;
  runCommand?: string;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export class Controller {
  readonly paths: RuntimePaths;

  constructor(private readonly options: ControllerOptions = {}) {
    this.paths = resolveRuntimePaths(options.rootDir ?? options.cwd);
  }

  static async create(options: ControllerOptions = {}): Promise<Controller> {
    const controller = new Controller(options);
    await controller.init();
    return controller;
  }

  async init(): Promise<void> {
    await ensureRuntime(this.paths);
  }

  async doctor(): Promise<Record<string, unknown>> {
    await this.init();
    const providerStatus = await readProviderStatus(this.paths);
    const providerHealth = await this.providerHealthRows(providerStatus.providers);
    const runtime = await runtimeStatus(this.paths);
    return {
      ok: true,
      rootDir: this.paths.rootDir,
      runtimeDir: this.paths.runtimeDir,
      runtime,
      providerOverrides: providerStatus.providers,
      providerHealth,
      generatedSourcePolicy: "Agent OS source is TypeScript; JavaScript is build output only.",
    };
  }

  async status(): Promise<Record<string, unknown>> {
    await this.init();
    const taskIds = await listTaskIds(this.paths);
    const latest = taskIds.at(-1);
    return { rootDir: this.paths.rootDir, taskCount: taskIds.length, latestTaskId: latest, runtime: await runtimeStatus(this.paths) };
  }

  async upgrade(): Promise<Record<string, unknown>> {
    const result = await upgradeRuntimeLayout(this.paths);
    await this.init();
    return { rootDir: this.paths.rootDir, ...result };
  }

  async providersStatus(): Promise<unknown> {
    await this.init();
    return readProviderStatus(this.paths);
  }

  async setProviderStatus(provider: ProviderId, availability: ProviderAvailability): Promise<unknown> {
    await this.init();
    return setProviderAvailability(this.paths, provider, availability);
  }

  async providersDoctor(): Promise<Record<string, unknown>> {
    await this.init();
    const status = await readProviderStatus(this.paths);
    return {
      rootDir: this.paths.rootDir,
      providers: await this.providerHealthRows(status.providers),
    };
  }

  private async providerHealthRows(overrides: Partial<Record<ProviderId, ProviderAvailability>>): Promise<ProviderHealthRow[]> {
    const ctx = { paths: this.paths, cwd: this.paths.rootDir };
    return Promise.all(
      DEFAULT_PROVIDERS.map(async (provider) => {
        const override = overrides[provider] ?? "unknown";
        const adapter = providerAdapter(provider);
        try {
          const [status, capabilities] = await Promise.all([
            adapter.status(ctx),
            adapter.capabilities(ctx),
          ]);
          const directLaunchEnabled = DIRECT_LAUNCH_PROVIDERS.includes(provider);
          const ready = status.availability === "available";
          return {
            provider,
            override,
            detected: status.availability === "unavailable" ? "unavailable" : "available",
            availability: status.availability,
            detail: status.detail,
            canLaunch: capabilities.canLaunch && ready && directLaunchEnabled,
            launchMode: capabilities.canLaunch && ready ? (directLaunchEnabled ? "direct" : "preview-only") : "blocked",
            cloudHosted: capabilities.cloudHosted,
            checkedAt: status.checkedAt,
          };
        } catch (error) {
          return {
            provider,
            override,
            detected: "unavailable",
            availability: "unavailable",
            detail: error instanceof Error ? error.message : String(error),
            canLaunch: false,
            launchMode: "blocked",
            cloudHosted: provider !== "manual",
            checkedAt: new Date().toISOString(),
          };
        }
      }),
    );
  }

  async providerCredentials(): Promise<Record<string, unknown>> {
    await this.init();
    return { rootDir: this.paths.rootDir, credentials: await providerCredentialSummaries(this.paths) };
  }

  async setProviderCredential(provider: ProviderId, envVar: string, value: string): Promise<Record<string, unknown>> {
    await this.init();
    const credential = await setProviderCredential(this.paths, provider, envVar, value);
    await applyProviderCredentialEnv(this.paths, { provider, overwrite: true });
    return { rootDir: this.paths.rootDir, credential };
  }

  async clearProviderCredential(provider: ProviderId): Promise<Record<string, unknown>> {
    await this.init();
    return { rootDir: this.paths.rootDir, credential: await clearProviderCredential(this.paths, provider) };
  }

  async modelsRefresh(provider?: ProviderId): Promise<Record<string, unknown>> {
    await this.init();
    const entries = await refreshModels(this.paths, provider);
    const providerSet = provider ? new Set<ProviderId>([provider]) : undefined;
    const providers = (await modelsDoctor(this.paths)).filter((item) => !providerSet || providerSet.has(item.provider));
    const failures = providers.filter((item) => item.status === "failed");
    return { refreshed: provider ?? "all", entries, providers, failures };
  }

  async modelsList(filters: Parameters<typeof listModels>[1]): Promise<ReturnType<typeof listModels>> {
    await this.init();
    return listModels(this.paths, filters);
  }

  async modelsDoctor(): Promise<ReturnType<typeof modelsDoctor>> {
    await this.init();
    return modelsDoctor(this.paths);
  }

  async taskCreate(goal: string, options: { allowedFiles?: string[]; risk?: RiskLevel }): Promise<Record<string, unknown>> {
    await this.init();
    const task = await createTask(goal, { ...options, rootDir: this.paths.rootDir });
    await this.queue().enqueue(task.id, "created", "task created");
    await appendRegistryEntry({
      taskId: task.id,
      repoRoot: this.paths.rootDir,
      goal,
      createdAt: task.createdAt,
    });
    return { id: task.id, taskId: task.id, task };
  }

  async taskStatus(taskId?: string): Promise<Record<string, unknown>> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const summary = await readTaskSummary(this.paths, id);
    return { taskId: id, status: summary.state.status, ...summary };
  }

  async taskList(): Promise<Array<Record<string, unknown>>> {
    await this.init();
    const ids = await listTaskIds(this.paths);
    const summaries = await Promise.all(ids.map((id) => readTaskSummary(this.paths, id)));
    return summaries.reverse().map((summary) => ({
      taskId: summary.task.id,
      status: summary.state.status,
      provider: summary.state.provider,
      modelId: summary.state.modelId,
      goal: summary.task.goal,
      risk: summary.task.risk,
      events: summary.events,
      updatedAt: summary.state.updatedAt,
    }));
  }

  async queueStatus(): Promise<{ rootDir: string; items: QueueItem[] }> {
    await this.init();
    return { rootDir: this.paths.rootDir, items: await this.queue().list() };
  }

  async queuePause(taskId?: string): Promise<QueueItem> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const current = await readState(this.paths, id);
    ensurePausableStatus(id, current.status);
    await updateState(this.paths, id, "paused", { message: "paused by user" });
    return this.queue().pause(id);
  }

  async queueResume(taskId?: string): Promise<QueueItem> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const current = await readState(this.paths, id);
    ensureResumableStatus(id, current.status);
    await updateState(this.paths, id, "planned", { workerId: undefined, message: "ready to resume" });
    return this.queue().resume(id);
  }

  async queueCancel(taskId?: string): Promise<QueueItem> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    await updateState(this.paths, id, "cancelled", { message: "cancelled by user" });
    return this.queue().cancel(id);
  }

  async taskPause(taskId?: string): Promise<TaskState> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const current = await readState(this.paths, id);
    ensurePausableStatus(id, current.status);
    const state = await updateState(this.paths, id, "paused", { message: "paused by user" });
    await this.queue().pause(id);
    return state;
  }

  async taskPlan(taskId?: string): Promise<TaskPlan> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    return readPlan(this.paths, id);
  }

  async taskEvents(taskId?: string): Promise<Record<string, unknown>> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    return { taskId: id, events: await readTaskEvents(this.paths, id) };
  }

  async usageSummary(): Promise<UsageSummary & { rootDir: string }> {
    await this.init();
    const taskIds = await listTaskIds(this.paths);
    const events = (await Promise.all(taskIds.map((id) => readTaskEvents(this.paths, id))))
      .flat()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { rootDir: this.paths.rootDir, ...summarizeUsage(events) };
  }

  async taskDryRun(taskId: string | undefined, provider?: ProviderId, modelId?: string): Promise<Record<string, unknown>> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const task = await readTask(this.paths, id);
    const bundle = await compileContext(this.paths, task);
    const models = await listModels(this.paths, {});
    const route = await chooseRoute(this.paths, task, models, { requestedProvider: provider, requestedModelId: modelId });
    const selectedModelId = route.model?.id ?? route.modelId;
    const launchPreview = await providerAdapter(route.provider).buildLaunchCommand(
      { paths: this.paths, cwd: this.paths.rootDir },
      task,
      bundle.bundlePath,
      selectedModelId,
    );
    const previewPath = join(taskDir(this.paths, id), "launch-preview.json");
    await writeFile(previewPath, `${JSON.stringify({
      taskId: id,
      provider: route.provider,
      modelId: selectedModelId,
      modelCatalogSource: route.model?.source.kind,
      launchCommand: launchPreview,
      selectedFiles: bundle.selectedFiles,
    }, null, 2)}\n`, "utf8");
    await updateState(this.paths, id, "dry_run", { provider: route.provider, modelId: selectedModelId, message: `dry-run route: ${route.reason}` });
    await this.queue().update(id, "dry_run", `dry-run route: ${route.reason}`);
    await appendEvent(taskDir(this.paths, id), { taskId: id, event: "context_compiled", message: `${bundle.selectedFiles.length} files selected` });
    await appendTelemetrySpan(this.paths, {
      taskId: id,
      name: "context_compiled",
      attributes: {
        "agent_os.context.selected_files": bundle.selectedFiles.length,
        "agent_os.context.summarized_files": bundle.summarizedFiles?.length ?? 0,
        "agent_os.context.used_bytes": bundle.usedBytes,
        "agent_os.context.budget_bytes": bundle.budgetBytes,
        "agent_os.context.estimated_saved_bytes": bundle.estimatedSavedBytes,
      },
    });
    await appendEvent(taskDir(this.paths, id), {
      taskId: id,
      event: "launch_preview_built",
      provider: route.provider,
      model: selectedModelId,
      modelCatalogSource: route.model?.source.kind,
      message: `${launchPreview.command} ${launchPreview.args.join(" ")}`.trim(),
    });
    await appendTelemetrySpan(this.paths, {
      taskId: id,
      provider: route.provider,
      name: "launch_preview_built",
      attributes: {
        "agent_os.model.id": selectedModelId,
        "agent_os.model.source": route.model?.source.kind,
      },
    });
    return {
      taskId: id,
      status: "dry_run",
      provider: route.provider,
      model: route.model
        ? {
            id: route.model.id,
            costCategory: route.model.costCategory,
            sourceKind: route.model.source.kind,
            requiresApproval: route.model.requiresApproval,
            smoke: route.model.codingGate.smoke,
          }
        : selectedModelId ? { id: selectedModelId, sourceKind: "user_config" } : undefined,
      reason: route.reason,
      bundlePath: bundle.bundlePath,
      launchPreviewPath: previewPath,
      launchCommand: launchPreview,
      selectedFiles: bundle.selectedFiles,
    };
  }

  async taskRun(
    taskId: string | undefined,
    provider: ProviderId = "manual",
    modelId?: string,
    options: { onProgress?: (event: TaskRunProgress) => void | Promise<void> } = {},
  ): Promise<Record<string, unknown>> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const dir = taskDir(this.paths, id);
    return withTaskLock(dir, async () => {
      const currentState = await readState(this.paths, id);
      if (currentState.status === "paused") {
        throw new Error(`Task ${id} is paused. Run agent-os task resume ${id} before task run.`);
      }
      const task = await readTask(this.paths, id);
      const bundle = await compileContext(this.paths, task);
      await appendEvent(taskDir(this.paths, id), { taskId: id, event: "context_compiled", message: `${bundle.selectedFiles.length} files selected` });
      await appendTelemetrySpan(this.paths, {
        taskId: id,
        name: "context_compiled",
        attributes: {
          "agent_os.context.selected_files": bundle.selectedFiles.length,
          "agent_os.context.summarized_files": bundle.summarizedFiles?.length ?? 0,
          "agent_os.context.used_bytes": bundle.usedBytes,
          "agent_os.context.budget_bytes": bundle.budgetBytes,
          "agent_os.context.estimated_saved_bytes": bundle.estimatedSavedBytes,
        },
      });
      await options.onProgress?.({
        taskId: id,
        event: "context_compiled",
        bundlePath: bundle.bundlePath,
        selectedFiles: bundle.selectedFiles,
        message: `${bundle.selectedFiles.length} files selected`,
      });
      const models = await listModels(this.paths, {});
      const route = await chooseRoute(this.paths, task, models, { requestedProvider: provider, requestedModelId: modelId });
      const selectedModelId = route.model?.id ?? route.modelId;
      await appendEvent(taskDir(this.paths, id), {
        taskId: id,
        event: "route_selected",
        provider: route.provider,
        model: selectedModelId,
        modelCatalogSource: route.model?.source.kind,
        message: route.reason,
      });
      await appendRegistryEntry({
        taskId: id,
        repoRoot: this.paths.rootDir,
        goal: task.goal,
        createdAt: new Date().toISOString(),
        provider: route.provider,
        modelId: selectedModelId,
      });
      await appendTelemetrySpan(this.paths, {
        taskId: id,
        provider: route.provider,
        name: "route_selected",
        attributes: {
          "agent_os.model.id": selectedModelId,
          "agent_os.model.source": route.model?.source.kind,
          "agent_os.route.reason": route.reason,
        },
      });
      await options.onProgress?.({
        taskId: id,
        event: "route_selected",
        provider: route.provider,
        model: selectedModelId,
        modelCatalogSource: route.model?.source.kind,
        message: route.reason,
      });
      await updateState(this.paths, id, "running", { provider: route.provider, modelId: selectedModelId, message: "worker started" });
      await this.queue().update(id, "running", "worker started");
      if (route.provider !== "manual") {
        const adapter = providerAdapter(route.provider);
        const capabilities = await adapter.capabilities({ paths: this.paths, cwd: this.paths.rootDir });
        if (!capabilities.canLaunch || !DIRECT_LAUNCH_PROVIDERS.includes(route.provider)) {
          await updateState(this.paths, id, "failed", { provider: route.provider, modelId: selectedModelId, message: `${route.provider} direct worker launch is not active` });
          await this.queue().update(id, "failed", `${route.provider} direct worker launch is not active`);
          await appendTelemetrySpan(this.paths, {
            taskId: id,
            provider: route.provider,
            name: "worker_failed",
            attributes: { "agent_os.failure.reason": `${route.provider} direct worker launch is not active` },
          });
          throw new Error(`${route.provider} direct worker launch is not active`);
        }
        const run = await runExternalProvider({ paths: this.paths, cwd: this.paths.rootDir }, task, bundle.bundlePath, adapter, {
          modelId: selectedModelId,
          onProgress: async (event) => {
            if (event.event === "worker_prepared") {
              await updateState(this.paths, id, "running", {
                provider: event.provider,
                workerId: event.workerId,
                modelId: selectedModelId,
                message: "worker prepared",
              });
            }
            if (event.event !== "provider_output" && event.event !== "provider_error_output") {
              await appendEvent(taskDir(this.paths, id), {
                taskId: id,
                event: event.event,
                provider: event.provider,
                workerId: event.workerId,
                durationMs: event.durationMs,
                usage: event.usage,
                message: event.message,
              });
              await appendTelemetrySpan(this.paths, {
                taskId: id,
                provider: event.provider,
                workerId: event.workerId,
                name: event.event,
                durationMs: event.durationMs,
                usage: event.usage,
                attributes: {
                  "agent_os.message": event.message,
                },
              });
            }
            if (event.event === "worker_finished") {
              await safeNotify(this.paths.rootDir, {
                taskId: id,
                workerId: event.workerId,
                provider: event.provider,
                status: "worker_finished",
                durationMs: event.durationMs ?? 0,
                message: event.message ?? "",
              });
            }
            await options.onProgress?.(event);
          },
        });
        const taskStatus = run.result.status === "completed" ? "completed" : "failed";
        await updateState(this.paths, id, taskStatus, { provider: route.provider, workerId: run.worker.workerId, modelId: selectedModelId, message: run.result.summary });
        await this.queue().update(id, taskStatus, run.result.summary);
        await appendTelemetrySpan(this.paths, {
          taskId: id,
          provider: route.provider,
          workerId: run.worker.workerId,
          name: `task_${taskStatus}`,
          durationMs: run.durationMs,
          usage: run.usage,
          attributes: {
            "agent_os.result.status": run.result.status,
            "agent_os.patch.bytes": Buffer.byteLength(run.patch),
          },
        });
        if (taskStatus === "completed") {
          await safeNotify(this.paths.rootDir, {
            taskId: id,
            workerId: run.worker.workerId,
            provider: route.provider,
            status: "task_completed",
            durationMs: run.durationMs,
            message: run.result.summary,
          });
        }
        if (run.result.status !== "completed") throw new Error(run.result.summary);
        return {
          taskId: id,
          status: run.result.status,
          provider: route.provider,
          model: selectedModelId,
          workerId: run.worker.workerId,
          result: run.result,
          patchBytes: Buffer.byteLength(run.patch),
          durationMs: run.durationMs,
          usage: run.usage,
        };
      }
      const manualStarted = Date.now();
      const manualPrepared: ExternalProviderProgress = { taskId: id, event: "worker_prepared", provider: "manual", workerId: "manual-1", message: "manual provider workspace" };
      await appendEvent(taskDir(this.paths, id), manualPrepared);
      await appendTelemetrySpan(this.paths, {
        taskId: id,
        provider: "manual",
        workerId: "manual-1",
        name: "worker_prepared",
        attributes: { "agent_os.message": manualPrepared.message },
      });
      await options.onProgress?.(manualPrepared);
      const run = await runManualProvider({ paths: this.paths, cwd: this.paths.rootDir }, task, bundle.bundlePath, { workerId: "manual-1" });
      const durationMs = Date.now() - manualStarted;
      const usage = { exact: false, estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedTotalTokens: 0, inputChars: 0, outputChars: 0 };
      const manualFinished: ExternalProviderProgress = { taskId: id, event: "worker_finished", provider: "manual", workerId: run.worker.workerId, durationMs, usage, message: run.result.summary };
      await appendEvent(taskDir(this.paths, id), manualFinished);
      await appendTelemetrySpan(this.paths, {
        taskId: id,
        provider: "manual",
        workerId: run.worker.workerId,
        name: "worker_finished",
        durationMs,
        usage,
        attributes: { "agent_os.message": run.result.summary },
      });
      await safeNotify(this.paths.rootDir, {
        taskId: id,
        workerId: run.worker.workerId,
        provider: "manual",
        status: "worker_finished",
        durationMs,
        message: run.result.summary,
      });
      await options.onProgress?.(manualFinished);
      await updateState(this.paths, id, "completed", { provider: route.provider, workerId: run.worker.workerId, message: run.result.summary });
      await this.queue().update(id, "completed", run.result.summary);
      await appendTelemetrySpan(this.paths, {
        taskId: id,
        provider: route.provider,
        workerId: run.worker.workerId,
        name: "task_completed",
        durationMs,
        usage,
      });
      await safeNotify(this.paths.rootDir, {
        taskId: id,
        workerId: run.worker.workerId,
        provider: route.provider,
        status: "task_completed",
        durationMs,
        message: run.result.summary,
      });
      return { taskId: id, status: "completed", provider: route.provider, workerId: run.worker.workerId, result: run.result, patchBytes: 0, durationMs, usage };
    });
  }

  async taskDiff(taskId?: string): Promise<string> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const state = await readState(this.paths, id);
    if (!state.workerId) return "";
    return readTextIfExists(join(taskDir(this.paths, id), "workers", state.workerId, "diff.patch"));
  }

  async taskValidate(taskId?: string): Promise<ValidationResult> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const state = await readState(this.paths, id);
    if (!state.workerId) throw new Error("task has no worker result to validate");
    const task = await readTask(this.paths, id);
    const result = await validateTaskRun({ task, taskDir: taskDir(this.paths, id), workerId: state.workerId });
    const validationDir = join(taskDir(this.paths, id), "validation");
    await mkdir(validationDir, { recursive: true });
    await writeFile(join(validationDir, "test-output.txt"), `${result.status === "passed" ? "validation passed" : "validation failed"}\n${result.notes.join("\n")}\n`, "utf8");
    const status = result.status === "passed" ? "validated" : "failed";
    await updateState(this.paths, id, status, { message: `validation ${result.status}` });
    await this.queue().update(id, status, `validation ${result.status}`);
    return result;
  }

  async taskReview(taskId?: string): Promise<Record<string, unknown>> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const task = await readTask(this.paths, id);
    const state = await readState(this.paths, id);
    if (!state.workerId) throw new Error("task has no worker result to review");
    const input = await buildReviewerInput(task, taskDir(this.paths, id), state.workerId);
    await updateState(this.paths, id, "reviewed", { message: "review packet generated" });
    await this.queue().update(id, "reviewed", "review packet generated");
    return { taskId: id, reviewerInputBytes: input.length, path: join(taskDir(this.paths, id), "review", "reviewer-input.md") };
  }

  async taskAccept(taskId?: string): Promise<Record<string, unknown>> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const validationPath = join(taskDir(this.paths, id), "validation", "validation-result.json");
    const validation = JSON.parse(await readFile(validationPath, "utf8")) as ValidationResult;
    const decision = judgeMerge(validation, true);
    if (decision.status !== "approved") throw new Error(decision.reason);
    await updateState(this.paths, id, "accepted", { message: decision.reason });
    await this.queue().update(id, "accepted", decision.reason);
    return { taskId: id, decision };
  }

  async taskReject(taskId?: string): Promise<TaskState> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const state = await updateState(this.paths, id, "rejected", { message: "rejected by user" });
    await this.queue().update(id, "rejected", "rejected by user");
    return state;
  }

  async taskCancel(taskId?: string): Promise<TaskState> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const state = await updateState(this.paths, id, "cancelled", { message: "cancelled by user" });
    await this.queue().cancel(id);
    return state;
  }

  async taskResume(taskId?: string): Promise<TaskState> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const current = await readState(this.paths, id);
    ensureResumableStatus(id, current.status);
    const state = await updateState(this.paths, id, "planned", { workerId: undefined, message: "ready to resume" });
    await this.queue().resume(id);
    return state;
  }

  async taskRecover(taskId?: string, options: TaskRecoveryOptions = {}): Promise<{ rootDir: string; staleAfterMs: number; recovered: TaskRecoveryItem[] }> {
    await this.init();
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const now = options.now ?? new Date();
    const ids = taskId ? [taskId] : await listTaskIds(this.paths);
    const recovered: TaskRecoveryItem[] = [];
    for (const id of ids) {
      recovered.push(await this.recoverTask(id, staleAfterMs, now));
    }
    return { rootDir: this.paths.rootDir, staleAfterMs, recovered };
  }

  async taskRollback(taskId?: string): Promise<TaskState> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const state = await updateState(this.paths, id, "planned", { message: "rollback recorded; isolated workspace left for inspection" });
    await this.queue().update(id, "planned", "rollback recorded; isolated workspace left for inspection");
    return state;
  }

  private async recoverTask(taskId: string, staleAfterMs: number, now: Date): Promise<TaskRecoveryItem> {
    const state = await readState(this.paths, taskId);
    const base = {
      taskId,
      previousStatus: state.status,
      resumeCommand: `agent-os task resume ${taskId}`,
      runCommand: `agent-os task run ${taskId}`,
    };

    if (state.status !== "running") {
      return {
        ...base,
        status: state.status,
        action: "skipped",
        reason: `task is ${state.status}, not running`,
      };
    }

    const worker = await this.findRecoveryWorker(taskId, state.workerId);
    if (!worker) {
      const updatedAtMs = Date.parse(state.updatedAt);
      const ageMs = Number.isNaN(updatedAtMs) ? Number.POSITIVE_INFINITY : now.getTime() - updatedAtMs;
      if (ageMs > staleAfterMs) {
        const reason = "running task has no worker heartbeat";
        const stale = await updateState(this.paths, taskId, "stale", { message: reason });
        await this.queue().update(taskId, "stale", reason);
        return { ...base, status: stale.status, action: "marked_stale", reason };
      }
      return { ...base, status: state.status, action: "fresh", reason: "running task has no heartbeat yet but is inside the stale window" };
    }

    if (worker.result) {
      const restoredStatus = worker.result.status === "completed" ? "completed" : "failed";
      const restored = await updateState(this.paths, taskId, restoredStatus, {
        provider: state.provider,
        workerId: worker.workerId,
        modelId: state.modelId,
        message: worker.result.summary,
      });
      await this.queue().update(taskId, restoredStatus, worker.result.summary);
      return {
        ...base,
        status: restored.status,
        action: restoredStatus === "completed" ? "restored_completed" : "restored_failed",
        reason: "worker result artifact survived controller exit",
        workerId: worker.workerId,
        heartbeatPath: worker.heartbeatPath,
      };
    }

    const heartbeatStatus = stringValue(worker.heartbeat?.status);
    const heartbeatTime = heartbeatTimestampMs(worker.heartbeat, state.updatedAt);
    const heartbeatAgeMs = heartbeatTime === undefined ? Number.POSITIVE_INFINITY : now.getTime() - heartbeatTime;
    if (heartbeatStatus && heartbeatStatus !== "running") {
      const reason = `worker heartbeat is ${heartbeatStatus} but no result artifact exists`;
      const stale = await updateState(this.paths, taskId, "stale", {
        provider: state.provider,
        workerId: worker.workerId,
        modelId: state.modelId,
        message: reason,
      });
      await this.queue().update(taskId, "stale", reason);
      return { ...base, status: stale.status, action: "marked_stale", reason, workerId: worker.workerId, heartbeatPath: worker.heartbeatPath };
    }

    if (heartbeatAgeMs > staleAfterMs) {
      const reason = `worker heartbeat stale for ${Math.round(heartbeatAgeMs / 1000)}s`;
      const stale = await updateState(this.paths, taskId, "stale", {
        provider: state.provider,
        workerId: worker.workerId,
        modelId: state.modelId,
        message: reason,
      });
      await this.queue().update(taskId, "stale", reason);
      return { ...base, status: stale.status, action: "marked_stale", reason, workerId: worker.workerId, heartbeatPath: worker.heartbeatPath };
    }

    return {
      ...base,
      status: state.status,
      action: "fresh",
      reason: "worker heartbeat is fresh",
      workerId: worker.workerId,
      heartbeatPath: worker.heartbeatPath,
    };
  }

  private async findRecoveryWorker(taskId: string, preferredWorkerId?: string): Promise<RecoveryWorker | undefined> {
    const workersDir = join(taskDir(this.paths, taskId), "workers");
    const workerIds = preferredWorkerId ? [preferredWorkerId] : await workerDirectoryNames(workersDir);
    for (const workerId of workerIds) {
      const workerDir = join(workersDir, workerId);
      const heartbeatPath = join(workerDir, "heartbeat.json");
      const heartbeat = await readJsonIfExists<Record<string, unknown>>(heartbeatPath);
      const result = await readJsonIfExists<ProviderResult>(join(workerDir, "result.json"));
      if (heartbeat || result) return { workerId, heartbeatPath, heartbeat, result };
    }
    return undefined;
  }

  private async resolveTaskId(taskId?: string): Promise<string> {
    if (taskId) return taskId;
    const latest = await latestTaskId(this.paths);
    if (!latest) throw new Error("No task id provided and no tasks exist");
    return latest;
  }

  private queue(): TaskQueue {
    return new TaskQueue(this.paths);
  }
}

interface RecoveryWorker {
  workerId: string;
  heartbeatPath: string;
  heartbeat?: Record<string, unknown>;
  result?: ProviderResult;
}

async function workerDirectoryNames(workersDir: string): Promise<string[]> {
  try {
    return (await readdir(workersDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function heartbeatTimestampMs(heartbeat: Record<string, unknown> | undefined, fallback: string): number | undefined {
  const raw = heartbeat
    ? stringValue(heartbeat.checkedAt) ?? stringValue(heartbeat.lastOutputAt) ?? stringValue(heartbeat.timestamp) ?? stringValue(heartbeat.updatedAt)
    : undefined;
  const parsed = Date.parse(raw ?? fallback);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ensurePausableStatus(taskId: string, status: TaskState["status"]): void {
  if (!["completed", "validated", "reviewed", "accepted", "rejected", "cancelled"].includes(status)) return;
  throw new Error(`Cannot pause task ${taskId} from ${status}. Only active or resumable tasks can be paused.`);
}

function ensureResumableStatus(taskId: string, status: TaskState["status"]): void {
  if (["paused", "stale", "failed", "cancelled"].includes(status)) return;
  throw new Error(`Cannot resume task ${taskId} from ${status}. Only paused, stale, failed, or cancelled tasks can be resumed.`);
}

export interface CreateTaskInput {
  goal: string;
  allowedFiles?: string[];
  risk?: RiskLevel;
}

export interface ProviderRunOptions {
  provider?: ProviderId;
  modelId?: string;
}

export class AgentOsController {
  private constructor(readonly config: { cwd: string; paths: RuntimePaths }) {}

  static async create(options: { cwd?: string } = {}): Promise<AgentOsController> {
    const paths = await ensureRuntime(resolveRuntimePaths(options.cwd));
    return new AgentOsController({ cwd: paths.rootDir, paths });
  }

  async doctor(): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).doctor();
  }

  async status(): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).status();
  }

  async upgrade(): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).upgrade();
  }

  async providersStatus(): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).providersStatus();
  }

  async providersDoctor(): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).providersDoctor();
  }

  async providerCredentials(): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).providerCredentials();
  }

  async setProviderCredential(provider: ProviderId, envVar: string, value: string): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).setProviderCredential(provider, envVar, value);
  }

  async clearProviderCredential(provider: ProviderId): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).clearProviderCredential(provider);
  }

  async setProviderStatus(provider: ProviderId, availability: ProviderAvailability): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).setProviderStatus(provider, availability);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const created = await new Controller({ rootDir: this.config.cwd }).taskCreate(input.goal, {
      allowedFiles: input.allowedFiles,
      risk: input.risk,
    }) as { task: Task };
    return created.task;
  }

  async taskStatus(taskId: string): Promise<TaskState> {
    return readState(this.config.paths, taskId);
  }

  async planTask(taskId: string): Promise<TaskPlan> {
    return readPlan(this.config.paths, taskId);
  }

  async dryRunTask(taskId: string, options: ProviderRunOptions = {}): Promise<TaskState> {
    await new Controller({ rootDir: this.config.cwd }).taskDryRun(taskId, options.provider, options.modelId);
    return readState(this.config.paths, taskId);
  }

  async runTask(taskId: string, options: ProviderRunOptions = {}): Promise<TaskState> {
    await new Controller({ rootDir: this.config.cwd }).taskRun(taskId, options.provider ?? "manual", options.modelId);
    return readState(this.config.paths, taskId);
  }

  async diffTask(taskId: string): Promise<{ taskId: string; diff: string }> {
    const state = await readState(this.config.paths, taskId);
    return {
      taskId,
      diff: state.workerId ? await readTextIfExists(join(taskDir(this.config.paths, taskId), "workers", state.workerId, "diff.patch")) : "",
    };
  }

  async validateTask(taskId: string): Promise<ValidationResult> {
    return new Controller({ rootDir: this.config.cwd }).taskValidate(taskId);
  }

  async reviewTask(taskId: string): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).taskReview(taskId);
  }

  async acceptTask(taskId: string): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).taskAccept(taskId);
  }

  async rejectTask(taskId: string): Promise<TaskState> {
    return new Controller({ rootDir: this.config.cwd }).taskReject(taskId);
  }

  async cancelTask(taskId: string): Promise<TaskState> {
    return new Controller({ rootDir: this.config.cwd }).taskCancel(taskId);
  }

  async pauseTask(taskId: string): Promise<TaskState> {
    return new Controller({ rootDir: this.config.cwd }).taskPause(taskId);
  }

  async resumeTask(taskId: string): Promise<TaskState> {
    return new Controller({ rootDir: this.config.cwd }).taskResume(taskId);
  }

  async recoverTask(taskId?: string, options: TaskRecoveryOptions = {}): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).taskRecover(taskId, options);
  }

  async rollbackTask(taskId: string): Promise<TaskState> {
    return new Controller({ rootDir: this.config.cwd }).taskRollback(taskId);
  }

  async queueStatus(): Promise<unknown> {
    return new Controller({ rootDir: this.config.cwd }).queueStatus();
  }

  async queuePause(taskId?: string): Promise<QueueItem> {
    return new Controller({ rootDir: this.config.cwd }).queuePause(taskId);
  }

  async queueResume(taskId?: string): Promise<QueueItem> {
    return new Controller({ rootDir: this.config.cwd }).queueResume(taskId);
  }

  async queueCancel(taskId?: string): Promise<QueueItem> {
    return new Controller({ rootDir: this.config.cwd }).queueCancel(taskId);
  }
}
