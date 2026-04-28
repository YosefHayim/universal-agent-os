import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_PROVIDERS, PROVIDER_CREDENTIAL_ENV_VARS, RUNTIME_DIR } from "./defaults.js";
import type { ProviderAvailability, ProviderId, ProviderStatus, RuntimePaths } from "../core/types.js";

export interface ProviderStatusConfig {
  providers: Partial<Record<ProviderId, ProviderAvailability>>;
  details?: Partial<Record<ProviderId, string>>;
  updatedAt: string;
}

export interface ProviderCredentialEntry {
  envVar: string;
  value: string;
  updatedAt: string;
}

export interface ProviderCredentialConfig {
  providers: Partial<Record<ProviderId, ProviderCredentialEntry>>;
  updatedAt: string;
}

export interface ProviderCredentialSummary {
  provider: ProviderId;
  envVars: string[];
  configured: boolean;
  source: "agent-os" | "environment" | "missing" | "not-supported";
  envVar?: string;
  updatedAt?: string;
}

export interface AgentOsConfig {
  cwd: string;
  paths: RuntimePaths;
}

export interface LoadConfigOptions {
  cwd?: string;
}

export async function loadAgentOsConfig(options: LoadConfigOptions = {}): Promise<AgentOsConfig> {
  const cwd = options.cwd ?? process.cwd();
  const paths = await ensureRuntime(resolveRuntimePaths(cwd));
  return { cwd: paths.rootDir, paths };
}

export function resolveRuntimePaths(rootDir = process.cwd()): RuntimePaths {
  const runtimeDir = join(rootDir, RUNTIME_DIR);
  return {
    rootDir,
    runtimeDir,
    configDir: join(runtimeDir, "config"),
    tasksDir: join(runtimeDir, "tasks"),
    cacheDir: join(runtimeDir, "cache"),
    modelCacheDir: join(runtimeDir, "cache", "models"),
  };
}

export async function ensureRuntime(paths = resolveRuntimePaths()): Promise<RuntimePaths> {
  await Promise.all([
    mkdir(paths.configDir, { recursive: true }),
    mkdir(paths.tasksDir, { recursive: true }),
    mkdir(paths.modelCacheDir, { recursive: true }),
  ]);
  await ensureRuntimeGitignore(paths);
  await ensureProviderStatus(paths);
  await applyProviderCredentialEnv(paths);
  return paths;
}

export async function ensureRuntimeLayout(paths: RuntimePaths): Promise<void> {
  await ensureRuntime(paths);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function providerStatusPath(paths: RuntimePaths): string {
  return join(paths.configDir, "provider-status.json");
}

export function providerCredentialsPath(paths: RuntimePaths): string {
  return join(paths.configDir, "provider-credentials.json");
}

export async function readProviderStatus(paths: RuntimePaths): Promise<ProviderStatusConfig> {
  await ensureProviderStatus(paths);
  return readJson<ProviderStatusConfig>(providerStatusPath(paths));
}

export async function writeProviderStatus(paths: RuntimePaths, config: ProviderStatusConfig): Promise<void> {
  await writeJson(providerStatusPath(paths), config);
}

export async function setProviderAvailability(paths: RuntimePaths, provider: ProviderId, availability: ProviderAvailability): Promise<ProviderStatusConfig> {
  const config = await readProviderStatus(paths);
  config.providers[provider] = availability;
  config.updatedAt = new Date().toISOString();
  await writeProviderStatus(paths, config);
  return config;
}

export async function getProviderStatus(paths: RuntimePaths, provider: ProviderId): Promise<ProviderStatus> {
  const config = await readProviderStatus(paths);
  const availability = config.providers[provider] ?? (provider === "manual" ? "available" : "unknown");
  return {
    provider,
    availability,
    detail:
      config.details?.[provider] ??
      (provider === "manual"
        ? "Manual provider is available without cloud credentials."
        : "Provider adapter is not implemented in the core MVP."),
    checkedAt: config.updatedAt,
  };
}

export async function getAllProviderStatuses(paths: RuntimePaths): Promise<ProviderStatus[]> {
  return Promise.all(DEFAULT_PROVIDERS.map((provider) => getProviderStatus(paths, provider)));
}

export async function setProviderStatusOverride(
  paths: RuntimePaths,
  provider: ProviderId,
  availability: ProviderAvailability,
  detail = "Manual override",
): Promise<ProviderStatus> {
  const config = await readProviderStatus(paths);
  config.providers[provider] = availability;
  config.details ??= {};
  config.details[provider] = detail;
  config.updatedAt = new Date().toISOString();
  await writeProviderStatus(paths, config);
  return {
    provider,
    availability,
    detail,
    checkedAt: config.updatedAt,
  };
}

export async function readProviderCredentials(paths: RuntimePaths): Promise<ProviderCredentialConfig> {
  try {
    return await readJson<ProviderCredentialConfig>(providerCredentialsPath(paths));
  } catch {
    return { providers: {}, updatedAt: new Date(0).toISOString() };
  }
}

export async function providerCredentialSummaries(paths: RuntimePaths): Promise<ProviderCredentialSummary[]> {
  const credentials = await readProviderCredentials(paths);
  return DEFAULT_PROVIDERS.map((provider) => {
    const envVars = PROVIDER_CREDENTIAL_ENV_VARS[provider] ?? [];
    const stored = credentials.providers[provider];
    const envVar = envVars.find((name) => Boolean(process.env[name]?.trim()));
    if (stored) {
      return { provider, envVars, configured: true, source: "agent-os", envVar: stored.envVar, updatedAt: stored.updatedAt };
    }
    if (envVar) {
      return { provider, envVars, configured: true, source: "environment", envVar };
    }
    return {
      provider,
      envVars,
      configured: false,
      source: envVars.length ? "missing" : "not-supported",
      envVar: envVars[0],
    };
  });
}

export async function setProviderCredential(
  paths: RuntimePaths,
  provider: ProviderId,
  envVar: string,
  value: string,
): Promise<ProviderCredentialSummary> {
  const allowed = PROVIDER_CREDENTIAL_ENV_VARS[provider] ?? [];
  if (!allowed.length) throw new Error(`${provider} does not support Agent OS-managed API keys`);
  if (!allowed.includes(envVar)) throw new Error(`${envVar} is not a supported credential env var for ${provider}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error("API key cannot be empty");
  const credentials = await readProviderCredentials(paths);
  const updatedAt = new Date().toISOString();
  credentials.providers[provider] = { envVar, value: trimmed, updatedAt };
  credentials.updatedAt = updatedAt;
  await writeSecretJson(providerCredentialsPath(paths), credentials);
  process.env[envVar] = trimmed;
  return { provider, envVars: allowed, configured: true, source: "agent-os", envVar, updatedAt };
}

export async function clearProviderCredential(paths: RuntimePaths, provider: ProviderId): Promise<ProviderCredentialSummary> {
  const credentials = await readProviderCredentials(paths);
  const stored = credentials.providers[provider];
  const envVar = stored?.envVar;
  delete credentials.providers[provider];
  credentials.updatedAt = new Date().toISOString();
  await writeSecretJson(providerCredentialsPath(paths), credentials);
  if (envVar && process.env[envVar] === stored?.value) delete process.env[envVar];
  return (await providerCredentialSummaries(paths)).find((entry) => entry.provider === provider)!;
}

export async function applyProviderCredentialEnv(paths: RuntimePaths, options: { provider?: ProviderId; overwrite?: boolean } = {}): Promise<void> {
  const credentials = await readProviderCredentials(paths);
  for (const [provider, credential] of Object.entries(credentials.providers) as Array<[ProviderId, ProviderCredentialEntry]>) {
    if (options.provider && provider !== options.provider) continue;
    if (options.overwrite || !process.env[credential.envVar]) process.env[credential.envVar] = credential.value;
  }
}

async function ensureProviderStatus(paths: RuntimePaths): Promise<void> {
  const path = providerStatusPath(paths);
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as ProviderStatusConfig;
    let changed = false;
    current.providers ??= {};
    for (const provider of DEFAULT_PROVIDERS) {
      if (current.providers[provider] === undefined) {
        current.providers[provider] = provider === "manual" ? "available" : "unknown";
        changed = true;
      }
    }
    if (changed) {
      current.updatedAt = new Date().toISOString();
      await writeJson(path, current);
    }
  } catch {
    await writeJson(path, {
      providers: Object.fromEntries(DEFAULT_PROVIDERS.map((provider) => [provider, provider === "manual" ? "available" : "unknown"])),
      updatedAt: new Date().toISOString(),
    } satisfies ProviderStatusConfig);
  }
}

async function ensureRuntimeGitignore(paths: RuntimePaths): Promise<void> {
  const path = join(paths.runtimeDir, ".gitignore");
  try {
    await readFile(path, "utf8");
  } catch {
    await writeFile(path, "*\n!.gitignore\n", { encoding: "utf8", mode: 0o644 });
  }
}

async function writeSecretJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
