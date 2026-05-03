/**
 * Cline plan detector.
 *
 * Sources inspected:
 * - `~/.cline/data/settings/providers.json` — for each configured provider,
 *   stores `settings.auth.{accessToken,refreshToken,expiresAt}` plus a
 *   `model` slug like `"openrouter/free"` or `"cline/pro"`. The model slug's
 *   suffix is a reliable plan hint for Cline-managed routing.
 * - `~/.cline/data/secrets.json` — keyed map of WorkOS id_tokens. Only used
 *   as an active-auth signal; the JWT does not carry plan claims.
 *
 * Cline itself currently has no public paid tier separate from "Free" + the
 * BYO-key options it routes to, so unless the model slug includes a paid
 * tier word ("pro", "team"), we report Free.
 */

import { join } from "node:path";
import {
  type ProviderSubscription,
  getRecordField,
  getStringField,
  normalizePlanLabel,
  readJsonSafe,
} from "./types.js";

export async function detectCline(): Promise<ProviderSubscription> {
  const home = process.env.HOME ?? "";
  const path = join(home, ".cline", "data", "settings", "providers.json");
  const root = await readJsonSafe(path);
  if (!root) return { active: false, plan: "—", source: path };

  const providers = getRecordField(root, "providers");
  const cline = providers ? getRecordField(providers, "cline") : undefined;
  const settings = cline ? getRecordField(cline, "settings") : undefined;
  const auth = settings ? getRecordField(settings, "auth") : undefined;
  const active = Boolean(auth && (getStringField(auth, "accessToken") || getStringField(auth, "refreshToken")));

  const model = settings ? getStringField(settings, "model") : undefined;
  // Model slugs look like "openrouter/free", "cline/pro" — split on the last
  // "/" and run through the same label normalizer used elsewhere so vendor
  // renames are tolerated.
  const slugTail = model?.split("/").pop();
  const normalized = slugTail ? normalizePlanLabel(slugTail) : "?";
  const plan = active ? (normalized === "?" ? "Free" : normalized) : "—";

  return { active, plan, source: path };
}
