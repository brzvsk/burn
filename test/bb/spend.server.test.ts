import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { reportKey, SPEND_PANELS_KEY } from "../../extensions/bb/keys.js";
import { spendMethods } from "../../extensions/bb/spend/contract.js";
import { dayDate, localDays } from "../../extensions/bb/spend/days.js";
import { checkDailyBudget, createSpendHandlers, type SpendDeps } from "../../extensions/bb/spend/server.js";
import { CALL_TIME_BUCKETS, dayKey, type DayRow, HOUR_MS, type UsageReport } from "../../src/report.js";
import { dayRow, modelRow, sampleReport } from "../helpers.js";

const NOW = new Date(2026, 9, 18, 15, 0, 0).getTime();
const DAY_MS = 86_400_000;
const ago = (n: number): string => dayKey(new Date(2026, 9, 18 - n, 12).getTime());
const utcAgo = (n: number): string => localDays(NOW, 1, n, "utc")[0] as string;

interface Seed {
  title?: string | null;
  titleFallback?: string | null;
  projectId?: string;
  children?: number;
  deletedAt?: number | null;
  providerId?: string;
}

const PROJECTS = [
  { id: "proj_a", name: "alpha" },
  { id: "proj_b", name: "beta" },
  { id: "proj_c", name: "gamma" },
];

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

type ModelUse = number | { cost?: number; calls?: number; tokens?: number };

/** A day's row: each model a cost, or its cost, calls and tokens; `detail` sets the rest. */
const day = (daysAgo: number, cost: number, models: Record<string, ModelUse> = { "p/claude-opus": cost }, calls = 2, detail: Partial<DayRow> = {}): DayRow => ({
  ...dayRow(ago(daysAgo), cost, {}, calls),
  models: Object.entries(models).map(([key, m]) =>
    typeof m === "number" ? { key, cost: m, calls: 0, tokens: 0 } : { key, cost: m.cost ?? 0, calls: m.calls ?? 0, tokens: m.tokens ?? 0 },
  ),
  ...detail,
});

/** Day tokens, all input unless given. */
const toks = (input: number, more: Partial<DayRow["tokens"]> = {}): DayRow["tokens"] => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...more });

const reportWith = (days: DayRow[], over: Partial<UsageReport> = {}): UsageReport => {
  const total = days.reduce((sum, d) => sum + d.cost, 0);
  return sampleReport({
    days,
    cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
    calls: days.reduce((sum, d) => sum + d.calls, 0),
    ...over,
  });
};

async function setup(opts: {
  reports: Record<string, unknown>;
  threads: Record<string, Seed>;
  budgets?: Record<string, number>;
  daily?: number | null;
}) {
  const { threads } = opts;
  const { bb, harness } = createFakePluginHost({
    pluginId: "burn",
    sdk: {
      threads: {
        experimental_listDescendants: ({ threadIds }) => ({
          threads: threadIds
            .filter((id) => threads[id] !== undefined && !threads[id]?.deletedAt)
            .map((id) => ({ threadId: id, descendantIds: Array.from({ length: threads[id]?.children ?? 0 }, (_, i) => `${id}_c${i}`) })),
        }),
        get: ({ threadId }) => {
          const seed = threads[threadId];
          if (!seed) throw new Error(`Thread not found: ${threadId}`);
          return makeThreadResponse({
            id: threadId,
            title: seed.title === undefined ? `Title of ${threadId}` : seed.title,
            titleFallback: seed.titleFallback ?? null,
            projectId: seed.projectId ?? "proj_a",
            providerId: seed.providerId ?? "pi",
            deletedAt: seed.deletedAt ?? null,
          });
        },
      },
      projects: { list: () => PROJECTS },
    },
  });
  disposers.push(() => harness.lifecycle.dispose());
  for (const [id, value] of Object.entries(opts.reports)) {
    await bb.storage.kv.set(reportKey(id), value instanceof Object && "version" in value ? { report: value, sentAt: 1, at: 1 } : value);
  }
  let now = NOW;
  const makeDeps = (): SpendDeps => ({
    bb,
    budgetOf: async (threadId) => opts.budgets?.[threadId] ?? null,
    dailyBudget: async () => opts.daily ?? null,
    now: () => now,
  });
  const deps = makeDeps();
  const { spend, spendPanels, setSpendPanels } = createSpendHandlers(deps);
  return {
    bb,
    harness,
    deps,
    makeDeps,
    spend,
    spendPanels,
    setSpendPanels,
    setNow: (next: number) => {
      now = next;
    },
    sdkCalls: (path: string) => harness.sdk.callsTo(path),
  };
}

describe("spend", () => {
  it("sums the range and the same length before it, every day zero-filled and oldest first", async () => {
    const s = await setup({
      reports: { thr_aaaaaa01: reportWith([day(14, 9), day(13, 1), day(7, 4), day(6, 0.5), day(3, 1), day(0, 2)]) },
      threads: { thr_aaaaaa01: {} },
    });
    const week = await s.spend({ range: "7d", projectId: null });
    expect(week.total).toBeCloseTo(3.5);
    expect(week.previousTotal).toBeCloseTo(5);
    expect(week.days.map((d) => d.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(ago));
    expect(week.days.map((d) => d.cost)).toEqual([0.5, 0, 0, 1, 0, 0, 2]);
    expect(week.days[1]?.models).toEqual([]);
    expect(week.days[6]?.models).toEqual([{ key: "p/claude-opus", cost: 2, calls: 0, tokens: 0 }]);
    expect(week.metric).toBe("cost");

    const today = await s.spend({ range: "today", projectId: null });
    expect(today.days.map((d) => d.day)).toEqual([ago(0)]);
    expect(today.total).toBeCloseTo(2);
    expect(today.previousTotal).toBe(0);

    const month = await s.spend({ range: "30d", projectId: null });
    expect(month.days).toHaveLength(30);
    expect(month.days[0]?.day).toBe(ago(29));
    expect(month.total).toBeCloseTo(17.5);
    expect(month.range).toBe("30d");
  });

  it("ends the range on an earlier day when asked, and names today", async () => {
    const s = await setup({
      reports: { thr_aaaaaa01: reportWith([day(14, 9), day(13, 1), day(7, 4), day(6, 0.5), day(3, 1), day(0, 2)]) },
      threads: { thr_aaaaaa01: {} },
    });
    const earlier = await s.spend({ range: "7d", projectId: null, end: ago(7) });
    expect(earlier.days.map((d) => d.day)).toEqual([13, 12, 11, 10, 9, 8, 7].map(ago));
    expect(earlier.total).toBeCloseTo(5);
    expect(earlier.previousTotal).toBeCloseTo(9);
    expect(earlier.today).toBe(ago(0));

    const oneDay = await s.spend({ range: "today", projectId: null, end: ago(3) });
    expect(oneDay.days.map((d) => d.day)).toEqual([ago(3)]);
    expect(oneDay.total).toBeCloseTo(1);

    const later = await s.spend({ range: "7d", projectId: null, end: "2099-01-01" });
    const latest = await s.spend({ range: "7d", projectId: null });
    expect(later).toEqual(latest);
    expect(latest.today).toBe(ago(0));
  });

  it("ends a UTC range on an earlier UTC day, and names today in UTC", async () => {
    const s = await setup({ reports: { thr_aaaaaa01: reportWith([day(0, 2)]) }, threads: { thr_aaaaaa01: {} } });
    const week = await s.spend({ range: "7d", projectId: null, tz: "utc", end: utcAgo(7) });
    expect(week.days.map((d) => d.day)).toEqual(localDays(dayDate(utcAgo(7), "utc").getTime(), 7, 0, "utc"));
    expect(week.days.at(-1)?.day).toBe(utcAgo(7));
    expect(week.today).toBe(utcAgo(0));
  });

  it("takes only a real calendar day as the range's end", () => {
    const input = spendMethods.spend.input;
    expect(input.safeParse({ range: "7d", projectId: null, end: "2026-02-30" }).success).toBe(false);
    expect(input.safeParse({ range: "7d", projectId: null, end: "2026-10-09" }).success).toBe(true);
    expect(input.parse({ range: "7d", projectId: null }).end).toBeNull();
  });

  it("sums each day's models across threads and folds beyond four into Other", async () => {
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(0, 10, { "p/m1": 6, "p/m2": 4 }), day(1, 3, { "p/m4": 3 })]),
        thr_aaaaaa02: reportWith([day(0, 8, { "p/m1": 1, "p/m3": 4, "p/m5": 2, "p/m6": 1 })]),
      },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: {} },
    });
    const out = await s.spend({ range: "7d", projectId: null });
    expect(out.models).toMatchObject([
      { key: "p/m1", cost: 7 },
      { key: "p/m2", cost: 4 },
      { key: "p/m3", cost: 4 },
      { key: "Other", cost: 6 },
    ]);
    expect(out.days[6]).toMatchObject({
      day: ago(0),
      cost: 18,
      models: [
        { key: "p/m1", cost: 7 },
        { key: "p/m2", cost: 4 },
        { key: "p/m3", cost: 4 },
        { key: "Other", cost: 3 },
      ],
    });
    expect(out.days[5]?.models).toMatchObject([{ key: "Other", cost: 3 }]);
  });

  it("filters everything to one project, and offers every project with a report", async () => {
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(0, 5), day(8, 1)]),
        thr_aaaaaa02: reportWith([day(1, 3), day(9, 2)]),
        thr_aaaaaa03: reportWith([day(2, 1)]),
        thr_aaaaaa04: reportWith([day(40, 7)]),
      },
      threads: {
        thr_aaaaaa01: { projectId: "proj_b" },
        thr_aaaaaa02: { projectId: "proj_a" },
        thr_aaaaaa03: { projectId: "proj_a" },
        thr_aaaaaa04: { projectId: "proj_c" },
      },
    });
    const all = await s.spend({ range: "7d", projectId: null });
    expect(all.projects).toEqual([
      { projectId: "proj_b", name: "beta", cost: 5, tokens: 0, calls: 2 },
      { projectId: "proj_a", name: "alpha", cost: 4, tokens: 0, calls: 4 },
    ]);
    expect(all.projectOptions).toEqual([
      { projectId: "proj_a", name: "alpha" },
      { projectId: "proj_b", name: "beta" },
      { projectId: "proj_c", name: "gamma" },
    ]);

    const alpha = await s.spend({ range: "7d", projectId: "proj_a" });
    expect(alpha.total).toBe(4);
    expect(alpha.previousTotal).toBe(2);
    expect(alpha.threadCount).toBe(2);
    expect(alpha.threads.map((t) => t.threadId)).toEqual(["thr_aaaaaa02", "thr_aaaaaa03"]);
    expect(alpha.projects).toMatchObject([{ projectId: "proj_a", name: "alpha", cost: 4 }]);
    expect(alpha.days.map((d) => d.cost)).toEqual([0, 0, 0, 0, 1, 3, 0]);
    expect(alpha.projectOptions).toEqual(all.projectOptions);
    expect(alpha.reportedThreads).toBe(4);
  });

  it("lists the ten costliest threads in the range with what the table shows", async () => {
    const reports: Record<string, UsageReport> = {};
    const threads: Record<string, Seed> = {};
    for (let i = 1; i <= 12; i++) {
      const id = `thr_bbbbbb${String(i).padStart(2, "0")}`;
      reports[id] = reportWith([day(0, i, { "p/claude-haiku": i / 4, "p/claude-opus": (3 * i) / 4 }, i), day(20, 100)], {
        running: i === 12,
      });
      threads[id] = { projectId: "proj_b", children: i === 12 ? 3 : 0 };
    }
    threads.thr_bbbbbb11 = { title: null, titleFallback: "Fix the flaky test", projectId: "proj_b" };
    threads.thr_bbbbbb10 = { title: null, projectId: "proj_b" };
    const s = await setup({ reports, threads });
    const out = await s.spend({ range: "7d", projectId: null });
    expect(out.threadCount).toBe(12);
    expect(out.threads.map((t) => t.rangeCost)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(out.threads[0]).toEqual({
      threadId: "thr_bbbbbb12",
      title: "Title of thr_bbbbbb12",
      projectName: "beta",
      model: "claude-opus",
      harness: "pi",
      childCount: 3,
      calls: 12,
      tokens: 0,
      rangeCost: 12,
      total: 112,
      budget: null,
      running: true,
      estimated: false,
    });
    expect(out.threads[1]?.title).toBe("Fix the flaky test");
    expect(out.threads[2]?.title).toBe("Untitled thread");
    expect(out.threads[2]?.running).toBe(false);
  });

  it("marks each estimated thread, and says when the spend it counts includes one", async () => {
    const threads: Record<string, Seed> = { thr_aaaaaa01: {}, thr_aaaaaa02: {}, thr_aaaaaa03: {} };
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(0, 2)], { estimated: true }),
        thr_aaaaaa02: reportWith([day(0, 1)]),
        thr_aaaaaa03: reportWith([day(20, 5)], { estimated: true }),
      },
      threads,
    });
    const out = await s.spend({ range: "7d", projectId: null });
    expect(out.estimated).toBe(true);
    expect(out.threads.map((t) => [t.threadId, t.estimated])).toEqual([
      ["thr_aaaaaa01", true],
      ["thr_aaaaaa02", false],
    ]);
    const exact = await setup({ reports: { thr_aaaaaa02: reportWith([day(0, 1)]), thr_aaaaaa03: reportWith([day(20, 5)], { estimated: true }) }, threads });
    expect((await exact.spend({ range: "7d", projectId: null })).estimated).toBe(false);
  });

  it("sums each thread's UTC days over UTC calendar days when asked, and says which", async () => {
    const utc = (n: number, cost: number): DayRow => dayRow(utcAgo(n), cost, { "p/claude-opus": cost }, 1);
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(0, 2)], { utcDays: [utc(1, 1), utc(0, 5)] }),
        // Burn 0.2 sent no UTC days; its local days stand in for them.
        thr_aaaaaa02: reportWith([day(1, 3)], { utcDays: [] }),
      },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: {} },
    });
    const today = await s.spend({ range: "today", projectId: null, tz: "utc" });
    expect(today).toMatchObject({ tz: "utc", total: 5 });
    expect(today.days.map((d) => d.day)).toEqual([utcAgo(0)]);
    const week = await s.spend({ range: "7d", projectId: null, tz: "utc" });
    expect(week.days.map((d) => d.day)).toEqual(localDays(NOW, 7, 0, "utc"));
    expect(week.total).toBeCloseTo(9);
    expect(await s.spend({ range: "today", projectId: null })).toMatchObject({ tz: "local", total: 2 });
  });

  it("counts threads over their effective budget", async () => {
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(0, 4), day(30, 8)]),
        thr_aaaaaa02: reportWith([day(0, 2)]),
        thr_aaaaaa03: reportWith([day(0, 1)]),
        thr_aaaaaa04: reportWith([day(20, 50)]),
      },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: {}, thr_aaaaaa03: {}, thr_aaaaaa04: {} },
      budgets: { thr_aaaaaa01: 10, thr_aaaaaa02: 2, thr_aaaaaa03: 5, thr_aaaaaa04: 1 },
    });
    const out = await s.spend({ range: "7d", projectId: null });
    expect(out.overBudgetCount).toBe(2);
    expect(out.threads.map((t) => [t.threadId, t.budget])).toEqual([
      ["thr_aaaaaa01", 10],
      ["thr_aaaaaa02", 2],
      ["thr_aaaaaa03", 5],
    ]);
  });

  it("reports the median thread, cost per call and cache hit rate across the threads in range", async () => {
    // The lifetime totals would give a cache hit rate of 0%; the range's own days give 40%.
    const lifetime = { tokens: { input: 9000, output: 9, cacheRead: 0, cacheWrite: 0, reasoning: 0 } };
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(0, 1, undefined, 1, { tokens: toks(100, { output: 9, cacheRead: 300 }) })], lifetime),
        thr_aaaaaa02: reportWith([day(1, 3, undefined, 3, { tokens: toks(100, { output: 9, cacheRead: 100, cacheWrite: 400 }) })], lifetime),
        thr_aaaaaa03: reportWith([day(2, 8, undefined, 4, { tokens: toks(0, { output: 9 }) })], lifetime),
        thr_aaaaaa04: reportWith([day(12, 90, undefined, 2, { tokens: toks(9000) })], lifetime),
      },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: {}, thr_aaaaaa03: {}, thr_aaaaaa04: {} },
      daily: 50,
    });
    const out = await s.spend({ range: "7d", projectId: null });
    expect(out.medianThreadCost).toBe(3);
    expect(out.perCall).toBe(12 / 8);
    expect(out.cacheHitPct).toBe(40);
    expect(out.dailyBudget).toBe(50);

    const none = await s.spend({ range: "7d", projectId: "proj_c" });
    expect(none).toMatchObject({ total: 0, threadCount: 0, medianThreadCost: null, perCall: null, cacheHitPct: null, threads: [] });
  });

  it("skips entries that do not parse without deleting them, and threads that no longer exist", async () => {
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(0, 1)]),
        thr_aaaaaa02: { report: { version: 9 }, sentAt: 1, at: 1 },
        thr_aaaaaa03: reportWith([day(0, 2)]),
        thr_aaaaaa04: reportWith([day(0, 4)]),
      },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa04: { deletedAt: 5 } },
    });
    const out = await s.spend({ range: "7d", projectId: null });
    expect(out.threads.map((t) => t.threadId)).toEqual(["thr_aaaaaa01"]);
    expect(out.total).toBe(1);
    expect(out.reportedThreads).toBe(1);
    expect(await s.bb.storage.kv.get(reportKey("thr_aaaaaa02"))).toEqual({ report: { version: 9 }, sentAt: 1, at: 1 });
    expect(s.sdkCalls("threads.get").map(([args]) => (args as { threadId: string }).threadId)).toEqual(["thr_aaaaaa01"]);
  });

  it("answers with nothing reported when nothing is stored", async () => {
    const s = await setup({ reports: {}, threads: {} });
    const out = await s.spend({ range: "7d", projectId: null });
    expect(out).toMatchObject({ reportedThreads: 0, total: 0, threads: [], projects: [], projectOptions: [], models: [] });
    expect(out.days).toHaveLength(7);
    expect(s.sdkCalls("threads.experimental_listDescendants")).toEqual([]);
  });

  it("keeps thread details for about a minute", async () => {
    const s = await setup({
      reports: { thr_aaaaaa01: reportWith([day(0, 1)]), thr_aaaaaa02: reportWith([day(0, 2)]) },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: {} },
    });
    await s.spend({ range: "7d", projectId: null });
    await s.spend({ range: "30d", projectId: "proj_a" });
    expect(s.sdkCalls("threads.get")).toHaveLength(2);
    expect(s.sdkCalls("threads.experimental_listDescendants")).toHaveLength(1);
    expect(s.sdkCalls("projects.list")).toHaveLength(1);
    s.setNow(NOW + 61_000);
    await s.spend({ range: "7d", projectId: null });
    expect(s.sdkCalls("threads.get")).toHaveLength(4);
    expect(s.sdkCalls("projects.list")).toHaveLength(2);
  });

  it("looks up at most 200 threads per descendants call", async () => {
    const reports: Record<string, UsageReport> = {};
    const threads: Record<string, Seed> = {};
    for (let i = 0; i < 450; i++) {
      const id = `thr_c${String(i).padStart(6, "0")}`;
      reports[id] = reportWith([day(i % 10, 1)]);
      threads[id] = {};
    }
    const s = await setup({ reports, threads });
    await s.spend({ range: "7d", projectId: null });
    expect(s.sdkCalls("threads.experimental_listDescendants").map(([args]) => (args as { threadIds: string[] }).threadIds.length)).toEqual([
      200, 200, 50,
    ]);
  });

  it("stays fast with 500 stored reports", async () => {
    const reports: Record<string, UsageReport> = {};
    const threads: Record<string, Seed> = {};
    for (let i = 0; i < 500; i++) {
      const id = `thr_d${String(i).padStart(6, "0")}`;
      const days = Array.from({ length: 40 }, (_, k) => day(k, 0.1 + (i % 7) + k / 10, { "p/claude-opus": 0.1 + (i % 7), [`p/m${i % 6}`]: k / 10 }, 3));
      reports[id] = reportWith(days, { running: i % 50 === 0 });
      threads[id] = { projectId: PROJECTS[i % 3]?.id, children: i % 4 };
    }
    const s = await setup({ reports, threads, budgets: { thr_d000001: 1 } });
    // The first calls in a process pay for JIT warm-up of zod and this code; measure a fresh handler, with an empty thread cache, after them.
    await s.spend({ range: "7d", projectId: null });
    await createSpendHandlers(s.deps).spend({ range: "today", projectId: null });
    const runs: number[] = [];
    let out = await createSpendHandlers(s.deps).spend({ range: "30d", projectId: null });
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      out = await createSpendHandlers(s.deps).spend({ range: "30d", projectId: null });
      runs.push(performance.now() - started);
    }
    // Warm calls take about 60 ms; the limit is loose so other test files running in parallel cannot fail it, while a quadratic regression still would.
    const elapsed = [...runs].sort((a, b) => a - b)[1] as number;
    expect(out.threadCount).toBe(500);
    expect(out.threads).toHaveLength(10);
    expect(out.models.length).toBeLessThanOrEqual(4);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("spend by tokens and calls", () => {
  const mixed = () => ({
    reports: {
      thr_aaaaaa01: reportWith([
        day(0, 10.3, { "anthropic/opus": { cost: 10, calls: 5, tokens: 1000 }, "anthropic/haiku": { cost: 0.1, calls: 100, tokens: 10 }, "anthropic/sonnet": { cost: 0.2, tokens: 500 } }, 105, {
          tokens: toks(1510),
        }),
      ]),
      thr_aaaaaa02: reportWith([day(0, 2, { "codex/gpt": { cost: 2, calls: 50, tokens: 5000 } }, 50, { tokens: toks(5000) })], { estimated: true }),
      thr_aaaaaa03: reportWith([day(0, 4, { "claude-code/opus": { cost: 4, calls: 1, tokens: 20_000 } }, 1, { tokens: toks(20_000) })]),
    },
    threads: {
      thr_aaaaaa01: { projectId: "proj_a" },
      thr_aaaaaa02: { projectId: "proj_b", providerId: "codex" },
      thr_aaaaaa03: { projectId: "proj_c", providerId: "claude-code" },
    },
  });

  it("ranks the threads, projects, harnesses, Models table and chart by the metric asked for", async () => {
    const s = await setup(mixed());
    const by = async (metric: "cost" | "tokens" | "calls") => s.spend({ range: "7d", projectId: null, metric });
    const cost = await by("cost");
    const tokens = await by("tokens");
    const calls = await by("calls");
    expect([cost.metric, tokens.metric, calls.metric]).toEqual(["cost", "tokens", "calls"]);

    const ids = (out: typeof cost) => out.threads.map((t) => t.threadId.slice(-2));
    expect([ids(cost), ids(tokens), ids(calls)]).toEqual([
      ["01", "03", "02"],
      ["03", "02", "01"],
      ["01", "02", "03"],
    ]);
    expect(tokens.threads[0]).toMatchObject({ harness: "Claude Code", tokens: 20_000, calls: 1, rangeCost: 4 });

    const names = (rows: { name: string }[]) => rows.map((r) => r.name);
    expect([names(cost.projects), names(tokens.projects), names(calls.projects)]).toEqual([
      ["alpha", "gamma", "beta"],
      ["gamma", "beta", "alpha"],
      ["alpha", "beta", "gamma"],
    ]);
    expect([names(cost.harnesses), names(tokens.harnesses), names(calls.harnesses)]).toEqual([
      ["pi", "Claude Code", "Codex"],
      ["Claude Code", "Codex", "pi"],
      ["pi", "Codex", "Claude Code"],
    ]);
    expect(cost.harnesses.find((h) => h.providerId === "codex")).toEqual({ providerId: "codex", name: "Codex", cost: 2, tokens: 5000, calls: 50, estimated: true });

    const rows = (out: typeof cost) => out.modelStats.map((m) => m.key);
    expect(rows(cost)).toEqual(["anthropic/opus", "claude-code/opus", "codex/gpt", "anthropic/sonnet", "anthropic/haiku"]);
    expect(rows(tokens)).toEqual(["claude-code/opus", "codex/gpt", "anthropic/opus", "anthropic/sonnet", "anthropic/haiku"]);
    expect(rows(calls)).toEqual(["anthropic/haiku", "codex/gpt", "anthropic/opus", "claude-code/opus", "anthropic/sonnet"]);
    expect(cost.modelStats.map((m) => [m.harness, m.estimated])).toEqual([
      ["pi", false],
      ["Claude Code", false],
      ["Codex", true],
      ["pi", false],
      ["pi", false],
    ]);

    const chart = (out: typeof cost) => out.models.map((m) => m.key);
    expect(chart(cost)).toEqual(["anthropic/opus", "claude-code/opus", "codex/gpt", "Other"]);
    expect(chart(tokens)).toEqual(["claude-code/opus", "codex/gpt", "anthropic/opus", "Other"]);
    // No call reached sonnet, so it has no slice by calls.
    expect(chart(calls)).toEqual(["anthropic/haiku", "codex/gpt", "anthropic/opus", "claude-code/opus"]);
    expect(tokens.models.at(-1)).toMatchObject({ key: "Other", tokens: 510, calls: 100 });
    expect(tokens.models.at(-1)?.cost).toBeCloseTo(0.3);
    expect(tokens.days[6]).toMatchObject({ tokens: 26_510, calls: 156 });
    expect(tokens.days[6]?.cost).toBeCloseTo(16.3);
  });

  it("sums tokens, prompts and the token mix over the range only, and takes the cache hit rate from them", async () => {
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith(
          [
            day(10, 9, undefined, 2, { tokens: toks(7000), prompts: 9 }),
            day(3, 1, undefined, 2, { tokens: toks(100, { cacheRead: 100, cacheWrite: 400 }), prompts: 2, costs: { input: 0.25, output: 0, cacheRead: 0.25, cacheWrite: 0.5 } }),
            day(0, 2, undefined, 2, {
              tokens: toks(100, { output: 10, cacheRead: 300, reasoning: 5 }),
              prompts: 3,
              costs: { input: 1, output: 0.5, cacheRead: 0.5, cacheWrite: 0 },
            }),
          ],
          { tokens: { input: 9000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
        ),
      },
      threads: { thr_aaaaaa01: {} },
    });
    const week = await s.spend({ range: "7d", projectId: null });
    expect(week).toMatchObject({ tokens: 1010, previousTokens: 7000, calls: 4, prompts: 5, cacheHitPct: 40 });
    expect(week.mix).toEqual({
      tokens: { input: 200, output: 10, cacheRead: 400, cacheWrite: 400, reasoning: 5 },
      costs: { input: 1.25, output: 0.5, cacheRead: 0.75, cacheWrite: 0.5 },
    });
  });

  it("counts a token-only thread and a thread whose one call used nothing, without moving the median thread", async () => {
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(0, 2)]),
        thr_aaaaaa02: reportWith([day(0, 4)]),
        thr_aaaaaa03: reportWith([day(0, 0, { "codex/gpt": { tokens: 9000, calls: 3 } }, 3, { tokens: toks(9000) })]),
        thr_aaaaaa04: reportWith([day(0, 0, {}, 1)]),
      },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: {}, thr_aaaaaa03: { providerId: "codex" }, thr_aaaaaa04: {} },
    });
    const cost = await s.spend({ range: "7d", projectId: null });
    expect(cost).toMatchObject({ threadCount: 4, medianThreadCost: 3, perCall: 6 / 4, total: 6, tokens: 9000, calls: 8 });
    expect(cost.models.map((m) => m.key)).toEqual(["p/claude-opus"]);
    const tokens = await s.spend({ range: "7d", projectId: null, metric: "tokens" });
    expect(tokens.threads[0]?.threadId).toBe("thr_aaaaaa03");
    expect(tokens.days[6]?.models).toEqual([{ key: "codex/gpt", cost: 0, tokens: 9000, calls: 3 }]);
    const calls = await s.spend({ range: "7d", projectId: null, metric: "calls" });
    expect(calls.threads.map((t) => t.threadId)).toContain("thr_aaaaaa04");
  });

  it("estimates the call time from the range's buckets, with failed and stopped calls", async () => {
    const callTime = (at: Record<number, number>) => Array.from({ length: CALL_TIME_BUCKETS }, (_, i) => at[i] ?? 0);
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(20, 1, undefined, 9, { callTime: callTime({ 8: 9 }), failed: 9 }), day(0, 1, undefined, 60, { callTime: callTime({ 3: 60 }), failed: 2, aborted: 1 })]),
        thr_aaaaaa02: reportWith([day(1, 1, undefined, 40, { callTime: callTime({ 3: 40 }) })]),
      },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: {} },
    });
    const week = await s.spend({ range: "7d", projectId: null });
    expect(week.callTime).toMatchObject({ buckets: callTime({ 3: 100 }), timed: 100, failed: 2, aborted: 1 });
    expect(week.callTime.p50).toBeCloseTo(4000 * Math.SQRT2, 6);
    expect(week.callTime.p90).toBeGreaterThan(week.callTime.p50 as number);
    const none = await s.spend({ range: "today", projectId: "proj_b" });
    expect(none.callTime).toEqual({ buckets: callTime({}), timed: 0, failed: 0, aborted: 0, p50: null, p90: null });
  });

  it("maps the counted threads' hours onto the chosen days, in the zone and metric asked for", async () => {
    const local = new Date(2026, 9, 18, 11).getTime();
    const utc = Date.UTC(2026, 9, 17, 23);
    const hours = [
      { hour: Math.floor(local / HOUR_MS), calls: 3, tokens: 300, cost: 1.5 },
      { hour: Math.floor(utc / HOUR_MS), calls: 1, tokens: 50, cost: 0.25 },
    ];
    const s = await setup({
      // No UTC days, so the local ones stand in under UTC too.
      reports: {
        thr_aaaaaa01: reportWith([day(0, 1)], { hours, utcDays: [] }),
        thr_aaaaaa02: reportWith([day(0, 1)], { hours, utcDays: [] }),
        thr_aaaaaa03: reportWith([day(30, 1)], { hours, utcDays: [] }),
      },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: {}, thr_aaaaaa03: {} },
    });
    const week = await s.spend({ range: "7d", projectId: null, metric: "calls" });
    expect(week.activity.map((r) => r.day)).toEqual(week.days.map((d) => d.day));
    const at = new Date(hours[0]!.hour * HOUR_MS);
    expect(week.activity.find((r) => r.day === dayKey(at.getTime()))?.hours[at.getHours()]).toBe(6);
    const inUtc = await s.spend({ range: "7d", projectId: null, tz: "utc", metric: "tokens" });
    expect(inUtc.activity.find((r) => r.day === "2026-10-17")?.hours[23]).toBe(100);
  });

  it("keeps one model's rows apart per harness, and takes the ratios from the threads' whole lives, output speed from timed calls only", async () => {
    const opus = { "p/opus": { cost: 2, calls: 4, tokens: 900 } };
    const s = await setup({
      reports: {
        thr_aaaaaa01: reportWith([day(0, 2, opus, 4)], {
          byModel: [modelRow("p/opus", 9, 9000, 10, { input: 100, cacheRead: 300, cacheWrite: 100, output: 2000, timed: 8, ms: 8000, timedOutput: 1600, failed: 1 })],
        }),
        thr_aaaaaa02: reportWith([day(0, 2, opus, 4)], {
          estimated: true,
          byModel: [modelRow("p/opus", 5, 5000, 6, { input: 50, cacheRead: 50 })],
        }),
      },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: { providerId: "claude-code" } },
    });
    const out = await s.spend({ range: "7d", projectId: null });
    expect(out.modelStats).toEqual([
      { key: "p/opus", harness: "Claude Code", cost: 2, tokens: 900, calls: 4, cacheHitPct: 50, avgCallMs: null, outputPerSec: null, failedPct: null, estimated: true },
      { key: "p/opus", harness: "pi", cost: 2, tokens: 900, calls: 4, cacheHitPct: 60, avgCallMs: 1000, outputPerSec: 200, failedPct: 12.5, estimated: false },
    ]);
  });

  it("folds models past the tenth into Other, with a thread's own Other", async () => {
    const reports: Record<string, UsageReport> = {};
    const threads: Record<string, Seed> = {};
    for (let i = 1; i <= 11; i++) {
      const id = `thr_gggggg${String(i).padStart(2, "0")}`;
      reports[id] = reportWith([day(0, i, { [`p/m${i}`]: i })]);
      threads[id] = {};
    }
    reports.thr_gggggg12 = reportWith([day(0, 0.5, { Other: 0.5 })]);
    threads.thr_gggggg12 = {};
    const out = await (await setup({ reports, threads })).spend({ range: "7d", projectId: null });
    expect(out.modelStats).toHaveLength(11);
    expect(out.modelStats[0]?.key).toBe("p/m11");
    expect(out.modelStats.at(-1)).toEqual({
      key: "Other",
      harness: null,
      cost: 1.5,
      tokens: 0,
      calls: 0,
      cacheHitPct: null,
      avgCallMs: null,
      outputPerSec: null,
      failedPct: null,
      estimated: false,
    });
  });

  it("counts the threads running now", async () => {
    const s = await setup({
      reports: { thr_aaaaaa01: reportWith([day(0, 1)], { running: true }), thr_aaaaaa02: reportWith([day(0, 1)]), thr_aaaaaa03: reportWith([day(30, 1)], { running: true }) },
      threads: { thr_aaaaaa01: {}, thr_aaaaaa02: {}, thr_aaaaaa03: {} },
    });
    expect((await s.spend({ range: "7d", projectId: null })).runningCount).toBe(1);
  });
});

describe("spend panels", () => {
  it("keeps the hidden panels, deduped, and drops ids it does not know", async () => {
    const s = await setup({ reports: {}, threads: {} });
    expect(await s.spendPanels({})).toEqual({ hidden: [] });
    expect(await s.setSpendPanels({ hidden: ["mix", "mix", "threads"] })).toEqual({ hidden: ["mix", "threads"] });
    expect(await s.spendPanels({})).toEqual({ hidden: ["mix", "threads"] });
    await s.bb.storage.kv.set(SPEND_PANELS_KEY, { hidden: ["mix", "sparkles", 3] });
    expect(await s.spendPanels({})).toEqual({ hidden: ["mix"] });
    await s.bb.storage.kv.set(SPEND_PANELS_KEY, "nonsense");
    expect(await s.spendPanels({})).toEqual({ hidden: [] });
  });
});

describe("localDays and dayDate", () => {
  it("count UTC calendar days, and noon of a UTC day, when asked", () => {
    const late = Date.UTC(2026, 9, 18, 23, 30);
    expect(localDays(late, 2, 0, "utc")).toEqual(["2026-10-17", "2026-10-18"]);
    expect(localDays(late, 1, 1, "utc")).toEqual(["2026-10-17"]);
    expect(dayDate("2026-10-18", "utc").toISOString()).toBe("2026-10-18T12:00:00.000Z");
    expect(dayDate("2026-10-18").getHours()).toBe(12);
  });
});

describe("daily budget alert", () => {
  const nine = (): Record<string, UsageReport> => {
    const costs = [10, 9, 8, 7, 6, 5, 4, 2, 1.1];
    return Object.fromEntries(costs.map((cost, i) => [`thr_ffffff0${i}`, reportWith([day(0, cost), day(1, 30)])]));
  };

  it("does nothing without a Daily budget", async () => {
    const s = await setup({ reports: nine(), threads: {}, daily: null });
    expect(await checkDailyBudget(s.deps)).toBeNull();
  });

  it("fires once per day when today's spend across threads reaches the budget, across re-created deps", async () => {
    const s = await setup({ reports: { thr_eeeeee01: reportWith([day(0, 20), day(1, 80)]) }, threads: {}, daily: 50 });
    expect(await checkDailyBudget(s.deps)).toBeNull();

    for (const [id, report] of Object.entries(nine())) await s.bb.storage.kv.set(reportKey(id), { report, sentAt: 2, at: 2 });
    await s.bb.storage.kv.delete(reportKey("thr_eeeeee01"));
    const alert = await checkDailyBudget(s.deps);
    expect(alert).toEqual({
      id: `daily:${ago(0)}`,
      kind: "daily",
      threadId: null,
      title: "Daily budget reached",
      body: "$52.10 spent across 9 threads today, over the $50 daily budget.",
      at: NOW,
    });
    expect(await s.bb.storage.kv.get(`daily-alert:${ago(0)}`)).toBeTruthy();
    expect(await checkDailyBudget(s.deps)).toBeNull();
    expect(await checkDailyBudget(s.makeDeps())).toBeNull();

    s.setNow(NOW + DAY_MS);
    expect(await checkDailyBudget(s.makeDeps())).toBeNull();
    await s.bb.storage.kv.set(reportKey("thr_eeeeee0x"), { report: reportWith([day(-1, 60)]), sentAt: 3, at: 3 });
    expect(await checkDailyBudget(s.makeDeps())).toMatchObject({
      id: `daily:${ago(-1)}`,
      body: "$60.00 spent across 1 thread today, over the $50 daily budget.",
    });
  });

  it("marks the day's spend as an estimate when a thread that spent today is one", async () => {
    const s = await setup({ reports: {}, threads: {}, daily: 1 });
    const reports = async () => ({
      reading: 0,
      entries: [
        { threadId: "thr_eeeeee01", report: reportWith([day(0, 0.6)], { estimated: true }) },
        { threadId: "thr_eeeeee02", report: reportWith([day(0, 0.5)]) },
        { threadId: "thr_eeeeee03", report: reportWith([day(1, 9)], { estimated: true }) },
      ],
    });
    expect(await checkDailyBudget({ ...s.deps, reports })).toMatchObject({ body: "~$1.10 spent across 2 threads today, over the $1 daily budget." });
  });

  it("fires once when two reports arrive together", async () => {
    const s = await setup({ reports: nine(), threads: {}, daily: 50 });
    const both = await Promise.all([checkDailyBudget(s.deps), checkDailyBudget(s.makeDeps())]);
    expect(both.filter((a) => a !== null)).toHaveLength(1);
  });

  it("skips entries that do not parse", async () => {
    const s = await setup({
      reports: { thr_eeeeee01: reportWith([day(0, 49)]), thr_eeeeee02: { report: { version: 9, days: [{ day: ago(0), cost: 100 }] }, sentAt: 1, at: 1 } },
      threads: {},
      daily: 50,
    });
    expect(await checkDailyBudget(s.deps)).toBeNull();
  });
});

it('propagates injected descendant failures without caching missing threads', async () => {
  const s = await setup({reports:{thr_aaaaaa01:reportWith([day(0, 9)])},threads:{thr_aaaaaa01:{}}});
  let failed = true;
  const handlers = createSpendHandlers({...s.deps, descendantsOf:async ids => {
    if (failed) throw new Error('listing unavailable');
    return new Map(ids.map(id => [id, []]));
  }});
  await expect(handlers.spend({range:'7d',projectId:null})).rejects.toThrow('listing unavailable');
  failed = false;
  const got = await handlers.spend({range:'7d',projectId:null});
  expect(JSON.stringify(got)).toContain('thr_aaaaaa01');
});
