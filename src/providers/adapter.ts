import type {
  CostCategory,
  LaunchCommand,
  LimitSignal,
  ModelCatalogEntry,
  ProviderCapabilities,
  ProviderContext,
  ProviderDetection,
  ProviderId,
  ProviderResult,
  ProviderStatus,
  Task,
} from "../core/types.js";

export interface ModelSelection {
  provider: ProviderId;
  modelId?: string;
  costCategory?: CostCategory;
  approvedPaid?: boolean;
}

export interface ProviderAdapter {
  id: ProviderId;
  detect(ctx: ProviderContext): Promise<ProviderDetection>;
  status(ctx: ProviderContext): Promise<ProviderStatus>;
  capabilities(ctx: ProviderContext): Promise<ProviderCapabilities>;
  discoverModels(ctx: ProviderContext): Promise<ModelCatalogEntry[]>;
  buildLaunchCommand(ctx: ProviderContext, task: Task, bundlePath: string, model?: string | ModelSelection): Promise<LaunchCommand>;
  parseOutput(ctx: ProviderContext, stdout: string, stderr: string): Promise<ProviderResult>;
  isLimitReached(ctx: ProviderContext, exitCode: number, stdout: string, stderr: string): Promise<LimitSignal>;
  supportsWorktree(ctx: ProviderContext): Promise<boolean>;
  supportsStructuredOutput(ctx: ProviderContext): Promise<boolean>;
}

export function limitFromText(stdout: string, stderr: string): LimitSignal {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  const limited = /quota|rate limit|too many requests|exhausted|insufficient credits|payment required/.test(text);
  return limited ? { limited, reason: "provider reported quota, rate, or credit limit" } : { limited: false };
}
