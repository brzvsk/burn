import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { ensureUsageSecret, sameToken, usageToken, USAGE_SECRET_KEY } from "../../extensions/bb/usage-auth.js";

const fake = (kv: object) => ({ storage: { kv }, log: { warn: vi.fn() } }) as unknown as BbPluginApi;

describe("ensureUsageSecret", () => {
  it("keeps the secret already in storage", async () => {
    const held = "a".repeat(64);
    const bb = fake({ get: async () => held, set: async () => undefined });
    expect(await ensureUsageSecret(bb)).toBe(held);
  });

  it("creates and stores one when storage has none", async () => {
    const set = vi.fn(async () => undefined);
    const bb = fake({ get: async () => undefined, set });
    const secret = await ensureUsageSecret(bb);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(set).toHaveBeenCalledWith(USAGE_SECRET_KEY, secret);
  });

  it("logs and falls back to a per-load secret when storage fails", async () => {
    const warn = vi.fn();
    const bb = { storage: { kv: { get: async () => { throw new Error("db is locked"); }, set: async () => { throw new Error("db is locked"); } } }, log: { warn } } as unknown as BbPluginApi;
    const secret = await ensureUsageSecret(bb);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db is locked"));
  });
});

describe("usageToken", () => {
  it("is stable per secret and thread, and differs by thread", () => {
    const secret = "b".repeat(64);
    expect(usageToken(secret, "thr_a")).toBe(usageToken(secret, "thr_a"));
    expect(usageToken(secret, "thr_a")).not.toBe(usageToken(secret, "thr_b"));
    expect(usageToken(secret, "thr_a")).not.toBe(usageToken("c".repeat(64), "thr_a"));
  });

  it("compares without throwing on a length mismatch", () => {
    expect(sameToken("abc", "abcd")).toBe(false);
    expect(sameToken("abcd", "abcd")).toBe(true);
  });
});
