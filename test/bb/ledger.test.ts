import { describe, expect, it } from "vitest";
import { harnessOf } from "../../extensions/bb/harnesses.js";
import { addRows, type EventRow, ledgerEntries, newLedger, splitTokens, type Totals } from "../../extensions/bb/ledger.js";
import { isTokenOnly } from "../../src/format.js";
import { ANTHROPIC_PRICES, OPENAI_CODEX_PRICES } from "../../src/prices.js";
import { buildReport } from "../../src/report.js";
import { CODEX_1, CODEX_1_2, CODEX_2, costEvent, event, requestEvent, totals, usageEvent } from "./fixtures.js";

const T = "thr_aaaaaaaa";
const request = (text: string, model: string, opts: Parameters<typeof requestEvent>[3] = {}) => requestEvent(T, text, model, opts);
const usage = (total: Totals, last: Totals = total, session = "s1") => usageEvent(T, total, last, session);
const cost = (amount: number, currency = "USD", session = "s1") => costEvent(T, amount, currency, session);

/** The report a ledger fed `rows` gives, read in one go or in the batches given. */
function reportOf(providerId: string, ...batches: EventRow[][]) {
  const harness = harnessOf(providerId);
  const ledger = newLedger();
  for (const batch of batches) addRows(ledger, batch, harness);
  return buildReport(ledgerEntries(ledger, providerId, harness), null);
}

describe("harnessOf", () => {
  it("reads pi from its logs and every other harness from bb's events, with its prices and conventions", () => {
    expect(harnessOf("pi")).toEqual({ reader: "pi-log", prices: null, cacheInInput: false, perCall: true });
    expect(harnessOf("codex")).toEqual({ reader: "events", prices: OPENAI_CODEX_PRICES, cacheInInput: true, perCall: true, separateChildCounters: true });
    expect(harnessOf("claude-code")).toEqual({ reader: "claude-log", prices: ANTHROPIC_PRICES, cacheInInput: false, perCall: false });
    expect(harnessOf("acp-cursor")).toEqual({ reader: "events", prices: null, cacheInInput: null, perCall: false });
    expect(harnessOf("constructor")).toEqual(harnessOf("acp-cursor"));
  });
});

describe("splitTokens", () => {
  it("takes cache reads and writes out of input when the harness counts them inside it", () => {
    const t = totals({ inputTokens: 10_000, cachedInputTokens: 7000, cacheWriteInputTokens: 1000, outputTokens: 500, reasoningOutputTokens: 100, totalTokens: 10_500 });
    expect(splitTokens(t, true)).toEqual({ input: 3000, cacheRead: 6000, cacheWrite: 1000, output: 500, reasoning: 100 });
    expect(splitTokens({ ...t, cacheReadInputTokens: 5000 }, true)).toEqual({ input: 4000, cacheRead: 5000, cacheWrite: 1000, output: 500, reasoning: 100 });
    expect(splitTokens(t, false)).toEqual({ input: 10_000, cacheRead: 6000, cacheWrite: 1000, output: 500, reasoning: 100 });
  });

  it("guesses from the totals for a harness of unknown convention", () => {
    const inside = totals({ inputTokens: 10_000, cachedInputTokens: 6000, outputTokens: 1000, totalTokens: 11_000 });
    const apart = totals({ inputTokens: 4000, cachedInputTokens: 6000, outputTokens: 1000, totalTokens: 11_000 });
    expect(splitTokens(inside, null)).toMatchObject({ input: 4000, cacheRead: 6000 });
    expect(splitTokens(apart, null)).toMatchObject({ input: 4000, cacheRead: 6000 });
  });
});

describe("a Codex ledger", () => {
  it("prices each response as one call from pi's OpenAI Codex prices", () => {
    const r = reportOf("codex", [request("fix the parser", "gpt-5.5"), usage(CODEX_1), usage(CODEX_1_2, CODEX_2)]);
    // 4k input × $5 + 1k output × $30 + 6k cache read × $0.50, then 4k × $5 + 2k × $30 + 16k × $0.50, per million.
    expect(r.series.map((p) => p.cost)).toEqual([expect.closeTo(0.053, 9), expect.closeTo(0.088, 9)]);
    expect(r.cost.total).toBeCloseTo(0.141, 9);
    expect(r).toMatchObject({ calls: 2, turnCount: 1, estimated: true });
    expect(r.tokens).toEqual({ input: 8000, output: 3000, cacheRead: 22_000, cacheWrite: 0, reasoning: 400 });
    expect(r.byModel.map((m) => m.key)).toEqual(["codex/gpt-5.5"]);
    expect(r.turns[0]?.prompt).toBe("fix the parser");
  });

  it("adds nothing for a repeated total", () => {
    const harness = harnessOf("codex");
    const ledger = newLedger();
    expect(addRows(ledger, [request("go", "gpt-5.5"), usage(CODEX_1)], harness)).toHaveLength(2);
    expect(addRows(ledger, [usage(CODEX_1)], harness)).toBeNull();
    expect(buildReport(ledgerEntries(ledger, "codex", harness), null).cost.total).toBeCloseTo(0.053, 9);
  });

  it("starts again from a lower total, and from a total equal to the last call after a larger one", () => {
    const lower = totals({ inputTokens: 5000, outputTokens: 500, totalTokens: 5500 });
    const fresh = totals({ inputTokens: 12_000, outputTokens: 1000, totalTokens: 13_000 });
    const r = reportOf("codex", [request("go", "gpt-5.5"), usage(CODEX_1_2, CODEX_2), usage(lower), usage(fresh)]);
    // The pruned first sighting counts as one entry; each restart adds its whole total.
    expect(r.tokens.input).toBe(8000 + 5000 + 12_000);
    expect(r.series.map((p) => p.cost)).toEqual([expect.closeTo(0.141, 9), expect.closeTo(0.04, 9), expect.closeTo(0.09, 9)]);
  });

  it("uses a price tier for one call above its threshold, but not for a pruned gap spanning calls", () => {
    const big = totals({ inputTokens: 300_000, outputTokens: 1000, totalTokens: 301_000 });
    const half = totals({ inputTokens: 150_000, outputTokens: 500, totalTokens: 150_500 });
    // 300k × $10 + 1k × $45 per million, above 272k input.
    expect(reportOf("codex", [request("go", "gpt-5.5"), usage(big)]).cost.total).toBeCloseTo(3.045, 9);
    // 300k × $5 + 1k × $30: two calls of 150k each.
    expect(reportOf("codex", [request("go", "gpt-5.5"), usage(big, half)]).cost.total).toBeCloseTo(1.53, 9);
  });
});

describe("a Claude Code ledger", () => {
  it("prices per-turn totals with cache apart from input, and never uses a tier", () => {
    const turn1 = totals({ inputTokens: 100, cachedInputTokens: 50_000, cacheReadInputTokens: 40_000, cacheWriteInputTokens: 10_000, outputTokens: 1000, totalTokens: 51_100 });
    const turn2 = totals({ inputTokens: 200, cachedInputTokens: 60_000, cacheReadInputTokens: 55_000, cacheWriteInputTokens: 5000, outputTokens: 2000, totalTokens: 62_200 });
    const both = totals({ inputTokens: 300, cachedInputTokens: 110_000, cacheReadInputTokens: 95_000, cacheWriteInputTokens: 15_000, outputTokens: 3000, totalTokens: 113_300 });
    const r = reportOf("claude-code", [request("one", "claude-opus-5-5"), usage(turn1), request("two", "claude-opus-5-5"), usage(both, turn2)]);
    // 100 × $4 + 1k × $20 + 40k × $0.20 + 10k × $5, then 200 × $4 + 2k × $20 + 55k × $0.20 + 5k × $5, per million.
    expect(r.turns.map((t) => t.cost)).toEqual([expect.closeTo(0.0784, 9), expect.closeTo(0.0768, 9)]);
    expect(r.tokens).toEqual({ input: 300, output: 3000, cacheRead: 95_000, cacheWrite: 15_000, reasoning: 0 });
    expect(r.estimated).toBe(true);

    const large = totals({ inputTokens: 50, cachedInputTokens: 120_000, cacheReadInputTokens: 100_000, cacheWriteInputTokens: 20_000, outputTokens: 2000, totalTokens: 122_050 });
    // haiku-5-5's base rates, though 120k input is above its 100k tier.
    expect(reportOf("claude-code", [request("big", "claude-haiku-5-5"), usage(large)]).cost.total).toBeCloseTo(0.004505, 9);
  });
});

describe("a session that records its cost", () => {
  const tokens = totals({ inputTokens: 1000, outputTokens: 100, totalTokens: 1100 });
  const more = totals({ inputTokens: 2000, outputTokens: 200, totalTokens: 2200 });

  it("counts the increases in its cumulative cost, starting again after a drop", () => {
    const r = reportOf("acp-cursor", [request("go", "auto"), usage(tokens), cost(0.1), usage(more, tokens), cost(0.25), cost(0.25), cost(0.05)]);
    expect(r.cost.total).toBeCloseTo(0.3, 9);
    expect(r).toMatchObject({ calls: 2, estimated: false });
    expect(r.tokens.input).toBe(2000);
  });

  it("is never priced at list price once it has any cost, zero or in another currency", () => {
    const zero = reportOf("codex", [request("go", "gpt-5.5"), usage(CODEX_1), cost(0)]);
    const euro = reportOf("codex", [request("go", "gpt-5.5"), usage(CODEX_1), cost(3, "EUR")]);
    for (const r of [zero, euro]) {
      expect(r.cost.total).toBe(0);
      expect(r.estimated).toBe(false);
      expect(isTokenOnly(r)).toBe(true);
    }
  });

  it("takes a cost that arrives after its tokens in place of their estimate, and says a newly costed session changed", () => {
    const harness = harnessOf("codex");
    const ledger = newLedger();
    addRows(ledger, [request("go", "gpt-5.5"), usage(CODEX_1)], harness);
    expect(buildReport(ledgerEntries(ledger, "codex", harness), null)).toMatchObject({ estimated: true });
    expect(addRows(ledger, [cost(0)], harness)).toEqual([]);
    expect(addRows(ledger, [cost(0.5)], harness)).toHaveLength(1);
    const r = buildReport(ledgerEntries(ledger, "codex", harness), null);
    expect(r.cost.total).toBeCloseTo(0.5, 9);
    expect(r.estimated).toBe(false);
  });

  it("keeps sessions apart", () => {
    const r = reportOf("codex", [request("go", "gpt-5.5"), usage(CODEX_1, CODEX_1, "a"), usage(CODEX_1, CODEX_1, "b"), cost(0.2, "USD", "b")]);
    expect(r.cost.total).toBeCloseTo(0.053 + 0.2, 9);
    expect(r.calls).toBe(2);
  });
});

describe("prompts and models", () => {
  it("opens a turn for a user's or another agent's request, but not for bb's own notices or a steer", () => {
    const r = reportOf("codex", [
      request("first", "gpt-5.5"),
      usage(CODEX_1),
      request("a child finished", "gpt-5.6-sol", { initiator: "system" }),
      request("also this", "gpt-5.6-sol", { kind: "steer" }),
      usage(CODEX_1_2, CODEX_2),
      request("from a parent", "gpt-5.6-sol", { initiator: "agent" }),
    ]);
    expect(r.turnCount).toBe(2);
    expect(r.turns.map((t) => [t.prompt, t.calls])).toEqual([
      ["first", 2],
      ["from a parent", 0],
    ]);
    expect(r.byModel.map((m) => m.key).sort()).toEqual(["codex/gpt-5.5", "codex/gpt-5.6-sol"]);
  });

  it("leaves text only the agent sees out of a prompt", () => {
    const asked = event(T, "client/turn/requested", {
      initiator: "user",
      target: { kind: "new-turn" },
      input: [
        { type: "text", text: "fix the chip" },
        { type: "text", text: "## This round", visibility: "agent-only" },
      ],
      execution: { model: "gpt-5.5" },
    });
    expect(reportOf("codex", [asked, usage(CODEX_1)]).turns[0]?.prompt).toBe("fix the chip");
  });

  it("gives tokens alone for a model without a price, or before any request names one", () => {
    const alias = reportOf("codex", [request("go", "shopify/auto-best"), usage(CODEX_1)]);
    const unnamed = reportOf("codex", [usage(CODEX_1)]);
    for (const r of [alias, unnamed]) {
      expect(isTokenOnly(r)).toBe(true);
      expect(r.estimated).toBe(false);
    }
    expect(alias.byModel[0]?.key).toBe("codex/shopify/auto-best");
    expect(unnamed.byModel[0]?.key).toBe("codex/unknown");
  });

  it("says nothing changed for rows a report does not read", () => {
    const harness = harnessOf("codex");
    const ledger = newLedger();
    const notice = request("bb notice", "gpt-5.5", { initiator: "system" });
    expect(addRows(ledger, [notice], harness)).toBeNull();
    expect(ledger.state.model).toBe("gpt-5.5");
    expect(ledger.state.afterSeq).toBe(notice.seq);
  });
});


it("keeps interleaved native child counters apart when BB reuses the parent provider id", () => {
  const scoped = (row: EventRow, turnId: string): EventRow => ({ ...row, scope: { kind: "turn", turnId } });
  const first = totals({ totalTokens: 100, inputTokens: 90, outputTokens: 10 });
  const child = totals({ totalTokens: 80, inputTokens: 75, outputTokens: 5 });
  const next = totals({ totalTokens: 220, inputTokens: 200, outputTokens: 20 });
  const last = totals({ totalTokens: 120, inputTokens: 110, outputTokens: 10 });
  const ledger = newLedger(); const harness = harnessOf("codex");
  addRows(ledger, [request("go", "gpt-5.5"), scoped(usage(first), "main"),
    scoped(event(T, "turn/started", { providerThreadId: "s1", parentToolCallId: "delegate" }), "child"), scoped(usage(child), "child")], harness);
  // A reload must retain the child-to-counter mapping.
  const restored = JSON.parse(JSON.stringify(ledger));
  addRows(restored, [scoped(usage(next, last), "main")], harness);
  const report = buildReport(ledgerEntries(restored, "codex", harness), null);
  expect(report.tokens.input).toBe(275); expect(report.tokens.output).toBe(25); expect(report.calls).toBe(3);
});
