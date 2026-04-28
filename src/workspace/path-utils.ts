import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export function resolveInside(rootDir: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(resolvedRoot, normalized);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`path escapes workspace root: ${relativePath}`);
  }

  return resolvedPath;
}

export function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");

  if (!normalized || normalized === ".") {
    throw new Error("relative path is required");
  }

  if (normalized.split("/").includes("..")) {
    throw new Error(`path traversal is not allowed: ${relativePath}`);
  }

  return normalized;
}

export async function expandAllowedFiles(rootDir: string, allowedFiles: string[]): Promise<string[]> {
  const selected = new Set<string>();

  for (const allowed of allowedFiles) {
    const normalized = normalizeRelativePath(allowed);

    if (normalized.endsWith("/**")) {
      const dir = normalized.slice(0, -3);
      const absoluteDir = resolveInside(rootDir, dir);
      for (const file of await listFiles(absoluteDir, dir)) {
        selected.add(file);
      }
      continue;
    }

    if (normalized.includes("*")) {
      continue;
    }

    const absoluteFile = resolveInside(rootDir, normalized);
    try {
      const fileStat = await stat(absoluteFile);
      if (fileStat.isFile()) {
        selected.add(normalized);
      }
    } catch {
      // Missing files can still be created by a worker, but they are not context inputs.
    }
  }

  return [...selected].sort();
}

async function listFiles(absoluteDir: string, relativeDir: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".agent-os") {
      continue;
    }

    const childRelative = `${relativeDir}/${entry.name}`;
    const childAbsolute = path.join(absoluteDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(childAbsolute, childRelative)));
    } else if (entry.isFile()) {
      files.push(childRelative);
    }
  }

  return files.sort();
}
