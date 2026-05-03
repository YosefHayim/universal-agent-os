/**
 * Kilo plan detector.
 *
 * Source: `~/.local/share/kilo/auth.json` — Kilo CLI writes its OAuth tokens
 * here as `{ kilo: { type, access, refresh, expires }, anthropic?: {...} }`.
 * The JWTs carry identity claims (`kiloUserId`, `env`) but no subscription
 * tier field, so plan tier cannot be read directly. Kilo currently has only
 * a single Free product tier publicly, so an authenticated kilo entry maps
 * to "Free" rather than "?". Update this if Kilo introduces paid tiers and
 * starts encoding them in the JWT.
 */

import { join } from "node:path";
import {
  type ProviderSubscription,
  getRecordField,
  getStringField,
  readJsonSafe,
} from "./types.js";

export async function detectKilo(): Promise<ProviderSubscription> {
  const home = process.env.HOME ?? "";
  const path = join(home, ".local", "share", "kilo", "auth.json");
  const root = await readJsonSafe(path);
  if (!root) return { active: false, plan: "—", source: path };
  const kilo = getRecordField(root, "kilo");
  const active = Boolean(kilo && (getStringField(kilo, "access") || getStringField(kilo, "refresh") || getStringField(kilo, "key")));
  return { active, plan: active ? "Free" : "—", source: path };
}
