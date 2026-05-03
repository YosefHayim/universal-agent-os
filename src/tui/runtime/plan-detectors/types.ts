/**
 * Shared types and helpers for per-provider plan detectors.
 *
 * Each provider stores auth/plan info differently — JSON in $HOME, OS keychain,
 * or JWT claims. The detector contract intentionally stays narrow so the panel
 * can render a uniform row regardless of how the data was sourced.
 */

import { readFile } from "node:fs/promises";

/** Normalized plan label used by the provider-limits panel. */
export type PlanLabel = "Max" | "Pro" | "Plus" | "Team" | "Free" | "—" | "?";

/**
 * Result of one provider's plan detection.
 *
 * Field semantics (kept small so panel rendering stays trivial):
 * - active=false  → no auth artifact found (truly logged out).
 * - active=true   → auth present; plan reflects best-known tier.
 * - plan="?"      → auth found but the tier is not exposed locally.
 * - plan="—"      → provider has no concept of a tier here (e.g. zai inactive).
 * - source        → path/identifier where the value came from, for debugging.
 */
export interface ProviderSubscription {
  plan: PlanLabel | string;
  active: boolean;
  source: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a JSON file safely; returns undefined for missing/unreadable/invalid files. */
export async function readJsonSafe(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decodes the payload of a JWT (no signature verification). Returns undefined on any error.
 * Used by detectors that read plan claims from id_tokens (Codex, Cline).
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed: unknown = JSON.parse(payload);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Returns a non-empty string field from a record, otherwise undefined. */
export function getStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Returns a nested record field, or undefined if the key is missing or non-object. */
export function getRecordField(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key];
  return isPlainObject(value) ? value : undefined;
}

/**
 * Maps a provider-specific plan string to one of the panel's normalized labels.
 * Most-specific match wins (max > team > pro > plus > free).
 *
 * Vendor-rename caveat: providers occasionally rename plan tiers
 * ("max" → "max-tier-1", "pro" → "pro-individual"). The substring matches stay
 * forgiving — anything containing "max" still maps to Max, etc. If a vendor
 * invents a wholly new word ("ultra"), it falls through to the raw string so a
 * future maintainer notices the unexpected label.
 */
export function normalizePlanLabel(plan: string | undefined): string {
  if (!plan) return "?";
  const lower = plan.toLowerCase();
  if (lower.includes("max")) return "Max";
  if (lower.includes("team")) return "Team";
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("plus")) return "Plus";
  if (lower.includes("free")) return "Free";
  return plan;
}
