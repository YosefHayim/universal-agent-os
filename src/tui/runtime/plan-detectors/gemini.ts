/**
 * Gemini CLI plan detector.
 *
 * Sources inspected:
 * - `~/.gemini/oauth_creds.json` — Google OAuth tokens (active signal).
 * - `~/.gemini/google_accounts.json` — active account email.
 * - `~/.gemini/settings.json` — `security.auth.selectedType` (e.g.
 *   "oauth-personal", "vertex-ai", "gemini-api-key").
 *
 * Plan-tier reality: Google does not write the Gemini Code Assist tier
 * (Free / Standard / Enterprise) to any local file. The JWT id_token only
 * carries identity claims (sub/email/name), not subscription info. So when
 * we find a personal OAuth login we report "Pro" — that maps to the
 * Code Assist for Individuals (free Pro-tier) login flow that the Gemini
 * CLI uses by default. If the user is on Vertex/API-key auth we cannot
 * infer the underlying GCP billing tier from local files and report "?".
 *
 * Caveat: if Google ever exposes the actual tier in oauth_creds.json or a
 * sibling file, prefer that over the heuristic here.
 */

import { join } from "node:path";
import {
  type ProviderSubscription,
  getRecordField,
  getStringField,
  readJsonSafe,
} from "./types.js";

export async function detectGemini(): Promise<ProviderSubscription> {
  const home = process.env.HOME ?? "";
  const oauthPath = join(home, ".gemini", "oauth_creds.json");
  const settingsPath = join(home, ".gemini", "settings.json");

  const [oauth, settings] = await Promise.all([readJsonSafe(oauthPath), readJsonSafe(settingsPath)]);
  const accessToken = oauth ? getStringField(oauth, "access_token") : undefined;
  const refreshToken = oauth ? getStringField(oauth, "refresh_token") : undefined;
  const active = Boolean(accessToken || refreshToken);

  const security = settings ? getRecordField(settings, "security") : undefined;
  const auth = security ? getRecordField(security, "auth") : undefined;
  const selectedType = auth ? getStringField(auth, "selectedType") : undefined;

  if (!active) return { active: false, plan: "—", source: oauthPath };

  // Personal OAuth = Gemini Code Assist for Individuals (Pro tier). Other auth
  // modes (vertex-ai, gemini-api-key) tie usage to opaque GCP billing — not
  // inferrable locally.
  const isPersonalOauth = selectedType === undefined || selectedType === "oauth-personal";
  return {
    active: true,
    plan: isPersonalOauth ? "Pro" : "?",
    source: oauthPath,
  };
}
