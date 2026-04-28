import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const EXCLUDED = new Set([".git", ".agent-os", "node_modules", "dist", "coverage", ".coverage"]);

export async function listRepoFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(rootDir, out, rootDir);
  return out.sort();
}

async function walk(dir: string, out: string[], rootDir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, out, rootDir);
    } else if (entry.isFile()) {
      const info = await stat(path);
      if (info.size <= 64 * 1024) out.push(relative(rootDir, path));
    }
  }
}
