export type RiskLevel = "low" | "medium" | "high";

export type ProviderId =
  | "manual"
  | "codex"
  | "claude"
  | "zai"
  | "opencode"
  | "kilo"
  | "cline"
  | "openrouter"
  | "github-models"
  | "gemini"
  | "nvidia-nim"
  | "mistral"
  | "groq";

export type ProviderAvailability = "available" | "unavailable" | "limited" | "unknown";

export type TaskStatus =
  | "created"
  | "planned"
  | "dry_run"
  | "running"
  | "paused"
  | "completed"
  | "validated"
  | "reviewed"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "stale"
  | "failed";

export type CostCategory = "free_api" | "free_quota" | "subscription" | "paid_api" | "unknown";

export type ModelAvailability = "available" | "remote" | "unavailable" | "unknown";

export type SourceKind = "provider_cli" | "provider_api" | "official_docs" | "user_config" | "observed";

export type Confidence = "high" | "medium" | "low";

export interface RuntimePaths {
  rootDir: string;
  runtimeDir: string;
  configDir: string;
  tasksDir: string;
  cacheDir: string;
  modelCacheDir: string;
}

export interface Task {
  id: string;
  goal: string;
  allowedFiles: string[];
  risk: RiskLevel;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  spawnedFromPath?: string;
}

export interface TaskState {
  taskId: string;
  status: TaskStatus;
  provider?: ProviderId;
  workerId?: string;
  modelId?: string;
  updatedAt: string;
  message?: string;
}

export interface TaskPlan {
  taskId: string;
  createdAt: string;
  steps: string[];
  validators: string[];
  requiresReview: boolean;
}

export interface EventRecord {
  taskId?: string;
  timestamp: string;
  event: string;
  provider?: ProviderId;
  model?: string;
  modelCatalogSource?: SourceKind;
  workerId?: string;
  durationMs?: number | null;
  outcome?: string | null;
  tokens?: number | null;
  costUsd?: number | null;
  usage?: ProviderUsage;
  message?: string;
}

export interface ProviderUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedTotalTokens?: number;
  inputChars?: number;
  outputChars?: number;
  exact: boolean;
}

export interface ProviderDetection {
  available: boolean;
  detail: string;
}

export interface ProviderStatus {
  provider: ProviderId;
  availability: ProviderAvailability;
  detail: string;
  checkedAt: string;
}

export interface ProviderCapabilities {
  provider: ProviderId;
  canLaunch: boolean;
  structuredOutput: boolean;
  worktree: boolean;
  cloudHosted: boolean;
}

export interface LaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ProviderResult {
  status: "completed" | "failed" | "limited";
  summary: string;
  changedFiles: string[];
  raw?: unknown;
}

export interface LimitSignal {
  limited: boolean;
  reason?: string;
}

export interface ProviderContext {
  paths: RuntimePaths;
  cwd: string;
}

export interface ModelPricing {
  inputPerMillionUsd?: number;
  cachedInputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
  flatUsd?: number;
  freeText?: string;
}

export interface ModelCatalogEntry {
  provider: ProviderId;
  id: string;
  displayName?: string;
  aliases: string[];
  availability: ModelAvailability;
  costCategory: CostCategory;
  pricing?: ModelPricing;
  capabilities: {
    coding?: boolean;
    reasoning?: boolean;
    toolUse?: boolean;
    structuredOutput?: boolean;
    vision?: boolean;
    longContext?: boolean;
  };
  contextWindow?: number;
  maxOutputTokens?: number;
  source: {
    kind: SourceKind;
    url?: string;
    command?: string;
    fetchedAt: string;
    expiresAt: string;
  };
  confidence: Confidence;
  requiresApproval: boolean;
  codingGate: {
    eligible: boolean;
    reasons: string[];
    smoke: "passed" | "required" | "failed" | "not_applicable";
  };
}

export interface ModelCatalogFile {
  provider: ProviderId;
  fetchedAt: string;
  expiresAt: string;
  source: string;
  entries: ModelCatalogEntry[];
}

export interface ValidationItem {
  id: string;
  status: "passed" | "failed" | "warning";
  message?: string;
}

export interface ValidationResult {
  status: "passed" | "failed";
  validators: ValidationItem[];
  requiresHuman: boolean;
  notes: string[];
}

export interface WorkerRecord {
  taskId: string;
  workerId: string;
  provider: ProviderId;
  workspacePath: string;
  isolation: "temp_copy" | "git_worktree";
  startedAt: string;
  finishedAt?: string;
  /** OS PID of the spawned worker subprocess; persisted so out-of-process dashboards can sample CPU/RAM via `ps`. */
  pid?: number;
}
