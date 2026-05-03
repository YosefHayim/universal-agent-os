/**
 * Z.ai / GLM plan detector.
 *
 * No standardized local auth file is known. We probe the conventional spots
 * (`~/.zai/config.json`, `~/.glm/config.json`); if neither exists we report
 * inactive. Z.ai has no public local plan-tier signal, so when a config is
 * found we report "?" — wrong is worse than unknown.
 */

import { join } from "node:path";
import { type ProviderSubscription, readJsonSafe } from "./types.js";

export async function detectZai(): Promise<ProviderSubscription> {
  const home = process.env.HOME ?? "";
  const candidates = [join(home, ".zai", "config.json"), join(home, ".glm", "config.json")];
  for (const path of candidates) {
    const root = await readJsonSafe(path);
    if (root) return { active: true, plan: "?", source: path };
  }
  return { active: false, plan: "—", source: candidates.join("|") };
}
