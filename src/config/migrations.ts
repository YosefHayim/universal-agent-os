import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimePaths } from "../core/types.js";

export const CURRENT_RUNTIME_VERSION = 1;

export interface RuntimeInfo {
  version: number;
  createdAt: string;
  updatedAt: string;
  migrations: string[];
}

export interface RuntimeUpgradeResult {
  runtimePath: string;
  fromVersion: number;
  toVersion: number;
  changed: boolean;
  backupPath?: string;
  info: RuntimeInfo;
}

interface RuntimeMigration {
  from: number;
  to: number;
  id: string;
  apply(info: RuntimeInfo, now: string): RuntimeInfo;
}

const MIGRATIONS: RuntimeMigration[] = [
  {
    from: 0,
    to: 1,
    id: "runtime:initialize",
    apply(info, now) {
      return {
        version: 1,
        createdAt: info.createdAt || now,
        updatedAt: now,
        migrations: [...new Set([...(info.migrations ?? []), "runtime:initialize"])],
      };
    },
  },
];

export function runtimeInfoPath(paths: RuntimePaths): string {
  return join(paths.runtimeDir, "runtime.json");
}

export async function readRuntimeInfo(paths: RuntimePaths): Promise<RuntimeInfo | undefined> {
  try {
    return normalizeRuntimeInfo(JSON.parse(await readFile(runtimeInfoPath(paths), "utf8")));
  } catch (error) {
    if (isFileMissing(error)) return undefined;
    throw error;
  }
}

export async function upgradeRuntime(paths: RuntimePaths): Promise<RuntimeUpgradeResult> {
  const runtimePath = runtimeInfoPath(paths);
  const current = await readRuntimeInfo(paths);
  const now = new Date().toISOString();
  const fromVersion = current?.version ?? 0;
  let info = current ?? { version: 0, createdAt: now, updatedAt: now, migrations: [] };
  let backupPath: string | undefined;

  if (info.version > CURRENT_RUNTIME_VERSION) {
    throw new Error(`Agent OS runtime ${info.version} is newer than this CLI supports (${CURRENT_RUNTIME_VERSION})`);
  }

  if (info.version < CURRENT_RUNTIME_VERSION && current) {
    backupPath = join(paths.runtimeDir, "backups", `runtime-v${info.version}-${safeTimestamp(now)}.json`);
    await writeJson(backupPath, current);
  }

  while (info.version < CURRENT_RUNTIME_VERSION) {
    const migration = MIGRATIONS.find((item) => item.from === info.version);
    if (!migration) throw new Error(`No Agent OS runtime migration from ${info.version} to ${CURRENT_RUNTIME_VERSION}`);
    info = migration.apply(info, now);
    if (info.version !== migration.to) throw new Error(`Runtime migration ${migration.id} did not advance to ${migration.to}`);
  }

  const changed = fromVersion !== info.version || !current;
  if (changed) {
    await mkdir(dirname(runtimePath), { recursive: true });
    await writeJson(runtimePath, info);
  }

  return { runtimePath, fromVersion, toVersion: info.version, changed, backupPath, info };
}

function normalizeRuntimeInfo(value: unknown): RuntimeInfo {
  const record = typeof value === "object" && value ? value as Partial<RuntimeInfo> : {};
  return {
    version: typeof record.version === "number" && Number.isInteger(record.version) ? record.version : 0,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    migrations: Array.isArray(record.migrations) ? record.migrations.filter((item): item is string => typeof item === "string") : [],
  };
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isFileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
