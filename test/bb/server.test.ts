import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BurnAlert } from "../../extensions/bb/alerts.js";
import type { EventRow } from "../../extensions/bb/ledger.js";
import { SETTINGS_COPY_KEY } from "../../extensions/bb/keys.js";
import plugin, { SETTINGS, settingsToRestore } from "../../extensions/bb/server.js";
import * as spendServer from "../../extensions/bb/spend/server.js";
import type { EntryLike, UsageReport } from "../../src/report.js";
import { buildReport, dayKey } from "../../src/report.js";
import { assistant, dayRow, sampleReport, toolResult, user } from "../helpers.js";
import { CODEX_1, CODEX_1_2, CODEX_2, listEvents, requestEvent, totals, usageEvent } from "./fixtures.js";

const THREAD = "thr_aaaaaaaa";
const CHILD = "thr_cccccccc";
const GRANDCHILD = "thr_dddddddd";
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
});

type Options = {
  settings?: Record<string, number | boolean | string>;
  descendants?: Record<string, string[]>;
  titles?: Record<string, string>;
  /** Session log entries per thread, as the Burn host entry on the thread's machine reads them. */
  logs?: Record<string, unknown[]>;
  /** bb's status per thread; idle when not given. */
  statuses?: Record<string, "active" | "idle">;
  /** What `threads.list` returns, a page at a time. */
  listed?: { id: string; providerId: string; updatedAt: number; deletedAt: number | null; archivedAt?: number | null; status?: string }[];
  /** bb's provider per thread; pi when not given. */
  providers?: Record<string, string>;
  /** The usage events bb recorded, for threads of other providers. */
  events?: EventRow[];
  /** Burn's own copy of its settings in its storage, as removing the plugin leaves it: the copy kept, bb's store empty. */
  settingsCopy?: Record<string, unknown>;
};

const LOG_MTIME = 1_700_000_000_000;
const HOST = "host_1";

async function setup(opts: Options = {}) {
  const logs = opts.logs ?? {};
  const statuses = opts.statuses ?? {};
  const rows = opts.events ?? [];
  /** When each thread's log last changed, as the host reports it; LOG_MTIME when not given. */
  const mtimes: Record<string, number> = {};
  const hostAsked: string[] = [];
  let gate: Promise<void> | null = null;
  const { bb, harness } = createFakePluginHost({
    pluginId: "burn",
    settings: opts.settings,
    sdk: {
      threads: {
        // The real `threads.list` carries every field `threads.get` and `environments.get` used to be asked for one thread at a time.
        list: async ({ limit, offset = 0 }: { limit?: number; offset?: number } = {}) => {
          const row = (t: { id: string; providerId: string; updatedAt: number; deletedAt: number | null; archivedAt?: number | null; status?: string }) => ({
            title: null,
            titleFallback: null,
            projectId: "proj_1",
            environmentId: "env_1",
            environmentHostId: HOST,
            status: "idle",
            archivedAt: null,
            visibility: "visible" as const,
            ...t,
          });
          const all = (
            opts.listed ??
            [THREAD, CHILD, GRANDCHILD, ...Object.keys(logs), ...Object.keys(opts.providers ?? {}), ...Object.keys(opts.statuses ?? {})].map((id) => ({
              id,
              providerId: opts.providers?.[id] ?? "pi",
              updatedAt: Date.now(),
              deletedAt: null,
              status: statuses[id] ?? "idle",
            }))
          ).map(row);
          return all.slice(offset, limit === undefined ? undefined : offset + limit);
        },
        events: {
          list: async (args: Parameters<ReturnType<typeof listEvents>>[0]) =>
            args.types?.includes("thread/identity")
              ? [{ type: "thread/identity", threadId: args.threadId, seq: 1, data: { providerThreadId: `pi_${args.threadId}` } }]
              : listEvents(() => rows)(args),
        },
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            title: opts.titles?.[threadId] ?? null,
            providerId: opts.providers?.[threadId] ?? "pi",
            environmentId: "env_1",
            status: statuses[threadId] ?? "idle",
          }),
        stop: async () => ({ ok: true as const }),
        experimental_listDescendants: async ({ threadIds }: { threadIds: readonly string[] }) => ({
          threads: threadIds.map((threadId) => ({ threadId, descendantIds: opts.descendants?.[threadId] ?? [] })),
        }),
      },
      environments: { get: async () => ({ id: "env_1", hostId: HOST }) },
    },
    experimental_callHostRpc: async ({ input }) => {
      const { threads, timeZone } = input as { threads: { threadId: string }[]; timeZone: string };
      hostAsked.push(...threads.map((t) => t.threadId));
      if (gate) await gate;
      return {
        dir: "/home/me/.bb/pi-bridge-sessions",
        reports: threads.map(({ threadId }) => {
          const entries = logs[threadId];
          return entries
            ? { threadId, report: buildReport(entries as EntryLike[], null, { timeZone }), at: mtimes[threadId] ?? LOG_MTIME }
            : { threadId, report: null, at: null };
        }),
      };
    },
  });
  // Seeded before the plugin loads, so it reads them the way a fresh install after a removal does.
  if (opts.settingsCopy !== undefined) await bb.storage.kv.set(SETTINGS_COPY_KEY, opts.settingsCopy);
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const post = (body: unknown) =>
    harness.behavior.fetchHttp("POST", "/usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const rpc = <T,>(method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<T>;
  const usage = (threadId = THREAD) => rpc<Record<string, any>>("usage", { threadId });
  const signals = () => harness.inspection.realtimeSignals.filter((s) => s.channel === "usage");
  const alerts = () => harness.inspection.realtimeSignals.filter((s) => s.channel === "alert").map((s) => s.payload as BurnAlert);
  /** Appends to a thread's log and has its host say so, as the host entry's watch does. */
  const spend = (threadId: string, ...entries: unknown[]) => {
    logs[threadId] = [...(logs[threadId] ?? []), ...entries];
    return harness.behavior.experimental_emitHostSignal(HOST, "changed", { sessionIds: [`pi_${threadId}`], all: false });
  };
  const stops = () => harness.inspection.sdk.callsTo("threads.stop");
  /** Records usage events for a thread of another provider and has bb say so, as it does within a second. */
  const record = (threadId: string, ...events: EventRow[]) => {
    rows.push(...events);
    const providerId = opts.providers?.[threadId] ?? "pi";
    return harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: threadId, providerId }), sequence: rows.length });
  };
  /** Holds every host call until the returned function runs. */
  const hold = (): (() => void) => {
    let release = (): void => undefined;
    gate = new Promise((resolve) => {
      release = () => {
        gate = null;
        resolve();
      };
    });
    return release;
  };
  return { bb, harness, post, rpc, usage, signals, alerts, logs, mtimes, statuses, spend, stops, record, hostAsked: () => [...hostAsked], hold };
}

const envelope = (sentAt: number, over: Partial<UsageReport> = {}, threadId = THREAD) => ({ threadId, sentAt, report: sampleReport(over) });
const costOf = (total: number): Partial<UsageReport> => ({ cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const QUIET = { budget: null, stopAtBudget: false, notifyExpensiveTurn: false };

describe("settings", () => {
  it("declares every setting in order, with quiet defaults", async () => {
    const s = await setup();
    const declared = s.harness.inspection.registrations.settingsDescriptors;
    expect(Object.keys(declared)).toEqual([
      "chip",
      "chipShows",
      "threadBudget",
      "dailyBudget",
      "budgetAlerts",
      "stopAtBudget",
      "flagOverBudget",
      "notifyExpensiveTurn",
      "discount",
      "inputDiscount",
      "outputDiscount",
      "cacheReadDiscount",
      "cacheWriteDiscount",
    ]);
    expect(declared.chip).toMatchObject({ type: "boolean", label: "Cost chip", default: true });
    expect(declared.chipShows).toMatchObject({ type: "select", options: ["delta", "cost"], default: "delta" });
    expect(declared.threadBudget).toMatchObject({ type: "number", label: "Thread budget" });
    expect("default" in declared.threadBudget).toBe(false);
    expect("default" in declared.dailyBudget).toBe(false);
    expect(declared.budgetAlerts).toMatchObject({ default: true });
    expect(declared.flagOverBudget).toMatchObject({ default: true });
    expect(declared.notifyExpensiveTurn).toMatchObject({ default: false });
    expect(declared.discount).toMatchObject({ type: "number", label: "Discount (%)", default: 0 });
    expect(declared.inputDiscount).toMatchObject({ type: "number", label: "Input discount (%)" });
    expect("default" in declared.inputDiscount).toBe(false);
  });

  it("never stops a thread by default, and says so", async () => {
    const s = await setup();
    const stop = s.harness.inspection.registrations.settingsDescriptors.stopAtBudget;
    expect(stop).toMatchObject({ type: "boolean", label: "Stop a thread at its budget", default: false });
    expect(stop?.description).toMatch(/^Off by default/);
    expect(stop?.description).toContain("Burn stops the run whose cost crosses the thread's budget");
    expect(stop?.description).toContain("Send another prompt to continue");
    expect(stop?.description).toContain("otherwise Burn stops the thread's current work through bb");
    expect(stop?.description).toContain("Claude Code threads are not stopped");
    expect(SETTINGS.notifyExpensiveTurn.description).toContain("at least 3 times the thread's median turn and at least $0.50");
  });

  it("rejects a budget of zero or less", async () => {
    const s = await setup();
    await expect(s.harness.behavior.setSettings({ threadBudget: -1 })).rejects.toThrow(/above zero/);
    await s.harness.behavior.setSettings({ threadBudget: 12.5 });
    expect((await s.usage()).policy.budget).toBe(12.5);
  });

  it("rejects a discount outside -100 to 100", async () => {
    const s = await setup();
    await expect(s.harness.behavior.setSettings({ discount: 101 })).rejects.toThrow(/-100 to 100/);
    await expect(s.harness.behavior.setSettings({ cacheWriteDiscount: -101 })).rejects.toThrow(/-100 to 100/);
  });

  it("keeps its own copy of the settings that are set", async () => {
    const s = await setup({ settings: { discount: 15, threadBudget: 10, dailyBudget: 500, chip: true } });
    // The copy holds every setting, so a value that goes back to its default reads as a default, not as a loss.
    expect(await s.bb.storage.kv.get(SETTINGS_COPY_KEY)).toMatchObject({ discount: 15, threadBudget: 10, dailyBudget: 500, chip: true });
    await s.harness.behavior.setSettings({ discount: 20 });
    expect(await s.bb.storage.kv.get(SETTINGS_COPY_KEY)).toMatchObject({ discount: 20, threadBudget: 10 });
  });

  it("puts back the settings bb forgot when the plugin was removed", async () => {
    // bb deletes a plugin's settings on removal but keeps its storage, so this is what a reinstall finds.
    const s = await setup({ settingsCopy: { discount: 15, threadBudget: 10, stopAtBudget: true, chip: false } });
    expect(await (await s.post(envelope(1))).json()).toMatchObject({ policy: { budget: 10, stopAtBudget: true } });
    const kept = (await s.bb.storage.kv.get(SETTINGS_COPY_KEY)) as Record<string, unknown>;
    expect(kept).toMatchObject({ discount: 15, threadBudget: 10, stopAtBudget: true, chip: false });
  });

  it("leaves a setting bb holds of its own, whatever the copy says", async () => {
    // Set while the plugin was off, so bb holds it and the copy is behind: the user's newer value wins.
    const s = await setup({ settings: { discount: 20 }, settingsCopy: { discount: 15, threadBudget: 10 } });
    expect(await s.bb.storage.kv.get(SETTINGS_COPY_KEY)).toMatchObject({ discount: 20, threadBudget: 10 });
  });
});

describe("settingsToRestore", () => {
  it("puts back a default bb reports where the copy holds a value, and nothing else", () => {
    const copy = { discount: 15, dailyBudget: 500, threadBudget: 10, chip: true, chipShows: "delta", gone: 3 };
    const effective = { discount: 0, dailyBudget: null, threadBudget: null, chip: false, chipShows: "cost" };
    // chip and chipShows sit at their defaults in the copy, gone is no longer a setting, and chip holds a value of bb's own.
    expect(settingsToRestore(copy, effective)).toEqual({ discount: 15, dailyBudget: 500, threadBudget: 10 });
  });

  it("has nothing to put back once bb holds the values", async () => {
    const copy = { discount: 15, dailyBudget: 500 };
    expect(settingsToRestore(copy, { discount: 15, dailyBudget: 500 })).toEqual({});
    expect(settingsToRestore(copy, { discount: 20, dailyBudget: 500 })).toEqual({});
  });
});

describe("POST /usage", () => {
  it("stores a report, publishes a signal, serves it over rpc and replies with the policy", async () => {
    const s = await setup();
    const report = buildReport([user(), assistant(1.25)], { tokens: 1, window: 2, percent: 50 });
    const res = await s.post({ threadId: THREAD, sentAt: 1, report });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, policy: QUIET });
    const got = await s.usage();
    expect(got.report).toEqual(report);
    expect(typeof got.reportedAt).toBe("number");
    expect(s.signals()).toEqual([{ channel: "usage", payload: { threadId: THREAD } }]);
  });

  it("hands pi bb's budget: the thread's own, else the setting, and the stop setting as set", async () => {
    const s = await setup({ settings: { threadBudget: 10, stopAtBudget: true } });
    expect(await (await s.post(envelope(1))).json()).toEqual({ ok: true, policy: { budget: 10, stopAtBudget: true, notifyExpensiveTurn: false } });
    await s.rpc("setBudget", { threadId: THREAD, budget: 4 });
    expect((await (await s.post(envelope(2))).json()).policy.budget).toBe(4);
    await s.rpc("setBudget", { threadId: THREAD, budget: null });
    expect((await (await s.post(envelope(3))).json()).policy.budget).toBeNull();
    await s.rpc("setBudget", { threadId: THREAD, budget: "default" });
    expect((await (await s.post(envelope(4))).json()).policy.budget).toBe(10);
  });

  it("rejects an oversize body, bad JSON and an invalid report", async () => {
    const s = await setup();
    expect((await s.post("x".repeat(240 * 1024 + 1))).status).toBe(413);
    // 100,000 characters but 300,000 UTF-8 bytes: the limit is on bytes, as bb's KV limit is.
    expect((await s.post("€".repeat(100_000))).status).toBe(413);
    expect((await s.post("{nope")).status).toBe(400);
    expect((await s.post({ threadId: THREAD, sentAt: 1, report: { version: 1 } })).status).toBe(400);
    expect(s.signals()).toEqual([]);
  });

  it("ignores a report older than the stored one but still answers with the policy", async () => {
    const s = await setup();
    await s.post(envelope(10, { calls: 5 }));
    const stale = await s.post(envelope(5, { calls: 1 }));
    expect(await stale.json()).toEqual({ ok: true, policy: QUIET });
    expect((await s.usage()).report).toMatchObject({ calls: 5 });
    expect(s.signals()).toHaveLength(1);
  });

  it("keeps reports and budgets across a plugin reload", async () => {
    const s = await setup();
    await s.post(envelope(1));
    await s.rpc("setBudget", { threadId: THREAD, budget: 7.5 });
    const next = await s.harness.lifecycle.reload(plugin);
    disposers.push(() => next.harness.lifecycle.dispose());
    const got = (await next.harness.behavior.callRpc("usage", { threadId: THREAD })) as Record<string, any>;
    expect(got.report).toMatchObject({ calls: 23 });
    expect(got.budget).toEqual({ amount: 7.5, source: "thread" });
  });

  it("drops stored rows that no longer match the schema", async () => {
    const s = await setup();
    await s.bb.storage.kv.set(`report:${THREAD}`, { report: { version: 0 }, sentAt: 1, at: 1 });
    await s.bb.storage.kv.set(`budget:${THREAD}`, { budget: "lots" });
    expect(await s.usage()).toMatchObject({ report: null, reportedAt: null, budget: null });
    expect(await s.bb.storage.kv.get(`report:${THREAD}`)).toBeUndefined();
    expect(await s.bb.storage.kv.get(`budget:${THREAD}`)).toBeUndefined();
  });

  it("gives pi the report address", async () => {
    const s = await setup();
    const entries = await s.harness.behavior.resolveProviderEnv("pi", { threadId: THREAD, projectId: "proj_1", hostId: "host_1" });
    expect(entries.map((e) => [e.name, e.value])).toEqual([["BURN_BB_URL", { serverPath: "/api/v1/plugins/burn/http/usage" }]]);
  });

  it("forgets a deleted thread's report, budget, log copy and stop", async () => {
    const s = await setup({ logs: { [THREAD]: [user(), assistant(1)] } });
    await s.post(envelope(1));
    await s.rpc("setBudget", { threadId: THREAD, budget: 3 });
    await s.bb.storage.kv.set(`stopped:${THREAD}`, { at: 5 });
    expect(await s.bb.storage.kv.get(`log:${THREAD}`)).toMatchObject({ at: LOG_MTIME });
    delete s.logs[THREAD];
    await s.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: THREAD }) });
    expect(await s.usage()).toMatchObject({ report: null, reportedAt: null, budget: null });
    for (const key of ["report", "budget", "log", "stopped"]) expect(await s.bb.storage.kv.get(`${key}:${THREAD}`), key).toBeUndefined();
  });

  it("evicts the least recently updated thread from memory above 500 threads", async () => {
    const s = await setup();
    const id = (n: number) => `thr_${String(n).padStart(8, "0")}`;
    for (let n = 0; n < 501; n++) await s.post(envelope(1, {}, id(n)));
    // The evicted thread still reads back from storage.
    expect((await s.usage(id(0))).report).not.toBeNull();
  });
});

describe("budgets", () => {
  it("names where the budget comes from: the thread, the setting, pi, or nowhere", async () => {
    const none = await setup();
    await none.post(envelope(1));
    expect((await none.usage()).budget).toBeNull();

    const pi = await setup();
    await pi.post(envelope(1, { budget: 6 }));
    expect((await pi.usage()).budget).toEqual({ amount: 6, source: "pi" });

    const setting = await setup({ settings: { threadBudget: 10 } });
    await setting.post(envelope(1, { budget: 6 }));
    expect((await setting.usage()).budget).toEqual({ amount: 10, source: "setting" });
    await setting.rpc("setBudget", { threadId: THREAD, budget: 2.5 });
    expect((await setting.usage()).budget).toEqual({ amount: 2.5, source: "thread" });
    // No budget of its own means bb hands pi none, so pi's own applies, as pi applies it.
    await setting.rpc("setBudget", { threadId: THREAD, budget: null });
    expect((await setting.usage()).budget).toEqual({ amount: 6, source: "pi" });
  });

  it("stores a thread's budget in KV, deletes it for default, and signals the change", async () => {
    const s = await setup({ settings: { threadBudget: 10 } });
    const set = await s.rpc<Record<string, any>>("setBudget", { threadId: THREAD, budget: 5 });
    expect(set).toEqual({ budget: { amount: 5, source: "thread" }, policy: { budget: 5, stopAtBudget: false, notifyExpensiveTurn: false } });
    expect(await s.bb.storage.kv.get(`budget:${THREAD}`)).toEqual({ budget: 5 });
    await s.rpc("setBudget", { threadId: THREAD, budget: null });
    expect(await s.bb.storage.kv.get(`budget:${THREAD}`)).toEqual({ budget: null });
    const reset = await s.rpc<Record<string, any>>("setBudget", { threadId: THREAD, budget: "default" });
    expect(reset.budget).toEqual({ amount: 10, source: "setting" });
    expect(await s.bb.storage.kv.get(`budget:${THREAD}`)).toBeUndefined();
    expect(s.signals()).toHaveLength(3);
    await expect(s.rpc("setBudget", { threadId: THREAD, budget: -2 })).rejects.toThrow();
  });
});

describe("alerts", () => {
  // Alerts go out after the reply; a few macrotasks let a quiet case prove it stayed quiet.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("warns once at 80% and once at 100% of the budget, with the thread's title", async () => {
    const s = await setup({ settings: { threadBudget: 10 }, titles: { [THREAD]: "Refactor the parser" } });
    await s.post(envelope(1, costOf(5)));
    await s.post(envelope(2, costOf(8.1)));
    await s.post(envelope(3, costOf(8.5)));
    await s.post(envelope(4, costOf(10.2)));
    await s.post(envelope(5, costOf(12)));
    await vi.waitFor(() => expect(s.alerts()).toHaveLength(2));
    const [near, over] = s.alerts();
    expect(near).toMatchObject({ kind: "near", threadId: THREAD, title: "“Refactor the parser” is near its budget", body: "$8.10 of the $10 thread budget (81%)." });
    expect(over).toMatchObject({ kind: "over", title: "“Refactor the parser” is over its budget" });
    expect(near?.id).not.toBe(over?.id);
  });

  it("stays quiet on a thread's first report, and with budget alerts off", async () => {
    const first = await setup({ settings: { threadBudget: 10 } });
    await first.post(envelope(1, costOf(12)));
    const off = await setup({ settings: { threadBudget: 10, budgetAlerts: false } });
    await off.post(envelope(1, costOf(5)));
    await off.post(envelope(2, costOf(12)));
    await settle();
    expect(first.alerts()).toEqual([]);
    expect(off.alerts()).toEqual([]);
  });

  it("says when pi stopped a run at the budget, once per stop", async () => {
    const s = await setup({ settings: { threadBudget: 10, budgetAlerts: false }, titles: { [THREAD]: "Big job" } });
    await s.post(envelope(1, costOf(9)));
    await s.post(envelope(2, { ...costOf(10.1), stoppedAt: 1000 }));
    await s.post(envelope(3, { ...costOf(10.1), stoppedAt: 1000 }));
    await vi.waitFor(() => expect(s.alerts()).toHaveLength(1));
    expect(s.alerts()[0]).toMatchObject({ id: `stopped:${THREAD}:1000`, kind: "stopped", title: "Burn stopped “Big job” at its $10 budget" });
  });

  it("nudges after an unusually expensive turn only when that setting is on", async () => {
    const turns = sampleReport().turns;
    const cheap = turns.map((t) => ({ ...t, cost: 0.2, callCosts: [0.2] }));
    const running: Partial<UsageReport> = { turns: [...cheap, { ...turns[3]!, n: 5, cost: 0.1 }], turnCount: 5, running: true };
    const done: Partial<UsageReport> = { turns: [...cheap, { ...turns[3]!, n: 5, cost: 1.5 }], turnCount: 5, running: false };

    // bb says when the turn ends, and each step is looked at as it happens.
    const idle = { thread: makeThreadResponse({ id: THREAD, providerId: "pi", status: "idle" }), lastAssistantText: null };
    const steps = async (t: Awaited<ReturnType<typeof setup>>) => {
      await t.post(envelope(1, running));
      await settle();
      await t.post(envelope(2, done));
      await settle();
      await t.harness.behavior.emitThreadEvent("thread.idle", idle);
      await settle();
      await t.post(envelope(3, done));
    };
    const quiet = await setup({ statuses: { [THREAD]: "active" } });
    await steps(quiet);
    await settle();
    const on = await setup({ settings: { notifyExpensiveTurn: true }, statuses: { [THREAD]: "active" } });
    await steps(on);
    await vi.waitFor(() => expect(on.alerts()).toHaveLength(1));
    expect(on.alerts()[0]).toMatchObject({ id: `expensive:${THREAD}:5`, kind: "expensive", body: "Turn 5 cost $1.50, 7.5 times the thread's median turn." });
    expect(quiet.alerts()).toEqual([]);
  });

  it("alerts on a thread that never reported as its log grows, from the second sighting on", async () => {
    const s = await setup({ settings: { threadBudget: 10 }, titles: { [THREAD]: "Quiet worker" }, logs: { [THREAD]: [user(), assistant(7)] } });
    await s.usage();
    await s.spend(THREAD, assistant(0.5));
    await vi.waitFor(() => expect(s.signals()).toHaveLength(1));
    await s.spend(THREAD, assistant(1));
    await vi.waitFor(() => expect(s.alerts()).toHaveLength(1));
    expect(s.alerts()[0]).toMatchObject({ kind: "near", threadId: THREAD, body: "$8.50 of the $10 thread budget (85%)." });
    expect(s.signals().length).toBeGreaterThanOrEqual(2);
  });

  it("publishes the daily budget alert the Spend module returns", async () => {
    const daily: BurnAlert = { id: "daily:2026-10-18", kind: "daily", threadId: null, title: "Daily budget reached", body: "…", at: 1 };
    const check = vi.spyOn(spendServer, "checkDailyBudget").mockResolvedValueOnce(daily);
    const s = await setup({ settings: { dailyBudget: 50 } });
    await s.post(envelope(1));
    await vi.waitFor(() => expect(s.alerts()).toEqual([daily]));
    expect(await check.mock.calls[0]?.[0].dailyBudget()).toBe(50);
  });
});

describe("costs, overBudget and family", () => {
  it("adds up a thread and its reported descendants", async () => {
    const s = await setup({
      descendants: { [THREAD]: [CHILD, GRANDCHILD, "thr_eeeeeeee"] },
      titles: { [CHILD]: "Write chip tests" },
      statuses: { [CHILD]: "active" },
    });
    await s.post(envelope(1, { ...costOf(4.82), calls: 23 }));
    await s.post(envelope(1, { ...costOf(1.1), calls: 14, running: true }, CHILD));
    await s.post(envelope(1, { ...costOf(0.72), calls: 9 }, GRANDCHILD));
    const { family, title } = await s.usage();
    expect(title).toBeNull();
    expect(family.total).toBeCloseTo(6.64);
    expect(family.calls).toBe(46);
    expect(family.estimated).toBe(false);
    expect(family.children).toEqual([
      { threadId: CHILD, title: "Write chip tests", cost: 1.1, calls: 14, running: true, model: "p/claude-opus", estimated: false },
      { threadId: GRANDCHILD, title: "Untitled thread", cost: 0.72, calls: 9, running: false, model: "p/claude-opus", estimated: false },
    ]);
  });

  it("answers costs per thread with its family total, budget and state", async () => {
    const s = await setup({ settings: { threadBudget: 10 }, descendants: { [THREAD]: [CHILD] } });
    await s.post(envelope(1, costOf(4.82)));
    await s.post(envelope(1, costOf(1.82), CHILD));
    await s.rpc("setBudget", { threadId: CHILD, budget: 2 });
    const { threads } = await s.rpc<{ threads: Record<string, unknown>[] }>("costs", { threadIds: [THREAD, CHILD, "thr_ffffffff"] });
    expect(threads).toEqual([
      { threadId: THREAD, cost: 4.82, label: "$4.82", familyCost: expect.closeTo(6.64), budget: { amount: 10, source: "setting" }, state: "ok", estimated: false },
      { threadId: CHILD, cost: 1.82, label: "$1.82", familyCost: null, budget: { amount: 2, source: "thread" }, state: "near", estimated: false },
      { threadId: "thr_ffffffff", cost: null, label: null, familyCost: null, budget: { amount: 10, source: "setting" }, state: "ok", estimated: false },
    ]);
    await expect(s.rpc("costs", { threadIds: [] })).rejects.toThrow();
  });

  it("lists threads over budget that never reported, from their logs", async () => {
    const s = await setup({
      settings: { threadBudget: 10 },
      logs: { [CHILD]: [user(), assistant(12)] },
      listed: [{ id: CHILD, providerId: "pi", updatedAt: Date.now(), deletedAt: null }],
    });
    expect(await s.rpc("overBudget", {})).toEqual({ threads: [{ threadId: CHILD, cost: 12, budget: 10, estimated: false }] });
  });

  it("lists every stored thread over its budget", async () => {
    const s = await setup({ settings: { threadBudget: 10 } });
    await s.post(envelope(1, costOf(12.4)));
    await s.post(envelope(1, costOf(3), CHILD));
    await s.post(envelope(1, costOf(30), GRANDCHILD));
    await s.rpc("setBudget", { threadId: GRANDCHILD, budget: null });
    expect(await s.rpc("overBudget", {})).toEqual({ threads: [{ threadId: THREAD, cost: 12.4, budget: 10, estimated: false }] });
  });

  it("marks a family, a cost row and an over-budget row that include a list-price estimate", async () => {
    const s = await setup({
      settings: { threadBudget: 0.01 },
      providers: { [CHILD]: "codex" },
      descendants: { [THREAD]: [CHILD] },
      events: [requestEvent(CHILD, "go", "gpt-5.5"), usageEvent(CHILD, CODEX_1)],
      listed: [{ id: CHILD, providerId: "codex", updatedAt: Date.now(), deletedAt: null }],
    });
    await s.post(envelope(1, costOf(4.82)));
    const { family } = await s.usage();
    expect(family.estimated).toBe(true);
    expect(family.children).toEqual([expect.objectContaining({ threadId: CHILD, estimated: true })]);
    const { threads } = await s.rpc<{ threads: Record<string, unknown>[] }>("costs", { threadIds: [THREAD, CHILD] });
    expect(threads.map((t) => [t.label, t.estimated])).toEqual([
      ["$4.82", true],
      ["~$0.05", true],
    ]);
    const over = await s.rpc<{ threads: { threadId: string; estimated: boolean }[] }>("overBudget", {});
    expect(over.threads.map((t) => [t.threadId, t.estimated]).sort()).toEqual([
      [THREAD, false],
      [CHILD, true],
    ]);
  });

  it("reads the session log of a thread or child that never reported", async () => {
    const s = await setup({
      descendants: { [THREAD]: [CHILD, GRANDCHILD] },
      titles: { [GRANDCHILD]: "Kevin" },
      logs: { [THREAD]: [user("hi"), assistant(1.5)], [GRANDCHILD]: [user("build it"), assistant(2), toolResult(0.5), assistant(3)] },
    });
    await s.post(envelope(1, { ...costOf(1.1), calls: 14 }, CHILD));
    const got = await s.usage();
    expect(got).toMatchObject({ source: "log", reportedAt: LOG_MTIME });
    expect(got.report.cost.total).toBeCloseTo(1.5);
    expect(got.family.total).toBeCloseTo(1.5 + 1.1 + 5.5);
    expect(got.family.children.map((c: { title: string }) => c.title)).toEqual(["Kevin", "Untitled thread"]);
    const { threads } = await s.rpc<{ threads: { familyCost: number }[] }>("costs", { threadIds: [THREAD] });
    expect(threads[0]?.familyCost).toBeCloseTo(8.1);
    expect((await s.usage(CHILD)).source).toBe("pi");
  });

  it("counts threads of every provider that never reported on the Burn page, and skips deleted ones", async () => {
    const today = (entry: { timestamp: string }) => ({ ...entry, timestamp: new Date().toISOString() });
    const s = await setup({
      logs: { [CHILD]: [today(user("hi")), today(assistant(3))], [GRANDCHILD]: [today(user()), today(assistant(5))] },
      listed: [
        { id: CHILD, providerId: "pi", updatedAt: Date.now(), deletedAt: null },
        { id: GRANDCHILD, providerId: "pi", updatedAt: Date.now(), deletedAt: Date.now() },
        { id: "thr_eeeeeeee", providerId: "codex", updatedAt: Date.now(), deletedAt: null },
      ],
    });
    s.harness.sdk.stub("projects.list", async () => []);
    await s.post(envelope(1, { ...costOf(2), days: [dayRow(dayKey(Date.now()), 2, {}, 1)] }));
    const spend = await s.rpc<{ total: number; threadCount: number }>("spend", { range: "today", projectId: null });
    expect(spend.threadCount).toBe(2);
    expect(spend.total).toBeCloseTo(5);
  });

  it("counts a Codex thread beside a pi one on the Burn page and against the daily budget", async () => {
    const today = (entry: { timestamp: string }) => ({ ...entry, timestamp: new Date().toISOString() });
    const CODEX = "thr_eeeeeeee";
    const s = await setup({
      settings: { dailyBudget: 3.01 },
      providers: { [CODEX]: "codex" },
      logs: { [CHILD]: [today(user("hi")), today(assistant(3))] },
      listed: [
        { id: CHILD, providerId: "pi", updatedAt: Date.now(), deletedAt: null },
        { id: CODEX, providerId: "codex", updatedAt: Date.now(), deletedAt: null },
      ],
    });
    s.harness.sdk.stub("projects.list", async () => []);
    await s.record(CODEX, requestEvent(CODEX, "go", "gpt-5.5"), usageEvent(CODEX, CODEX_1));
    await vi.waitFor(() => expect(s.alerts().map((a) => a.kind)).toEqual(["daily"]));
    expect(s.alerts()[0]?.body).toContain("across 2 threads today");
    const spend = await s.rpc<{ total: number; threadCount: number }>("spend", { range: "today", projectId: null });
    expect(spend.threadCount).toBe(2);
    expect(spend.total).toBeCloseTo(3.053, 9);
    expect(await s.usage(CODEX)).toMatchObject({ source: "events", report: { estimated: true, calls: 1 } });
  });

  it("takes the figures from the log over a report from Burn 0.1, which has no prompts or days", async () => {
    const s = await setup({ logs: { [THREAD]: [user("hi"), assistant(2)] } });
    const { turnCount, turns, days, utcDays, running, budget, stoppedAt, ...rest } = sampleReport(costOf(9));
    await s.post({ threadId: THREAD, sentAt: 1, report: { ...rest, version: 1, series: [] } });
    const got = await s.usage();
    expect(got.report).toMatchObject({ turnCount: 1, calls: 1 });
    expect(got.report.cost.total).toBeCloseTo(2);
  });

  it("takes every figure from the log and only the budget, stop and context from pi's report", async () => {
    const s = await setup({ logs: { [THREAD]: [user("hi"), assistant(1.5)] } });
    const context = { tokens: 5, window: 10, percent: 50 };
    await s.post(envelope(1, { ...costOf(9), calls: 40, budget: 6, stoppedAt: 1000, context, running: true }));
    const got = await s.usage();
    expect(got).toMatchObject({ source: "pi", budget: { amount: 6, source: "pi" } });
    expect(got.report).toMatchObject({ calls: 1, budget: 6, stoppedAt: 1000, context, running: false });
    expect(got.report.cost.total).toBeCloseTo(1.5);
    expect(got.reportedAt).toBeGreaterThan(LOG_MTIME);
  });

  it("says the figures come from the log once pi has not reported for two minutes", async () => {
    const s = await setup({ logs: { [THREAD]: [user("hi"), assistant(1.5)] } });
    await s.post(envelope(1));
    const later = Date.now() + 2 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect((await s.usage()).source).toBe("log");
  });

  it("counts archived and hidden child threads", async () => {
    const s = await setup();
    await s.usage();
    expect(s.harness.sdk.callsTo("threads.experimental_listDescendants")[0]?.[0]).toMatchObject({ includeArchived: true, includeHidden: true });
  });

  it("still answers when bb cannot list child threads", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "burn" });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    const got = (await harness.behavior.callRpc("usage", { threadId: THREAD })) as Record<string, any>;
    expect(got).toMatchObject({ report: null, title: null, family: { total: 0, calls: 0, children: [] }, policy: QUIET });
    expect(harness.inspection.logEntries.some((e) => e.level === "warn")).toBe(true);
  });
});

describe("what each call reads", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const id = (n: number) => `thr_${String(n).padStart(8, "0")}`;
  const DAY_MS = 86_400_000;
  const row = (threadId: string, over: { updatedAt?: number; archivedAt?: number | null; status?: string } = {}) => ({
    id: threadId,
    providerId: "pi",
    updatedAt: Date.now(),
    deletedAt: null,
    archivedAt: null,
    ...over,
  });

  it("flags only threads the sidebar shows, and reads no archived thread's log", async () => {
    const archived = Array.from({ length: 50 }, (_, n) => id(n));
    const s = await setup({
      settings: { threadBudget: 10 },
      logs: Object.fromEntries([THREAD, ...archived].map((t) => [t, [user(), assistant(12)]])),
      listed: [row(THREAD), ...archived.map((t) => row(t, { archivedAt: Date.now() }))],
    });
    expect(await s.rpc("overBudget", {})).toEqual({ threads: [{ threadId: THREAD, cost: 12, budget: 10, estimated: false }] });
    expect(s.hostAsked()).toEqual([THREAD]);
  });

  it("answers within a second from the last figures while a host is slow, and signals once the host answers", async () => {
    const s = await setup({ logs: { [THREAD]: [user(), assistant(2)] } });
    const cost = async () => (await s.rpc<{ threads: { cost: number }[] }>("costs", { threadIds: [THREAD] })).threads[0]?.cost;
    expect(await cost()).toBeCloseTo(2);
    // The host's worker restarting drops what Burn read there, so the next call asks the host again.
    await s.harness.behavior.experimental_emitHostWorkerExit(HOST);
    s.logs[THREAD]?.push(assistant(3));
    s.mtimes[THREAD] = LOG_MTIME + 1;
    const release = s.hold();
    const before = s.signals().length;
    try {
      const answered = await Promise.race([cost(), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_500))]);
      expect(answered).toBeCloseTo(2);
    } finally {
      release();
    }
    await vi.waitFor(() => expect(s.signals().slice(before)).toContainEqual({ channel: "usage", payload: { threadId: THREAD } }));
    expect(await cost()).toBeCloseTo(5);
  });

  it("checks the daily budget over threads active since yesterday, not every thread that ever reported", async () => {
    const weekAgo = Date.now() - 7 * DAY_MS;
    const old = Array.from({ length: 50 }, (_, n) => id(n));
    const running = id(99);
    const s = await setup({
      settings: { dailyBudget: 100 },
      logs: Object.fromEntries([...old, running].map((t) => [t, [user(), assistant(1)]])),
      listed: [row(THREAD), ...old.map((t) => row(t, { updatedAt: weekAgo })), row(running, { updatedAt: weekAgo, status: "active" })],
    });
    for (const t of old) await s.bb.storage.kv.set(`report:${t}`, { report: sampleReport(), sentAt: 1, at: weekAgo });
    const check = vi.spyOn(spendServer, "checkDailyBudget");
    const get = vi.spyOn(s.bb.storage.kv, "get");
    await s.post(envelope(1, costOf(2)));
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await check.mock.results[0]?.value;
    const read = new Set(get.mock.calls.map(([key]) => String(key).slice(String(key).indexOf(":") + 1)));
    expect(old.filter((t) => read.has(t))).toEqual([]);
    expect(s.hostAsked().filter((t) => old.includes(t))).toEqual([]);
    expect(s.hostAsked()).toContain(running);
  });

  it("checks the daily budget once for a burst of changes", async () => {
    const check = vi.spyOn(spendServer, "checkDailyBudget");
    const s = await setup({ settings: { dailyBudget: 100 } });
    for (let n = 1; n <= 5; n++) await s.post(envelope(n, costOf(n)));
    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("stop at budget, for threads without the pi extension", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const logs = () => ({ [THREAD]: [user(), assistant(9)] });
  const ON = { threadBudget: 10, stopAtBudget: true };

  /** Sees the thread once, as bb's thread.active does, then spends `costs` one call at a time. */
  async function run(s: Awaited<ReturnType<typeof setup>>, ...costs: number[]) {
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: THREAD, providerId: "pi", status: "active" }) });
    await settle();
    for (const cost of costs) {
      await s.spend(THREAD, assistant(cost));
      await settle();
    }
  }

  it("never stops a thread with the default settings", async () => {
    const s = await setup({ settings: { threadBudget: 10 }, statuses: { [THREAD]: "active" }, logs: logs() });
    await run(s, 2, 5);
    expect(s.stops()).toEqual([]);
    expect(SETTINGS.stopAtBudget.default).toBe(false);
  });

  it("stops the running thread once, on the change that crosses its budget, and says so", async () => {
    const s = await setup({ settings: ON, statuses: { [THREAD]: "active" }, titles: { [THREAD]: "Big job" }, logs: logs() });
    await run(s, 0.5, 1, 2);
    await vi.waitFor(() => expect(s.stops()).toHaveLength(1));
    await settle();
    expect(s.stops()).toEqual([[{ threadId: THREAD }]]);
    const record = await s.bb.storage.kv.get<{ at: number }>(`stopped:${THREAD}`);
    expect(record).toEqual({ at: expect.any(Number) });
    const stopped = s.alerts().filter((a) => a.kind === "stopped");
    expect(stopped).toEqual([expect.objectContaining({ id: `stopped:${THREAD}:${record?.at}`, title: "Burn stopped “Big job” at its $10 budget" })]);
    expect((await s.usage()).report.stoppedAt).toBe(record?.at);
  });

  it("never stops on the first sighting, even of a thread already over its budget", async () => {
    const s = await setup({ settings: ON, statuses: { [THREAD]: "active" }, logs: { [THREAD]: [user(), assistant(12)] } });
    await run(s);
    await s.usage();
    expect(s.stops()).toEqual([]);
  });

  it("never stops a thread whose pi extension has reported, which stops its own run", async () => {
    const s = await setup({ settings: ON, statuses: { [THREAD]: "active" }, logs: logs() });
    await s.post(envelope(1, costOf(9)));
    await settle();
    await run(s, 2);
    expect(s.stops()).toEqual([]);
  });

  it("stops a Codex thread once when a response crosses its budget, even its first one", async () => {
    const s = await setup({ settings: { threadBudget: 0.05, stopAtBudget: true }, providers: { [THREAD]: "codex" }, statuses: { [THREAD]: "active" } });
    await s.record(THREAD, requestEvent(THREAD, "go", "gpt-5.5"), usageEvent(THREAD, CODEX_1));
    await vi.waitFor(() => expect(s.stops()).toHaveLength(1));
    await s.record(THREAD, usageEvent(THREAD, CODEX_1_2, CODEX_2));
    await settle();
    expect(s.stops()).toEqual([[{ threadId: THREAD }]]);
    expect(s.alerts().map((a) => a.kind).sort()).toEqual(["over", "stopped"]);
  });

  it("alerts a Claude Code thread at its budget but never stops it, since its cost arrives as each turn ends", async () => {
    const s = await setup({ settings: { threadBudget: 0.05, stopAtBudget: true }, providers: { [THREAD]: "claude-code" }, statuses: { [THREAD]: "active" } });
    const turn = totals({ inputTokens: 100, cacheReadInputTokens: 40_000, cacheWriteInputTokens: 10_000, cachedInputTokens: 50_000, outputTokens: 1000, totalTokens: 51_100 });
    await s.record(THREAD, requestEvent(THREAD, "go", "claude-opus-5-5"), usageEvent(THREAD, turn));
    await vi.waitFor(() => expect(s.alerts().map((a) => a.kind)).toEqual(["over"]));
    await settle();
    expect(s.stops()).toEqual([]);
  });

  it("never stops a Codex thread with the default settings, and only sets a baseline for one from before Burn loaded", async () => {
    const earlier = Date.now() - 60_000;
    const old = "thr_ffffffff";
    const s = await setup({
      settings: { threadBudget: 0.05 },
      providers: { [THREAD]: "codex", [old]: "codex" },
      statuses: { [THREAD]: "active", [old]: "active" },
      events: [requestEvent(old, "go", "gpt-5.5"), usageEvent(old, CODEX_1), usageEvent(old, CODEX_1_2, CODEX_2)].map((e) => ({ ...e, createdAt: earlier })),
    });
    await s.record(THREAD, requestEvent(THREAD, "go", "gpt-5.5"), usageEvent(THREAD, CODEX_1));
    await s.record(old);
    await vi.waitFor(() => expect(s.alerts()).toHaveLength(1));
    await settle();
    expect(s.alerts()[0]).toMatchObject({ kind: "over", threadId: THREAD });
    expect(s.stops()).toEqual([]);
  });

  it("never stops a thread bb does not say is working", async () => {
    const s = await setup({ settings: ON, logs: logs() });
    await s.usage();
    await s.spend(THREAD, assistant(0.5));
    await settle();
    await s.spend(THREAD, assistant(2));
    await settle();
    expect(s.stops()).toEqual([]);
  });
});

describe("discounts", () => {
  const today = (entry: { timestamp: string }) => ({ ...entry, timestamp: new Date().toISOString() });

  it("prices every answer with the discount, and usage at list price when asked", async () => {
    const s = await setup({
      settings: { discount: 50, threadBudget: 3 },
      logs: { [THREAD]: [today(user("hi")), today(assistant(4))] },
      listed: [{ id: THREAD, providerId: "pi", updatedAt: Date.now(), deletedAt: null }],
    });
    s.harness.sdk.stub("projects.list", async () => []);
    expect((await s.usage()).report.cost.total).toBeCloseTo(2);
    const atList = await s.rpc<Record<string, any>>("usage", { threadId: THREAD, listPrice: true });
    expect(atList.report.cost.total).toBeCloseTo(4);
    const { threads } = await s.rpc<{ threads: { cost: number }[] }>("costs", { threadIds: [THREAD] });
    expect(threads[0]?.cost).toBeCloseTo(2);
    const spend = await s.rpc<{ total: number }>("spend", { range: "today", projectId: null });
    expect(spend.total).toBeCloseTo(2);
    expect(await s.rpc("overBudget", {})).toEqual({ threads: [] });
  });

  it("answers the Burn page at list price when asked, leaving budgets out", async () => {
    const s = await setup({
      settings: { discount: 50, threadBudget: 3, dailyBudget: 3 },
      logs: { [THREAD]: [today(user("hi")), today(assistant(4))] },
      listed: [{ id: THREAD, providerId: "pi", updatedAt: Date.now(), deletedAt: null }],
    });
    s.harness.sdk.stub("projects.list", async () => []);
    type Spend = { total: number; listPrice: boolean; dailyBudget: number | null; overBudgetCount: number; threads: { budget: number | null }[] };
    const discounted = await s.rpc<Spend>("spend", { range: "today", projectId: null });
    expect(discounted).toMatchObject({ listPrice: false, dailyBudget: 3 });
    expect(discounted.total).toBeCloseTo(2);
    expect(discounted.threads[0]?.budget).toBe(3);
    const atList = await s.rpc<Spend>("spend", { range: "today", projectId: null, listPrice: true });
    expect(atList).toMatchObject({ listPrice: true, dailyBudget: null, overBudgetCount: 0 });
    expect(atList.total).toBeCloseTo(4);
    expect(atList.threads[0]?.budget).toBeNull();
  });

  it("discounts a report pi sent for a thread with no log", async () => {
    const s = await setup({ settings: { discount: 50 } });
    await s.post(envelope(1, costOf(4)));
    expect((await s.usage()).report.cost.total).toBeCloseTo(2);
  });

  /** One look at THREAD: its host says its log changed, and the look is done once THREAD's usage signal goes out. */
  async function look(s: Awaited<ReturnType<typeof setup>>, ...entries: unknown[]) {
    const signalled = () => s.signals().filter((sig) => (sig.payload as { threadId?: string }).threadId === THREAD).length;
    const before = signalled();
    await s.spend(THREAD, ...entries);
    await vi.waitFor(() => expect(signalled()).toBe(before + 1));
  }

  /** The baseline look, before which a thread from before the plugin loaded fires nothing. */
  async function firstLook(s: Awaited<ReturnType<typeof setup>>) {
    await s.usage();
    await look(s);
  }

  /** A call whose cost is only these line items. */
  const pricedCall = (cost: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>>) => {
    const call = assistant(0);
    const parts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost };
    call.message.usage = { ...call.message.usage, cost: { ...parts, total: parts.input + parts.output + parts.cacheRead + parts.cacheWrite } };
    return call;
  };

  it("alerts on spend after a discount change, and never on the change itself", async () => {
    const s = await setup({ settings: { threadBudget: 10 }, logs: { [THREAD]: [user(), assistant(12)] } });
    await firstLook(s);
    await s.harness.behavior.setSettings({ discount: 50 });
    await look(s);
    expect(s.alerts()).toEqual([]);
    await look(s, assistant(10));
    await vi.waitFor(() => expect(s.alerts().map((a) => a.kind)).toEqual(["over"]));
  });

  it("stays quiet when removing a discount puts a thread near its budget", async () => {
    const s = await setup({ settings: { threadBudget: 8, discount: 50 }, logs: { [THREAD]: [user(), assistant(7)] } });
    await firstLook(s);
    await s.harness.behavior.setSettings({ discount: 0 });
    await look(s);
    expect(s.alerts()).toEqual([]);
  });

  it("takes a falling list figure as a source catching up, even when its discounted figure rises", async () => {
    const s = await setup({
      settings: { threadBudget: 10, inputDiscount: 100, outputDiscount: -100 },
      logs: { [THREAD]: [user(), pricedCall({ input: 10 })] },
    });
    await firstLook(s);
    s.logs[THREAD] = [user(), pricedCall({ output: 9 })];
    await look(s);
    expect((await s.usage()).report.cost.total).toBeCloseTo(18);
    expect(s.alerts()).toEqual([]);
  });

  it("refreshes every view when a discount changes, and only then", async () => {
    const s = await setup();
    await s.harness.behavior.setSettings({ discount: 50 });
    expect(s.signals()).toEqual([{ channel: "usage", payload: {} }]);
    await s.harness.behavior.setSettings({ chip: false });
    expect(s.signals()).toHaveLength(1);
  });

  // checkDailyBudget marking the day as alerted is covered in test/bb/spend.server.test.ts.
  it("runs the daily check once on a discount change and shows none of its alert", async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    const daily: BurnAlert = { id: "daily:2026-10-18", kind: "daily", threadId: null, title: "Daily budget reached", body: "…", at: 1 };
    const check = vi.spyOn(spendServer, "checkDailyBudget").mockResolvedValue(daily);
    const s = await setup({ settings: { dailyBudget: 50 } });
    await s.harness.behavior.setSettings({ discount: 50 });
    expect(check).toHaveBeenCalledTimes(1);
    await settle();
    expect(s.alerts()).toEqual([]);
    await s.harness.behavior.setSettings({ chip: false });
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    expect(s.signals()).toHaveLength(1);
  });

  it("keeps a line item at list price when its override is 0", async () => {
    const s = await setup({ settings: { discount: 50, inputDiscount: 0 }, logs: { [THREAD]: [user("hi"), assistant(4)] } });
    const { cost } = (await s.usage()).report;
    expect(cost.input).toBeCloseTo(2);
    expect(cost.output).toBeCloseTo(0.5);
    expect(cost.total).toBeCloseTo(3);
  });
});

it('sends one family native aggregate while retaining per-thread rows', async () => {
 const s = await setup({descendants:{[THREAD]:[CHILD]}});
 const agents = {coverage:'available' as const, rows:Array.from({length:120}, (_,i) => ({id:`native-${i}`,calls:1,cost:{input:1,output:0,cacheRead:0,cacheWrite:0,total:1},estimated:false}))};
 await s.post(envelope(1, {...costOf(120),agents}));
 await s.post(envelope(1, {...costOf(120),agents},CHILD));
 const got = await s.usage();
 expect(got.family.agents?.count).toBe(240);
 expect(got.family.agents?.rows).toHaveLength(1);
 expect(got.family.agents?.rows[0]).toMatchObject({id:'family-total',calls:240,cost:{total:240}});
 expect(got.report?.agents?.rows).toHaveLength(120);
 expect(got.family.children[0]?.agents?.rows).toHaveLength(120);
});
