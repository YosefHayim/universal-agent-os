import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROVIDERS, DIRECT_LAUNCH_PROVIDERS } from "../config/defaults.js";
import {
  applyProviderCredentialEnv,
  clearProviderCredential,
  ensureRuntime,
  providerCredentialSummaries,
  readProviderStatus,
  resolveRuntimePaths,
  setProviderAvailability,
  setProviderCredential,
} from "../config/config-loader.js";
import type { ProviderAvailability, ProviderId, RiskLevel, RuntimePaths, Task, TaskPlan, TaskState, ValidationResult } from "./types.js";
import { appendEvent, readTaskEvents } from "./events.js";
import { compileContext } from "../context/compiler.js";
import { listModels, modelsDoctor, refreshModels } from "../models/index.js";
import { runExternalProvider, type ExternalProviderProgress } from "../providers/external-runner.js";
import { runManualProvider, runManualTask } from "../providers/manual.js";
import { providerAdapter } from "../providers/registry.js";
import { buildReviewerInput } from "../review/delta-review.js";
import { judgeMerge } from "../review/merge-judge.js";
import { chooseRoute } from "../routing/broker.js";
import { summarizeUsage, type UsageSummary } from "../usage/usage.js";
import { validateTaskRun } from "../validators/pipeline.js";
import { taskDir, createTask, latestTaskId, listTaskIds, readPlan, readState, readTask, readTaskSummary, readTextIfExists, updateState } from "./lifecycle.js";
import { withTaskLock } from "./locks.js";

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
    return {
      ok: true,
      rootDir: this.paths.rootDir,
      runtimeDir: this.paths.runtimeDir,
      providerOverrides: providerStatus.providers,
      providerHealth,
      generatedSourcePolicy: "Agent OS source is TypeScript; JavaScript is build output only.",
    };
  }

  async status(): Promise<Record<string, unknown>> {
    await this.init();
    const taskIds = await listTaskIds(this.paths);
    const latest = taskIds.at(-1);
    return { rootDir: this.paths.rootDir, taskCount: taskIds.length, latestTaskId: latest };
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
    await appendEvent(taskDir(this.paths, id), { taskId: id, event: "context_compiled", message: `${bundle.selectedFiles.length} files selected` });
    await appendEvent(taskDir(this.paths, id), {
      taskId: id,
      event: "launch_preview_built",
      provider: route.provider,
      model: selectedModelId,
      modelCatalogSource: route.model?.source.kind,
      message: `${launchPreview.command} ${launchPreview.args.join(" ")}`.trim(),
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
    options: { onProgress?: (event: ExternalProviderProgress) => void | Promise<void> } = {},
  ): Promise<Record<string, unknown>> {
    await this.init();
    const id = await this.resolveTaskId(taskId);
    const dir = taskDir(this.paths, id);
    return withTaskLock(dir, async () => {
      const task = await readTask(this.paths, id);
      const bundle = await compileContext(this.paths, task);
      await appendEvent(taskDir(this.paths, id), { taskId: id, event: "context_compiled", message: `${bundle.selectedFiles.length} files selected` });
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
      await updateState(this.paths, id, "running", { provider: route.provider, modelId: selectedModelId, message: "worker started" });
      if (route.provider !== "manual") {
        const adapter = providerAdapter(route.provider);
        const capabilities = await adapter.capabilities({ paths: this.paths, cwd: this.paths.rootDir });
        if (!capabilities.canLaunch || !DIRECT_LAUNCH_PROVIDERS.includes(route.provider)) {
          await updateState(this.paths, id, "failed", { provider: route.provider, modelId: selectedModelId, message: `${route.provider} direct worker launch is not active` });
          throw new Error(`${route.provider} direct worker launch is not active`);
        }
        const run = await runExternalProvider({ paths: this.paths, cwd: this.paths.rootDir }, task, bundle.bundlePath, adapter, {
          modelId: selectedModelId,
          onProgress: async (event) => {
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
            }
            await options.onProgress?.(event);
          },
        });
        await updateState(this.paths, id, run.result.status === "completed" ? "completed" : "failed", { provider: route.provider, workerId: run.worker.workerId, modelId: selectedModelId, message: run.result.summary });
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
      await appendEvent(taskDir(this.paths, id), { taskId: id, event: "worker_prepared", provider: "manual", workerId: "manual-1", message: "manual provider workspace" });
      const run = await runManualProvider({ paths: this.paths, cwd: this.paths.rootDir }, task, bundle.bundlePath, { workerId: "manual-1" });
      const durationMs = Date.now() - manualStarted;
      const usage = { exact: false, estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedTotalTokens: 0, inputChars: 0, outputChars: 0 };
      await appendEvent(taskDir(this.paths, id), { taskId: id, event: "worker_finished", provider: "manual", workerId: run.worker.workerId, durationMs, usage, message: run.result.summary });
      await updateState(this.paths, id, "completed", { provider: route.provider, workerId: run.worker.workerId, message: run.result.summary });
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
    await updateState(this.paths, id, result.status === "passed" ? "validated" : "failed", { message: `validation ${result.status}` });
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
    return { taskId: id, decision };
  }

  async taskReject(taskId?: string): Promise<TaskState> {
    await this.init();
    return updateState(this.paths, await this.resolveTaskId(taskId), "rejected", { message: "rejected by user" });
  }

  async taskCancel(taskId?: string): Promise<TaskState> {
    await this.init();
    return updateState(this.paths, await this.resolveTaskId(taskId), "cancelled", { message: "cancelled by user" });
  }

  async taskResume(taskId?: string): Promise<TaskState> {
    await this.init();
    return updateState(this.paths, await this.resolveTaskId(taskId), "planned", { message: "ready to resume" });
  }

  async taskRollback(taskId?: string): Promise<TaskState> {
    await this.init();
    return updateState(this.paths, await this.resolveTaskId(taskId), "planned", { message: "rollback recorded; isolated workspace left for inspection" });
  }

  private async resolveTaskId(taskId?: string): Promise<string> {
    if (taskId) return taskId;
    const latest = await latestTaskId(this.paths);
    if (!latest) throw new Error("No task id provided and no tasks exist");
    return latest;
  }
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
    return createTask(input.goal, { allowedFiles: input.allowedFiles, risk: input.risk, rootDir: this.config.cwd });
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

  async resumeTask(taskId: string): Promise<TaskState> {
    return new Controller({ rootDir: this.config.cwd }).taskResume(taskId);
  }

  async rollbackTask(taskId: string): Promise<TaskState> {
    return new Controller({ rootDir: this.config.cwd }).taskRollback(taskId);
  }
}
