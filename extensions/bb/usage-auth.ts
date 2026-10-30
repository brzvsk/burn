import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** The plugin KV key holding the secret that mints each thread's usage-report token. */
export const USAGE_SECRET_KEY = "usage-secret";

/** A secret that survives plugin reloads, so a running pi session keeps reporting after one. */
export async function ensureUsageSecret(bb: BbPluginApi): Promise<string> {
  try {
    const held = await bb.storage.kv.get<unknown>(USAGE_SECRET_KEY);
    if (typeof held === "string" && held.length >= 32) return held;
    const secret = randomBytes(32).toString("hex");
    await bb.storage.kv.set(USAGE_SECRET_KEY, secret);
    return secret;
  } catch (err) {
    // Storage is unavailable; a per-load secret still gates reports, but running sessions must restart to get the new token.
    const detail = err instanceof Error ? err.message : String(err);
    bb.log.warn(`could not read or write Burn's usage secret, so running pi sessions must restart before they report again: ${detail}`);
    return randomBytes(32).toString("hex");
  }
}

/** One thread's token: an HMAC of its id, so the server can check it without keeping a map of issued tokens. */
export const usageToken = (secret: string, threadId: string): string =>
  createHmac("sha256", secret).update(threadId).digest("hex");

/** Constant-time token comparison that never throws on a length mismatch. */
export function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
