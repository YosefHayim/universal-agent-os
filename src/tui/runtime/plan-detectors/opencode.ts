/**
 * Opencode plan detector.
 *
 * Source: `~/.local/share/opencode/auth.json` — opencode writes a map of
 * provider auth blobs ({ anthropic, openai, opencode, github-copilot, ... }).
 * The opencode product itself is open-source / no paid tier, so any
 * authenticated opencode entry maps to "Free". We treat presence of the
 * file with a non-empty `opencode` key (or any provider key) as "active".
 *
 * If opencode introduces a paid plan in future, look for a new field here
 * (the auth map is the file the CLI already writes after `opencode auth login`).
 */

import { join } from "node:path";
import { type ProviderSubscription, getRecordField, getStringField, readJsonSafe } from "./types.js";

export async function detectOpencode(): Promise<ProviderSubscription> {
  const home = process.env.HOME ?? "";
  const path = join(home, ".local", "share", "opencode", "auth.json");
  const root = await readJsonSafe(path);
  if (!root) return { active: false, plan: "—", source: path };

  const opencode = getRecordField(root, "opencode");
  const opencodeKey = opencode ? getStringField(opencode, "key") ?? getStringField(opencode, "access") : undefined;
  const anyAuth = opencodeKey ?? Object.keys(root).length > 0 ? "present" : undefined;
  const active = Boolean(opencodeKey || anyAuth);
  return { active, plan: active ? "Free" : "—", source: path };
}
