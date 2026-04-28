import type { ProviderAvailability, ProviderId, RuntimePaths } from "../core/types.js";
import { readProviderStatus, setProviderAvailability } from "../config/config-loader.js";

export async function getManualProviderAvailability(paths: RuntimePaths, provider: ProviderId): Promise<ProviderAvailability> {
  const config = await readProviderStatus(paths);
  return config.providers[provider] ?? "unknown";
}

export async function setManualProviderAvailability(paths: RuntimePaths, provider: ProviderId, availability: ProviderAvailability): Promise<void> {
  await setProviderAvailability(paths, provider, availability);
}
