import { join } from "node:path";
import type { RuntimePaths } from "../core/types.js";

export function repoIndexCachePath(paths: RuntimePaths): string {
  return join(paths.cacheDir, "repo-index.json");
}

export function fileSummaryCachePath(paths: RuntimePaths): string {
  return join(paths.cacheDir, "file-summaries.json");
}
