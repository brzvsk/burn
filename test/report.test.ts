import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENTS_MAX,
  buildReport,
  CALL_TIME_BUCKETS,
  callTimeBucket,
  dayKey,
  type EntryLike,
  forkedAt,
  HOUR_MS,
  HOURS_MAX,
  OTHER_KEY,
  outputPerSec,
  PROMPT_MAX,
  promptExcerpt,
  reportOutputPerSec,
  slimEntry,
  TURNS_MAX,
} from "../src/report.js";
import { assistant, compaction, toolResult, usageEntry, user } from "./helpers.js";

const at = (iso: string) => <T extends { timestamp: string }>(entry: T): T => ({ ...entry, timestamp: iso });

describe("buildReport", () => {
  it("returns zeros for no entries", () => {
    const r = buildReport([], undefined);
    expect(r).toMatchObject({ calls: 0, lastTurnCost: 0, startedAt: 0, updatedAt: 0, byModel: [], series: [], context: null });
    expect(r.cost.total).toBe(0);
    expect(r.cacheHitPct).toBeNull();
  });

  it("sums assistant usage and counts calls and series", () => {
    const r = buildReport([user(), assistant(1, "m1", { input: 10, output: 5, cacheRead: 90 }), assistant(2, "m1", { input: 20, output: 5 })], undefined);
    expect(r.calls).toBe(2);
    expect(r.cost.total).toBeCloseTo(3);
    expect(r.tokens).toMatchObject({ input: 30, output: 10, cacheRead: 90 });
    expect(r.series).toHaveLength(2);
    expect(r.series[0]).toMatchObject({ cost: 1, tokens: 105 });
    expect(r.cacheHitPct).toBeCloseTo((90 / 120) * 100);
  });

  it("counts toolResult, usage and compaction usage in totals but not in calls or series", () => {
    const r = buildReport([user(), assistant(1), toolResult(2), usageEntry(3), compaction(4)], undefined);
    expect(r.cost.total).toBeCloseTo(10);
    expect(r.calls).toBe(1);
    expect(r.series).toHaveLength(1);
  });

  it("lastTurnCost covers every usage entry after the last user message", () => {
    const r = buildReport([user(), assistant(5), user(), assistant(1), toolResult(0.5), compaction(0.25)], undefined);
    expect(r.lastTurnCost).toBeCloseTo(1.75);
  });

  it("groups by provider/model, folds the tail into Other and keeps rows summing to the total", () => {
    const entries: EntryLike[] = [user()];
    for (let i = 1; i <= 9; i++) entries.push(assistant(i, `m${i}`));
    entries.push(toolResult(0.5));
    const r = buildReport(entries, undefined);
    expect(r.byModel).toHaveLength(8);
    expect(r.byModel[0]?.key).toBe("p/m9");
    expect(r.byModel.at(-1)?.key).toBe("Other");
    expect(r.byModel.reduce((s, row) => s + row.cost, 0)).toBeCloseTo(r.cost.total);
    expect(r.byModel.find((row) => row.key === "Tools/summaries")?.calls ?? 0).toBe(0);
  });

  it("prefers responseModel and drops rows with no cost and no tokens", () => {
    const named = assistant(1);
    (named.message as { responseModel?: string }).responseModel = "actual";
    const empty = assistant(0, "none", { input: 0, output: 0 });
    const r = buildReport([user(), named, empty], undefined);
    expect(r.byModel.map((row) => row.key)).toEqual(["p/actual"]);
  });

  it("caps the series at the last 60 calls", () => {
    const entries: EntryLike[] = [user()];
    for (let i = 0; i < 70; i++) entries.push(assistant(1));
    const r = buildReport(entries, undefined);
    expect(r.series).toHaveLength(60);
    expect(r.calls).toBe(70);
  });

  it("falls back to a finite timestamp when one cannot be parsed", () => {
    const bad = assistant(1);
    bad.timestamp = "not a date";
    const r = buildReport([user(), bad, assistant(1)], undefined);
    expect(Number.isFinite(r.startedAt)).toBe(true);
    expect(r.series.every((p) => Number.isFinite(p.at))).toBe(true);
  });

  it("passes the context through", () => {
    const context = { tokens: 10, window: 100, percent: 10 };
    expect(buildReport([], context).context).toEqual(context);
  });

  it("splits calls into turns at each user message", () => {
    const r = buildReport(
      [
        user("read the README"),
        assistant(0.1, "m1", {}, "p", ["read", "read"]),
        toolResult(0.05),
        assistant(0.2, "m1", {}, "p", ["bash"]),
        user([{ type: "text", text: "now\n  fix   it" }, { type: "image" }]),
        assistant(0.5, "m2"),
      ],
      undefined,
    );
    expect(r.turnCount).toBe(2);
    expect(r.turns.map((t) => [t.n, t.prompt, t.calls])).toEqual([
      [1, "read the README", 2],
      [2, "now fix it", 1],
    ]);
    expect(r.turns[0]?.cost).toBeCloseTo(0.35);
    expect(r.turns[0]?.callCosts).toEqual([0.1, 0.2]);
    expect(r.turns[0]?.tools).toEqual([
      { name: "read", count: 2 },
      { name: "bash", count: 1 },
    ]);
    expect(r.turns[1]?.models).toEqual(["p/m2"]);
    expect(r.series.map((p) => p.turn)).toEqual([1, 1, 2]);
    expect(r.lastTurnCost).toBeCloseTo(0.5);
  });

  it("keeps usage before the first prompt in turn 0", () => {
    const r = buildReport([usageEntry(1), user(), assistant(2)], undefined);
    expect(r.turns.map((t) => t.n)).toEqual([0, 1]);
    expect(r.turnCount).toBe(1);
  });

  it("keeps a prompt with no calls as an empty turn", () => {
    const r = buildReport([user("hi"), user("again"), assistant(1)], undefined);
    expect(r.turns.map((t) => t.calls)).toEqual([0, 1]);
  });

  it("caps the turns at the last TURNS_MAX and counts them all", () => {
    const entries: EntryLike[] = [];
    for (let i = 0; i < TURNS_MAX + 5; i++) entries.push(user(`p${i}`), assistant(1));
    const r = buildReport(entries, undefined);
    expect(r.turns).toHaveLength(TURNS_MAX);
    expect(r.turnCount).toBe(TURNS_MAX + 5);
    expect(r.turns.at(-1)?.n).toBe(TURNS_MAX + 5);
  });

  it("totals spend per local day with its top models", () => {
    const a = assistant(1, "m1");
    const b = assistant(2, "m2");
    b.timestamp = new Date(Date.parse(a.timestamp) + 86_400_000).toISOString();
    const r = buildReport([user(), a, b], undefined);
    expect(r.days.map((d) => [d.day, d.cost, d.calls])).toEqual([
      [dayKey(Date.parse(a.timestamp)), 1, 1],
      [dayKey(Date.parse(b.timestamp)), 2, 1],
    ]);
    expect(r.days[1]?.models).toEqual([{ key: "p/m2", cost: 2, calls: 1, tokens: 150 }]);
  });

  it("starts as a v2 report that is not running and has no budget", () => {
    expect(buildReport([], undefined)).toMatchObject({
      version: 2,
      running: false,
      budget: null,
      stoppedAt: null,
      estimated: false,
      turns: [],
      days: [],
      utcDays: [],
      hours: [],
    });
  });

  it("is an estimate when a counted usage with a cost is a list-price estimate, and never from pi's entries", () => {
    const guess = (total: number) => {
      const entry = assistant(total);
      return { ...entry, message: { ...entry.message, usage: { ...entry.message.usage, estimated: true } } };
    };
    expect(buildReport([user(), assistant(1), guess(0.5)], undefined).estimated).toBe(true);
    expect(buildReport([user(), assistant(1), guess(0)], undefined).estimated).toBe(false);
    expect(buildReport([user(), assistant(1), toolResult(2), usageEntry(3), compaction(4)], undefined).estimated).toBe(false);
    expect(JSON.stringify(slimEntry(guess(0.5)))).not.toContain("estimated");
  });

  it("counts only entries at or after countFrom, so a fork skips its parent's copied calls", () => {
    const copied = [at("2026-10-18T10:00:00.000Z")(user("parent")), at("2026-10-18T10:01:00.000Z")(assistant(5))];
    const own = [at("2026-10-18T12:00:00.000Z")(user("side chat")), at("2026-10-18T12:01:00.000Z")(assistant(1.5))];
    const r = buildReport([...copied, ...own], null, { countFrom: Date.parse("2026-10-18T12:00:00.000Z") });
    expect(r.cost.total).toBeCloseTo(1.5);
    expect(r).toMatchObject({ calls: 1, turnCount: 1, startedAt: Date.parse("2026-10-18T12:00:00.000Z") });
    expect(r.turns.map((t) => [t.n, t.prompt])).toEqual([[1, "side chat"]]);
    expect(buildReport([...copied, ...own], null, { countFrom: null }).cost.total).toBeCloseTo(6.5);
  });

  it("totals spend per UTC day beside the local days, and per the given zone's days", () => {
    const late = at("2026-10-18T23:30:00.000Z")(assistant(1));
    const early = at("2026-10-19T00:30:00.000Z")(assistant(2));
    const r = buildReport([user(), late, early], null, { timeZone: "America/Toronto" });
    expect(r.days.map((d) => [d.day, d.cost, d.calls])).toEqual([["2026-10-18", 3, 2]]);
    expect(r.utcDays.map((d) => [d.day, d.cost, d.calls])).toEqual([
      ["2026-10-18", 1, 1],
      ["2026-10-19", 2, 1],
    ]);
    expect(r.utcDays[1]?.models).toEqual([{ key: "p/m1", cost: 2, calls: 1, tokens: 150 }]);
  });
});

describe("buildReport usage detail", () => {
  const call = (ms: number | undefined, stopReason = "stop") => assistant(1, "m1", {}, "p", [], ms === undefined ? { stopReason } : { durationMs: ms, stopReason });

  it("counts prompts on their local and UTC days, and keeps a day that had only a prompt", () => {
    const r = buildReport(
      [
        at("2026-10-17T12:00:00.000Z")(user()),
        at("2026-10-18T12:00:00.000Z")(user()),
        at("2026-10-18T12:01:00.000Z")(assistant(1)),
        at("2026-10-18T12:02:00.000Z")(user()),
      ],
      null,
      { timeZone: "UTC" },
    );
    expect(r.days.map((d) => [d.day, d.prompts, d.cost, d.calls])).toEqual([
      ["2026-10-17", 1, 0, 0],
      ["2026-10-18", 2, 1, 1],
    ]);
    expect(r.utcDays.map((d) => [d.day, d.prompts])).toEqual([
      ["2026-10-17", 1],
      ["2026-10-18", 2],
    ]);
    expect(r.days[0]).toMatchObject({ models: [], failed: 0, aborted: 0, callTime: new Array(CALL_TIME_BUCKETS).fill(0) });
  });

  it("splits each day's tokens, with reasoning, and its cost by kind", () => {
    const a = assistant(1, "m1", { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
    const reasoned = { ...a, message: { ...a.message, usage: { ...a.message.usage, reasoning: 5 } } };
    const r = buildReport([user(), reasoned, toolResult(2)], null);
    expect(r.days[0]?.tokens).toEqual({ input: 110, output: 70, cacheRead: 30, cacheWrite: 40, reasoning: 5 });
    expect(r.days[0]?.costs).toEqual({ input: 1.5, output: 0.75, cacheRead: 0.375, cacheWrite: 0.375 });
    expect(r.utcDays[0]?.tokens).toEqual(r.days[0]?.tokens);
    expect(r.byModel.find((m) => m.key === "p/m1")).toMatchObject({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, tokens: 100 });
  });

  it("puts call times in doubling buckets from one second", () => {
    expect([0, 999, 1000, 1999, 2000, 127_999, 128_000, 200_000].map(callTimeBucket)).toEqual([0, 0, 1, 1, 2, 7, 8, 8]);
    expect(CALL_TIME_BUCKETS).toBe(9);
    const r = buildReport([user(), call(999), call(1000), call(200_000)], null);
    expect(r.days[0]?.callTime).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("leaves a call without a usable duration untimed and never failed", () => {
    const r = buildReport([user(), call(undefined, "error"), call(-5, "error"), call(Number.POSITIVE_INFINITY, "aborted")], null);
    expect(r.days[0]).toMatchObject({ calls: 3, failed: 0, aborted: 0, callTime: new Array(CALL_TIME_BUCKETS).fill(0) });
    expect(r.byModel[0]).toMatchObject({ calls: 3, timed: 0, ms: 0, timedOutput: 0, failed: 0 });
  });

  it("counts the output of timed calls apart, so an untimed call does not skew the rate", () => {
    const timed = assistant(1, "m1", { output: 600 }, "p", [], { durationMs: 3000 });
    const untimed = assistant(1, "m1", { output: 900 });
    const r = buildReport([user(), timed, untimed, timed, user(), untimed], null);
    expect(r.byModel[0]).toMatchObject({ calls: 4, output: 3000, timed: 2, ms: 6000, timedOutput: 1200 });
    expect(outputPerSec(r.byModel[0]!)).toBe(200);
    expect(reportOutputPerSec(r)).toBe(200);
    expect(r.turns.map((t) => [t.ms, t.timedOutput])).toEqual([
      [6000, 1200],
      [0, 0],
    ]);
  });

  it("gives no rate without timed output", () => {
    expect(outputPerSec({ timedOutput: 0, ms: 4000 })).toBeNull();
    expect(outputPerSec({ timedOutput: 50, ms: 0 })).toBeNull();
  });

  it("counts timed calls that failed or were stopped, on the day and on the model", () => {
    const r = buildReport([user(), call(999), call(5000, "aborted"), call(200_000, "error"), call(0, "toolUse"), usageEntry(1)], null);
    expect(r.days[0]).toMatchObject({ calls: 4, failed: 1, aborted: 1, callTime: [2, 0, 0, 1, 0, 0, 0, 0, 1] });
    expect(r.byModel.find((m) => m.key === "p/m1")).toMatchObject({ calls: 4, timed: 4, ms: 999 + 5000 + 200_000, failed: 1 });
  });

  it("keeps a model with tokens and no cost in the day's models, and folds the tail into Other", () => {
    const free = buildReport([user(), assistant(0, "free", { input: 10, output: 0 }), assistant(1, "paid"), assistant(0, "none", { input: 0, output: 0 })], null);
    expect(free.days[0]?.models).toEqual([
      { key: "p/paid", cost: 1, calls: 1, tokens: 150 },
      { key: "p/free", cost: 0, calls: 1, tokens: 10 },
    ]);
    const many = buildReport([user(), ...[5, 4, 3, 2, 1].map((c) => assistant(c, `m${c}`))], null);
    expect(many.days[0]?.models.at(-1)).toEqual({ key: "Other", cost: 3, calls: 2, tokens: 300 });
  });

  it("sums Other's timing and kinds in byModel", () => {
    const entries: EntryLike[] = [user()];
    for (let i = 1; i <= 9; i++) entries.push(assistant(i, `m${i}`, {}, "p", [], { durationMs: 1000, stopReason: i === 1 ? "error" : "stop" }));
    const other = buildReport(entries, null).byModel.at(-1);
    expect(other).toMatchObject({ key: "Other", calls: 2, timed: 2, ms: 2000, timedOutput: 100, failed: 1, input: 200, output: 100, cacheRead: 0, cacheWrite: 0 });
  });

  it("totals each UTC clock hour, counting calls only from calls, and keeps the newest HOURS_MAX hours", () => {
    const noon = Date.parse("2026-10-18T12:00:00.000Z");
    const hour = Math.floor(noon / HOUR_MS);
    const r = buildReport(
      [user(), at("2026-10-18T11:59:00.000Z")(assistant(1)), at("2026-10-18T12:00:00.000Z")(assistant(2)), at("2026-10-18T12:30:00.000Z")(toolResult(0.5))],
      null,
    );
    expect(r.hours).toEqual([
      { hour: hour - 1, calls: 1, tokens: 150, cost: 1 },
      { hour, calls: 1, tokens: 300, cost: 2.5 },
    ]);
    const start = Date.UTC(2026, 8, 1);
    const many = Array.from({ length: HOURS_MAX + 5 }, (_, i) => at(new Date(start + i * HOUR_MS).toISOString())(assistant(1)));
    const hours = buildReport(many, null).hours;
    expect(hours).toHaveLength(HOURS_MAX);
    expect(hours[0]?.hour).toBe(Math.floor(start / HOUR_MS) + 5);
    expect(hours.at(-1)?.hour).toBe(Math.floor(start / HOUR_MS) + HOURS_MAX + 4);
  });
});

describe("dayKey", () => {
  it("gives the calendar day in the process zone, or in the zone named", () => {
    const ms = Date.parse("2026-10-18T23:30:00.000Z");
    const d = new Date(ms);
    expect(dayKey(ms)).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    expect(dayKey(ms, "UTC")).toBe("2026-10-18");
    expect(dayKey(ms, "Asia/Tokyo")).toBe("2026-10-19");
    expect(dayKey(ms, "America/Los_Angeles")).toBe("2026-10-18");
  });
});

describe("forkedAt", () => {
  it("is the header's time when the session was forked from another, else null", () => {
    const header = { type: "session", version: 3, id: "s", timestamp: "2026-10-18T12:00:00.000Z", cwd: "/tmp" };
    expect(forkedAt({ ...header, parentSession: "/tmp/parent.jsonl" })).toBe(Date.parse("2026-10-18T12:00:00.000Z"));
    expect(forkedAt(header)).toBeNull();
    expect(forkedAt({ ...header, parentSession: "" })).toBeNull();
    expect(forkedAt({ ...header, parentSession: "/p", timestamp: "not a date" })).toBeNull();
    expect(forkedAt(null)).toBeNull();
    expect(forkedAt(undefined)).toBeNull();
  });
});

describe("slimEntry", () => {
  const raw = readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
  const entries = raw.filter((e) => (e as EntryLike).type !== "session") as EntryLike[];

  it("builds the same report from slim entries as from a real session log", () => {
    const slim = raw.map(slimEntry).filter((e) => e !== null);
    expect(slim).toHaveLength(entries.length);
    expect(buildReport(slim, null)).toEqual(buildReport(entries, null));
    expect(buildReport(entries, null).calls).toBeGreaterThan(10);
  });

  it("keeps only what the report reads", () => {
    const long = `${"word ".repeat(60)}end`;
    const call = assistant(1, "m1", {}, "p", ["bash", "read"]);
    const slim = slimEntry({ ...call, id: "x", message: { ...call.message, api: "a", content: [...call.message.content, { type: "thinking", thinking: long }] } });
    expect(slim).toEqual({
      type: "message",
      timestamp: call.timestamp,
      message: {
        role: "assistant",
        provider: "p",
        model: "m1",
        usage: call.message.usage,
        content: [
          { type: "toolCall", name: "bash" },
          { type: "toolCall", name: "read" },
        ],
      },
    });
    const prompt = slimEntry(user([{ type: "text", text: long }, { type: "image", data: "…" }])) as unknown as { message: { content: string } };
    expect(prompt.message.content).toHaveLength(PROMPT_MAX);
    expect(slimEntry({ type: "model_change", id: "m", timestamp: "2026-10-18T12:00:00.000Z", modelId: "x" })).toEqual({
      type: "model_change",
      timestamp: "2026-10-18T12:00:00.000Z",
    });
    const branch = { type: "branch_summary", timestamp: "2026-10-18T12:00:00.000Z", summary: long, usage: compaction(1).usage };
    expect(slimEntry(branch)).toEqual({ type: "branch_summary", timestamp: branch.timestamp, usage: branch.usage });
    const spent = usageEntry(2, "q", "m2");
    expect(slimEntry({ ...spent, kind: "cache_warm" })).toEqual(spent);
  });

  it("keeps an assistant call's duration and stop reason, and no one else's", () => {
    const failed = assistant(1, "m1", {}, "p", [], { durationMs: 6758, stopReason: "error", errorMessage: "boom" });
    const slim = slimEntry(failed);
    expect(slim).toMatchObject({ message: { durationMs: 6758, stopReason: "error" } });
    expect(JSON.stringify(slim)).not.toContain("boom");
    const result = toolResult(1);
    expect(JSON.stringify(slimEntry({ ...result, message: { ...result.message, durationMs: 3 } }))).not.toContain("durationMs");
    expect(buildReport([user(), slim as EntryLike], null).days[0]?.failed).toBe(1);
  });

  it("turns a malformed usage field into 0 instead of NaN or text", () => {
    const call = assistant(1);
    const slim = slimEntry({
      ...call,
      message: { ...call.message, usage: { ...call.message.usage, input: "123", cost: { ...call.message.usage.cost, total: Number.NaN } } },
    });
    expect(slim).toMatchObject({ message: { usage: { input: 0, cost: { total: 0 } } } });
    const report = buildReport([slim as EntryLike], null);
    expect(report.tokens.input).toBe(0);
    expect(Number.isFinite(report.cost.total)).toBe(true);
  });

  it("is null for the session header and for anything that is not an entry", () => {
    expect(slimEntry({ type: "session", timestamp: "2026-10-18T12:00:00.000Z", parentSession: "/p" })).toBeNull();
    for (const value of [null, 1, "x", [], { type: "message" }, { timestamp: "t" }, { type: 1, timestamp: "t" }]) expect(slimEntry(value)).toBeNull();
  });
});

describe("agents", () => {
  it("folds rows past the cap into Other and keeps every row's cost", () => {
    const entries = Array.from({ length: AGENTS_MAX + 10 }, (_, i) => ({ ...assistant(0.1), agentId: `agent-${i}` }));
    const report = buildReport(entries, null);
    expect(report.agents?.coverage).toBe("partial");
    expect(report.agents?.rows).toHaveLength(AGENTS_MAX);
    expect(report.agents?.rows.at(-1)?.id).toBe(OTHER_KEY);
    const total = (report.agents?.rows ?? []).reduce((sum, row) => sum + row.cost.total, 0);
    expect(total).toBeCloseTo(0.1 * (AGENTS_MAX + 10), 9);
  });

  it("keeps one row per agent when there is room", () => {
    const report = buildReport([{ ...assistant(0.1), agentId: "a" }, { ...assistant(0.2), agentId: "b" }], null);
    expect(report.agents?.rows.map((row) => row.id).sort()).toEqual(["a", "b"]);
  });
});

describe("promptExcerpt", () => {
  it("joins text blocks, collapses whitespace and trims to 120 characters", () => {
    expect(promptExcerpt([{ type: "text", text: " a\n b " }, { type: "text", text: "c" }])).toBe("a b c");
    expect(promptExcerpt(undefined)).toBe("");
    const long = promptExcerpt("x".repeat(300));
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});
