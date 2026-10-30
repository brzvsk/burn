import { describe, expect, it, vi } from "vitest";
import { createBbReporter } from "../../extensions/pi/bb-report.js";
import { sampleReport } from "../helpers.js";

const URL_OK = "http://127.0.0.1:38886/api/v1/plugins/burn/http/usage";
const THREAD = "thr_abc123def4";
const TOKEN = "b".repeat(64);
const env = { BURN_BB_URL: URL_OK, BB_THREAD_ID: THREAD, BURN_BB_TOKEN: TOKEN };
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe("createBbReporter", () => {
  it("does nothing outside bb's rpc mode or without a valid address", async () => {
    const fetch = vi.fn(async () => ok());
    for (const [mode, e] of [
      ["tui", env],
      ["rpc", {}],
      ["rpc", { ...env, BURN_BB_URL: "file:///x" }],
      ["rpc", { ...env, BB_THREAD_ID: "nope" }],
    ] as const) {
      await createBbReporter({ env: e, fetch }).report(sampleReport(), mode);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the report as JSON to the plugin", async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => ok());
    await createBbReporter({ env, fetch: fetch as typeof globalThis.fetch }).report(sampleReport(), "rpc");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["x-burn-token"]).toBe(TOKEN);
    const body = JSON.parse(init.body as string);
    expect(body.threadId).toBe(THREAD);
    expect(typeof body.sentAt).toBe("number");
    expect(body.report.cost.total).toBe(4.82);
  });

  it("does not resend an unchanged report but sends a changed one", async () => {
    const fetch = vi.fn(async () => ok());
    const reporter = createBbReporter({ env, fetch });
    await reporter.report(sampleReport(), "rpc");
    await reporter.report(sampleReport(), "rpc");
    expect(fetch).toHaveBeenCalledTimes(1);
    await reporter.report(sampleReport({ calls: 24 }), "rpc");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never throws and retries the same report after a failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(new Response("bad", { status: 500 }))
      .mockResolvedValue(ok());
    const reporter = createBbReporter({ env, fetch });
    await expect(reporter.report(sampleReport(), "rpc")).resolves.toBeUndefined();
    await expect(reporter.report(sampleReport(), "rpc")).resolves.toBeUndefined();
    await reporter.report(sampleReport(), "rpc");
    await reporter.report(sampleReport(), "rpc");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps the latest policy bb replies with and ignores replies without one", async () => {
    const policy = { budget: 10, stopAtBudget: true, notifyExpensiveTurn: false };
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply({ ok: true, policy }))
      .mockResolvedValueOnce(reply({ ok: true }))
      .mockResolvedValueOnce(reply({ ok: true, policy: { budget: "x" } }))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }))
      .mockResolvedValueOnce(reply({ ok: true, policy: { ...policy, budget: null } }));
    const reporter = createBbReporter({ env, fetch });
    expect(reporter.policy()).toBeNull();
    await reporter.report(sampleReport({ calls: 1 }), "rpc");
    expect(reporter.policy()).toEqual(policy);
    for (const calls of [2, 3, 4]) {
      await reporter.report(sampleReport({ calls }), "rpc");
      expect(reporter.policy()).toEqual(policy);
    }
    await reporter.report(sampleReport({ calls: 5 }), "rpc");
    expect(reporter.policy()).toEqual({ ...policy, budget: null });
  });

  it("sends the v2 fields pi sets", async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => ok());
    const report = sampleReport({ running: true, budget: 10, stoppedAt: 123 });
    await createBbReporter({ env, fetch: fetch as typeof globalThis.fetch }).report(report, "rpc");
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.report).toMatchObject({ version: 2, running: true, budget: 10, stoppedAt: 123 });
    expect(body.report.turns).toHaveLength(4);
  });

  it("cancels the body of a failed reply", async () => {
    const cancel = vi.fn(async () => {});
    const res = { ok: false, status: 500, body: { cancel }, json: vi.fn() };
    await createBbReporter({ env, fetch: vi.fn(async () => res) as unknown as typeof globalThis.fetch }).report(sampleReport(), "rpc");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  });
});
