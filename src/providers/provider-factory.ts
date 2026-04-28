import type { LaunchCommand, ModelCatalogEntry, ProviderCapabilities, ProviderContext, ProviderDetection, ProviderId, ProviderResult, ProviderStatus, Task } from "../core/types.js";
import type { DiscoverySource } from "../models/sources/common.js";
import { limitFromText, type ProviderAdapter } from "./adapter.js";

export interface CloudCatalogProviderOptions {
  envVars?: string[];
}

export function cloudCatalogProvider(id: ProviderId, source: DiscoverySource, options: CloudCatalogProviderOptions = {}): ProviderAdapter {
  return {
    id,
    async detect(): Promise<ProviderDetection> {
      const credential = firstConfiguredEnv(options.envVars ?? []);
      if (credential || !options.envVars?.length) return { available: true, detail: credential ? `${credential} is set` : `${id} catalog source configured` };
      return { available: false, detail: `${options.envVars.join(" or ")} is not set; ${id} account cannot be checked` };
    },
    async status(): Promise<ProviderStatus> {
      const credential = firstConfiguredEnv(options.envVars ?? []);
      if (options.envVars?.length && !credential) {
        return {
          provider: id,
          availability: "unavailable",
          detail: `${options.envVars.join(" or ")} is not set; model catalog may still be public, but worker launch is not ready`,
          checkedAt: new Date().toISOString(),
        };
      }
      return {
        provider: id,
        availability: "limited",
        detail: `${credential} is set; account status still requires provider-specific API key smoke`,
        checkedAt: new Date().toISOString(),
      };
    },
    async capabilities(): Promise<ProviderCapabilities> {
      return { provider: id, canLaunch: false, structuredOutput: true, worktree: false, cloudHosted: true };
    },
    async discoverModels(): Promise<ModelCatalogEntry[]> {
      return (await source.discover()).entries;
    },
    async buildLaunchCommand(_ctx: ProviderContext, _task: Task, bundlePath: string, modelId?: string): Promise<LaunchCommand> {
      return { command: id, args: [modelId ?? "", bundlePath].filter(Boolean) };
    },
    async parseOutput(): Promise<ProviderResult> {
      return { status: "failed", summary: `${id} direct worker launch is not active until smoke-tested`, changedFiles: [] };
    },
    async isLimitReached(_ctx, _exitCode, stdout, stderr) {
      return limitFromText(stdout, stderr);
    },
    async supportsWorktree() {
      return false;
    },
    async supportsStructuredOutput() {
      return true;
    },
  };
}

function firstConfiguredEnv(names: string[]): string | undefined {
  return names.find((name) => Boolean(process.env[name]?.trim()));
}
