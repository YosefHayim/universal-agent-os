import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileSummary {
  path: string;
  summary: string;
  bytes?: number;
  hash?: string;
  updatedAt: string;
}

export class FileSummaryCache {
  private readonly summaries = new Map<string, FileSummary>();

  get(path: string): FileSummary | undefined {
    return this.summaries.get(path);
  }

  set(path: string, summary: string, bytes?: number, hash?: string): FileSummary {
    const value = { path, summary, bytes, hash, updatedAt: new Date().toISOString() };
    this.summaries.set(path, value);
    return value;
  }

  values(): FileSummary[] {
    return [...this.summaries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  static async load(path: string): Promise<FileSummaryCache> {
    const cache = new FileSummaryCache();
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      const entries = Array.isArray(parsed) ? parsed : [];
      for (const entry of entries) {
        if (isFileSummary(entry)) cache.summaries.set(entry.path, entry);
      }
    } catch (error) {
      if (!isFileMissing(error)) throw error;
    }
    return cache;
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(this.values(), null, 2)}\n`, "utf8");
  }
}

function isFileSummary(value: unknown): value is FileSummary {
  const item = value as FileSummary;
  return typeof item?.path === "string" && typeof item.summary === "string" && typeof item.updatedAt === "string";
}

function isFileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
