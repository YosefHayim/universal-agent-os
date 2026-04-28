import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_VALIDATORS } from "../config/defaults.js";
import { ensureRuntime, readJson, resolveRuntimePaths, writeJson } from "../config/config-loader.js";
import { appendEvent, readEvents } from "./events.js";
import { createTaskId } from "./ids.js";
import type { RiskLevel, RuntimePaths, Task, TaskPlan, TaskState, TaskStatus } from "./types.js";

export { writeJson } from "../config/config-loader.js";

export interface CreateTaskInput {
  goal: string;
  allowedFiles?: string[];
  risk?: RiskLevel;
}

export interface ContextBundle {
  bundlePath: string;
  filesPath: string;
}

export function taskDir(paths: RuntimePaths, taskId: string): string {
  return join(paths.tasksDir, taskId);
}

export function taskFile(paths: RuntimePaths, taskId: string): string {
  return join(taskDir(paths, taskId), "task.json");
}

export function stateFile(paths: RuntimePaths, taskId: string): string {
  return join(taskDir(paths, taskId), "state.json");
}

export function planFile(paths: RuntimePaths, taskId: string): string {
  return join(taskDir(paths, taskId), "plan.json");
}

export async function createTask(goal: string, options: { allowedFiles?: string[]; risk?: RiskLevel; rootDir?: string }): Promise<Task> {
  const paths = await ensureRuntime(resolveRuntimePaths(options.rootDir));
  const now = new Date().toISOString();
  const task: Task = {
    id: createTaskId(),
    goal,
    allowedFiles: options.allowedFiles?.length ? options.allowedFiles : ["**/*"],
    risk: options.risk ?? "medium",
    createdAt: now,
    updatedAt: now,
    cwd: paths.rootDir,
  };
  await mkdir(taskDir(paths, task.id), { recursive: true });
  await writeJson(taskFile(paths, task.id), task);
  await writeState(paths, task.id, { taskId: task.id, status: "created", updatedAt: now, message: "task created" });
  await writePlan(paths, {
    taskId: task.id,
    createdAt: now,
    steps: ["compile context", "run selected provider in isolated workspace", "validate result", "review diff"],
    validators: DEFAULT_VALIDATORS,
    requiresReview: task.risk !== "low",
  });
  await appendEvent(taskDir(paths, task.id), { taskId: task.id, event: "task_created", message: goal });
  return task;
}

export async function listTaskIds(paths: RuntimePaths): Promise<string[]> {
  await ensureRuntime(paths);
  return (await readdir(paths.tasksDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function latestTaskId(paths: RuntimePaths): Promise<string | undefined> {
  const ids = await listTaskIds(paths);
  return ids.at(-1);
}

export async function readTask(paths: RuntimePaths, taskId: string): Promise<Task> {
  return readJson<Task>(taskFile(paths, taskId));
}

export async function readState(paths: RuntimePaths, taskId: string): Promise<TaskState> {
  return readJson<TaskState>(stateFile(paths, taskId));
}

export async function writeState(paths: RuntimePaths, taskId: string, state: TaskState): Promise<void> {
  await writeJson(stateFile(paths, taskId), state);
}

export async function updateState(paths: RuntimePaths, taskId: string, status: TaskStatus, patch: Partial<TaskState> = {}): Promise<TaskState> {
  const previous = await readState(paths, taskId).catch(() => ({ taskId, status: "created" as const, updatedAt: new Date().toISOString() }));
  const state: TaskState = { ...previous, ...patch, taskId, status, updatedAt: new Date().toISOString() };
  await writeState(paths, taskId, state);
  await appendEvent(taskDir(paths, taskId), { taskId, event: `task_${status}`, message: state.message, provider: state.provider, workerId: state.workerId, model: state.modelId });
  return state;
}

export async function readPlan(paths: RuntimePaths, taskId: string): Promise<TaskPlan> {
  return readJson<TaskPlan>(planFile(paths, taskId));
}

export async function writePlan(paths: RuntimePaths, plan: TaskPlan): Promise<void> {
  await writeJson(planFile(paths, plan.taskId), plan);
}

export async function readTaskSummary(paths: RuntimePaths, taskId: string): Promise<{ task: Task; state: TaskState; events: number }> {
  const dir = taskDir(paths, taskId);
  const [task, state, events] = await Promise.all([readTask(paths, taskId), readState(paths, taskId), readEvents(dir)]);
  return { task, state, events: events.length };
}

export async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

export class TaskLifecycleStore {
  constructor(private readonly paths: RuntimePaths) {}

  async createTask(input: CreateTaskInput): Promise<Task> {
    return createTask(input.goal, { allowedFiles: input.allowedFiles, risk: input.risk, rootDir: this.paths.rootDir });
  }

  async readTask(taskId: string): Promise<Task> {
    return readTask(this.paths, taskId);
  }

  async listTasks(): Promise<Task[]> {
    const ids = await listTaskIds(this.paths);
    return Promise.all(ids.map((id) => readTask(this.paths, id)));
  }

  async createOrReadPlan(taskId: string): Promise<TaskPlan> {
    return readPlan(this.paths, taskId);
  }

  async readPlan(taskId: string): Promise<TaskPlan> {
    return readPlan(this.paths, taskId);
  }

  async writeState(taskId: string, state: TaskState): Promise<TaskState> {
    await writeState(this.paths, taskId, state);
    return state;
  }

  async updateState(
    taskId: string,
    status: TaskStatus,
    patch: Partial<Omit<TaskState, "taskId" | "status" | "updatedAt">> = {},
  ): Promise<TaskState> {
    return updateState(this.paths, taskId, status, patch);
  }

  async readState(taskId: string): Promise<TaskState> {
    return readState(this.paths, taskId);
  }

  async ensureContextBundle(taskId: string): Promise<ContextBundle> {
    const task = await readTask(this.paths, taskId);
    const plan = await readPlan(this.paths, taskId);
    const contextDir = join(taskDir(this.paths, taskId), "context");
    const bundlePath = join(contextDir, "bundle.md");
    const filesPath = join(contextDir, "files.json");
    await mkdir(contextDir, { recursive: true });
    await writeText(
      bundlePath,
      [
        "# Agent OS Task Bundle",
        "",
        `Task: ${task.id}`,
        `Goal: ${task.goal}`,
        `Risk: ${task.risk}`,
        `Allowed files: ${task.allowedFiles.join(", ")}`,
        "",
        "## Plan",
        ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
        "",
      ].join("\n"),
    );
    await writeJson(filesPath, { taskId, allowedFiles: task.allowedFiles, generatedAt: new Date().toISOString() });
    return { bundlePath, filesPath };
  }

  taskDir(taskId: string): string {
    return taskDir(this.paths, taskId);
  }

  workerDir(taskId: string, workerId: string): string {
    return join(taskDir(this.paths, taskId), "workers", workerId);
  }

  validationDir(taskId: string): string {
    return join(taskDir(this.paths, taskId), "validation");
  }

  reviewDir(taskId: string): string {
    return join(taskDir(this.paths, taskId), "review");
  }
}
