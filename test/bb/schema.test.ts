import { describe, expect, it } from "vitest";
import { usageEnvelopeSchema, usageReportSchema } from "../../extensions/bb/schema.js";
import {
  AGENTS_MAX,
  buildReport,
  CALL_COSTS_MAX,
  CALL_TIME_BUCKETS,
  DAY_MODELS_MAX,
  DAYS_MAX,
  HOURS_MAX,
  MODELS_MAX,
  OTHER_KEY,
  PROMPT_MAX,
  SERIES_MAX,
  TURN_MODELS_MAX,
  TURN_TOOLS_MAX,
  TURNS_MAX,
} from "../../src/report.js";
import { assistant, sampleReport, toolResult, user } from "../helpers.js";

describe("usageReportSchema", () => {
  it("accepts what buildReport produces", () => {
    const report = buildReport([user(), assistant(1), toolResult(2)], { tokens: 1, window: 2, percent: 50 });
    expect(usageReportSchema.safeParse(report).success).toBe(true);
    expect(usageReportSchema.safeParse(buildReport([], undefined)).success).toBe(true);
  });

  it("rejects negatives, NaN and oversize arrays", () => {
    const base = sampleReport();
    expect(usageReportSchema.safeParse({ ...base, cost: { ...base.cost, total: -1 } }).success).toBe(false);
    expect(usageReportSchema.safeParse({ ...base, lastTurnCost: Number.NaN }).success).toBe(false);
    const series = Array.from({ length: 61 }, () => ({ at: 1, cost: 1, tokens: 1 }));
    expect(usageReportSchema.safeParse({ ...base, series }).success).toBe(false);
    const byModel = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, cost: 1, tokens: 1, calls: 1 }));
    expect(usageReportSchema.safeParse({ ...base, byModel }).success).toBe(false);
  });

  it("folds an older extension's oversized agent rows instead of rejecting them", () => {
    const base = sampleReport();
    const rows = Array.from({ length: AGENTS_MAX + 5 }, (_, i) => ({
      id: `agent-${i}`,
      calls: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      estimated: false,
    }));
    const parsed = usageReportSchema.parse({ ...base, agents: { coverage: "partial", rows } });
    expect(parsed.agents?.rows).toHaveLength(AGENTS_MAX);
    expect(parsed.agents?.rows.at(-1)?.id).toBe(OTHER_KEY);
  });

  it("upgrades a version 1 report from an older extension", () => {
    const { turnCount, turns, days, running, budget, stoppedAt, ...rest } = sampleReport();
    const v1 = { ...rest, version: 1, series: rest.series.map(({ turn, ...p }) => p) };
    const parsed = usageReportSchema.parse(v1);
    expect(parsed).toMatchObject({
      version: 2,
      turnCount: 0,
      turns: [],
      days: [],
      utcDays: [],
      hours: [],
      running: false,
      budget: null,
      stoppedAt: null,
      estimated: false,
    });
    expect(parsed.series.every((p) => p.turn === 0)).toBe(true);
  });

  it("reads a version 2 report from Burn 0.2, which has no UTC days, with none", () => {
    const { utcDays, ...older } = sampleReport();
    expect(usageReportSchema.parse(older).utcDays).toEqual([]);
    expect(usageReportSchema.parse(sampleReport()).utcDays).toEqual(sampleReport().utcDays);
    const tooMany = Array.from({ length: DAYS_MAX + 1 }, () => sampleReport().utcDays[0]);
    expect(usageReportSchema.safeParse({ ...sampleReport(), utcDays: tooMany }).success).toBe(false);
  });

  it("reads a report from Burn 0.2, which says nothing of estimates, as recorded", () => {
    const { estimated, ...older } = sampleReport();
    expect(usageReportSchema.parse(older).estimated).toBe(false);
    expect(usageReportSchema.parse(sampleReport({ estimated: true })).estimated).toBe(true);
  });

  it("reads day and model rows from Burn 0.2, which carry no detail, with zeros", () => {
    const older = { day: "2026-10-18", cost: 1, calls: 2, models: [{ key: "p/m", cost: 1 }] };
    const report = { ...sampleReport(), days: [older], utcDays: [older], byModel: [{ key: "p/m", cost: 1, tokens: 5, calls: 2 }] };
    const parsed = usageReportSchema.parse(report);
    expect(parsed.days[0]).toEqual({
      ...older,
      models: [{ key: "p/m", cost: 1, calls: 0, tokens: 0 }],
      prompts: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      costs: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      callTime: new Array(CALL_TIME_BUCKETS).fill(0),
      failed: 0,
      aborted: 0,
    });
    expect(parsed.byModel[0]).toEqual({ key: "p/m", cost: 1, tokens: 5, calls: 2, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ms: 0, timed: 0, timedOutput: 0, failed: 0 });
    // Each parse gets its own zeros, so changing one report's cannot change another's.
    expect(usageReportSchema.parse(report).days[0]?.tokens).not.toBe(parsed.days[0]?.tokens);
    expect(parsed.days[0]?.callTime).not.toBe(parsed.utcDays[0]?.callTime);
  });

  it("reads model rows from Burn 0.5, which do not count timed output, with it when every call was timed", () => {
    const row = { key: "p/m", cost: 1, tokens: 5, calls: 4, output: 800, timed: 4, ms: 2000 };
    const parsed = usageReportSchema.parse({ ...sampleReport(), byModel: [row, { ...row, key: "p/n", timed: 3 }] });
    expect(parsed.byModel.map((m) => m.timedOutput)).toEqual([800, 0]);
    expect(usageReportSchema.parse({ ...sampleReport(), byModel: [{ ...row, timedOutput: 600 }] }).byModel[0]?.timedOutput).toBe(600);
  });

  it("reads a report from Burn 0.2, which has no hours, with none, and bounds the hours and call-time buckets", () => {
    const { hours, ...older } = sampleReport();
    expect(usageReportSchema.parse(older).hours).toEqual([]);
    const hour = { hour: 497_878, calls: 1, tokens: 2, cost: 0.5 };
    expect(usageReportSchema.parse(sampleReport({ hours: [hour] })).hours).toEqual([hour]);
    expect(usageReportSchema.safeParse(sampleReport({ hours: new Array(HOURS_MAX + 1).fill(hour) })).success).toBe(false);
    const day = { ...(sampleReport().days[0] as object), callTime: [1] };
    expect(usageReportSchema.safeParse({ ...sampleReport(), days: [day] }).success).toBe(false);
  });

  it("keeps a report at every array limit, UTC days and hours included, under the 240 KiB a POST or host batch allows", () => {
    // Real provider/model keys run to about 40 characters; the schema allows longer ones.
    const key = (i: number) => `anthropic/claude-opus-4-5-2025110${i}-long`.padEnd(40, "x");
    const f = 0.12345678901234568;
    const day = (i: number) => ({
      day: `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
      cost: f,
      calls: 123_456,
      models: Array.from({ length: DAY_MODELS_MAX }, (_, j) => ({ key: key(j), cost: f, calls: 123_456, tokens: 123_456_789_012 })),
      prompts: 12_345,
      tokens: { input: 123_456_789, output: 123_456_789, cacheRead: 123_456_789_012, cacheWrite: 123_456_789, reasoning: 123_456_789 },
      costs: { input: f, output: f, cacheRead: f, cacheWrite: f },
      callTime: Array.from({ length: CALL_TIME_BUCKETS }, () => 123_456),
      failed: 12_345,
      aborted: 12_345,
    });
    const report = sampleReport({
      byModel: Array.from({ length: MODELS_MAX }, (_, i) => ({
        key: key(i),
        cost: f,
        tokens: 123_456_789_012,
        calls: 12_345,
        input: 123_456_789,
        output: 123_456_789,
        cacheRead: 123_456_789_012,
        cacheWrite: 123_456_789,
        timed: 12_345,
        ms: 123_456_789_012,
        timedOutput: 123_456_789,
        failed: 12_345,
      })),
      series: Array.from({ length: SERIES_MAX }, () => ({ at: 1_792_361_592_787, cost: f, tokens: 123_456, turn: 50 })),
      turns: Array.from({ length: TURNS_MAX }, (_, n) => ({
        n,
        at: 1_792_361_592_787,
        endAt: 1_792_361_592_787,
        prompt: `${"x".repeat(PROMPT_MAX - 1)}\u2026`,
        calls: 999,
        cost: f,
        tokens: { input: 123_456, output: 123_456, cacheRead: 12_345_678, cacheWrite: 123_456 },
        callCosts: Array.from({ length: CALL_COSTS_MAX }, () => f),
        tools: Array.from({ length: TURN_TOOLS_MAX }, (_, i) => ({ name: `tool_name_number_${i}`, count: 999 })),
        models: Array.from({ length: TURN_MODELS_MAX }, (_, i) => key(i)),
        ms: 123_456_789,
        timedOutput: 123_456,
      })),
      days: Array.from({ length: DAYS_MAX }, (_, i) => day(i)),
      utcDays: Array.from({ length: DAYS_MAX }, (_, i) => day(i)),
      hours: Array.from({ length: HOURS_MAX }, (_, i) => ({ hour: 497_878 + i, calls: 12_345, tokens: 123_456_789_012, cost: f })),
    });
    expect(usageReportSchema.safeParse(report).success).toBe(true);
    const envelope = { threadId: "thr_aaaaaaaaaaaa", sentAt: 1_792_361_592_787, report };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(240 * 1024);
  });

  it("drops unknown fields", () => {
    const parsed = usageReportSchema.parse({ ...sampleReport(), extra: 1 });
    expect("extra" in parsed).toBe(false);
  });
});

describe("usageEnvelopeSchema", () => {
  it("requires a bb thread id", () => {
    const base = { sentAt: 1, report: sampleReport() };
    expect(usageEnvelopeSchema.safeParse({ ...base, threadId: "thr_abc123def4" }).success).toBe(true);
    expect(usageEnvelopeSchema.safeParse({ ...base, threadId: "nope" }).success).toBe(false);
  });
});
