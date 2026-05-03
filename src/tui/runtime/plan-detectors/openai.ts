/**
 * OpenAI Codex CLI plan detector.
 *
 * Source of truth: `~/.codex/auth.json` — the Codex CLI stores OAuth tokens
 * after `codex login`. The `tokens.id_token` (and `access_token`) JWTs carry
 * the claim `https://api.openai.com/auth.chatgpt_plan_type` whose value is
 * `"free" | "plus" | "pro" | "team" | ...`. This is authoritative for whichever
 * ChatGPT account the user actually signed Codex in with — note that does not
 * have to match a separate Anthropic/Claude Max plan, so a "free" reading
 * here means the ChatGPT account itself is free, even if other CLIs report
 * paid tiers.
 *
 * If the file is missing or unparseable, we mark the provider inactive.
 */

import { join } from "node:path";
import {
  type ProviderSubscription,
  decodeJwtPayload,
  getRecordField,
  getStringField,
  normalizePlanLabel,
  readJsonSafe,
} from "./types.js";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export async function detectOpenAI(): Promise<ProviderSubscription> {
  const home = process.env.HOME ?? "";
  const authPath = join(home, ".codex", "auth.json");
  const auth = await readJsonSafe(authPath);
  if (!auth) return { active: false, plan: "—", source: authPath };

  const tokens = getRecordField(auth, "tokens");
  const accessToken = tokens ? getStringField(tokens, "access_token") : undefined;
  const idToken = tokens ? getStringField(tokens, "id_token") : undefined;
  const payload = accessToken ? decodeJwtPayload(accessToken) : idToken ? decodeJwtPayload(idToken) : undefined;
  const claims = payload ? getRecordField(payload, OPENAI_AUTH_CLAIM) : undefined;
  const rawPlan = claims ? getStringField(claims, "chatgpt_plan_type") : undefined;
  const active = Boolean(accessToken || idToken);

  return {
    active,
    plan: rawPlan ? normalizePlanLabel(rawPlan) : active ? "?" : "—",
    source: authPath,
  };
}
