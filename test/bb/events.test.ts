import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventReader } from "../../extensions/bb/events.js";
import { type EventRow, USAGE_EVENTS } from "../../extensions/bb/ledger.js";
import type { PriceOverrides } from "../../src/prices.js";
import { CODEX_1, CODEX_1_2, CODEX_2, event, listEvents, requestEvent, usageEvent } from "./fixtures.js";

const T = "thr_aaaaaaaa";
const PI = "thr_pppppppp";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function setup(overrides?: () => PriceOverrides) {
  const rows: EventRow[] = [];
  let failing = false;
  let gate: Promise<void> | null = null;
  let now = 1_000_000;
  const { bb, harness } = createFakePluginHost({
    pluginId: "burn",
    sdk: {
      threads: {
        events: {
          list: async (args: Parameters<ReturnType<typeof listEvents>>[0]) => {
            if (failing) throw new Error("bb is restarting");
            if (gate) await gate;
            return listEvents(() => rows)(args);
          },
        },
      },
    },
  });
  disposers.push(() => harness.lifecycle.dispose());
  const changed: string[][] = [];
  const reader = () => createEventReader(bb, { onChange: (ids) => void changed.push(ids), now: () => now, ...(overrides ? { overrides } : {}) });
  const lists = () => harness.inspection.sdk.callsTo("threads.events.list").map(([args]) => args as Record<string, unknown>);
  const notice = (threadId: string, providerId: string) =>
    harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: threadId, providerId }), sequence: rows.length });
  const warnings = () => harness.inspection.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
  const fail = (on: boolean) => {
    failing = on;
  };
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
  return { bb, rows, reader, changed, lists, notice, warnings, fail, hold, tick: (ms: number) => (now += ms) };
}

describe("createEventReader", () => {
  it("reads a thread's usage events once, then only those after the last it saved", async () => {
    const s = setup();
    const reader = s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    const first = await reader.reportOf(T, "codex");
    expect(first?.report.cost.total).toBeCloseTo(0.053, 9);
    expect(first?.report.estimated).toBe(true);
    expect(first?.at).toBe(s.rows[1]?.createdAt);
    expect(s.lists()).toEqual([{ threadId: T, types: USAGE_EVENTS, order: "asc", limit: "100" }]);

    s.rows.push(usageEvent(T, CODEX_1_2, CODEX_2));
    expect((await reader.reportOf(T, "codex"))?.report.cost.total).toBeCloseTo(0.053, 9);
    reader.invalidate(T);
    expect((await reader.reportOf(T, "codex"))?.report.cost.total).toBeCloseTo(0.141, 9);
    expect(s.lists()[1]).toMatchObject({ afterSeq: String(s.rows[1]?.seq) });
    s.tick(60_000);
    await reader.reportOf(T, "codex");
    expect(s.lists()).toHaveLength(3);
    expect(s.lists()[2]).toMatchObject({ afterSeq: String(s.rows[2]?.seq) });
  });

  it("reads again after invalidateAll overtook a read in flight", async () => {
    const s = setup();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    const reader = s.reader();
    const release = s.hold();
    const run = reader.reportOf(T, "codex");
    await vi.waitFor(() => expect(s.lists()).toHaveLength(1));
    reader.invalidateAll();
    release();
    await run;
    await reader.reportOf(T, "codex");
    expect(s.lists()).toHaveLength(2);
  });

  it("prices tokens with the settings' price overrides", async () => {
    const s = setup(() => ({ "gpt-5.5": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }));
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    const got = await s.reader().reportOf(T, "codex");
    // CODEX_1 is 4,000 input, 6,000 cache reads and 1,000 output at $1 per million each.
    expect(got?.report.cost.total).toBeCloseTo(0.011, 9);
  });

  it("pages through more than a hundred events", async () => {
    const s = setup();
    for (let n = 0; n < 150; n++) s.rows.push(requestEvent(T, `prompt ${n}`, "gpt-5.5"));
    s.rows.push(usageEvent(T, CODEX_1));
    const got = await s.reader().reportOf(T, "codex");
    expect(got?.report.turnCount).toBe(150);
    expect(s.lists().map((args) => args.afterSeq)).toEqual([undefined, String(s.rows[99]?.seq)]);
  });

  it("gives a new reader the same figures from the database, without the events bb has since pruned", async () => {
    const s = setup();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1), usageEvent(T, CODEX_1_2, CODEX_2));
    const before = await s.reader().reportOf(T, "codex");
    s.rows.splice(1, 1);
    const after = await s.reader().reportOf(T, "codex");
    expect(after).toEqual(before);
    expect(s.lists()[1]).toMatchObject({ afterSeq: String(s.rows[1]?.seq) });
  });

  it("is null until the thread has used a model", async () => {
    const s = setup();
    const reader = s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"));
    expect(await reader.reportOf(T, "codex")).toBeNull();
    s.rows.push(usageEvent(T, CODEX_1));
    reader.invalidate(T);
    expect(await reader.reportOf(T, "codex")).not.toBeNull();
  });

  it("names a thread whose usage changed when bb says it has new events, but not for other events, and ignores pi threads", async () => {
    const s = setup();
    s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    await s.notice(T, "codex");
    expect(s.changed).toEqual([[T]]);
    s.rows.push(event(T, "item/agentMessage/delta", { delta: "streamed text" }));
    await s.notice(T, "codex");
    expect(s.changed).toEqual([[T]]);
    expect(s.lists()).toHaveLength(2);
    await s.notice(PI, "pi");
    expect(s.lists()).toHaveLength(2);
  });

  it("keeps the last report when a read fails, and logs the failure", async () => {
    const s = setup();
    const reader = s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    const got = await reader.reportOf(T, "codex");
    s.fail(true);
    reader.invalidate(T);
    expect(await reader.reportOf(T, "codex")).toEqual(got);
    const { errors } = await s.notice(T, "codex");
    expect(errors).toEqual([]);
    expect(s.warnings()).toHaveLength(2);
    expect(s.warnings()[0]).toContain("bb is restarting");
    s.fail(false);
    s.rows.push(usageEvent(T, CODEX_1_2, CODEX_2));
    expect((await reader.reportOf(T, "codex"))?.report.cost.total).toBeCloseTo(0.141, 9);
  });

  it("forgets a thread's usage in memory and in the database", async () => {
    const s = setup();
    const reader = s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    await reader.reportOf(T, "codex");
    await reader.forget(T);
    const db = s.bb.storage.database();
    expect(db.prepare("SELECT count(*) AS n FROM usage_records WHERE thread_id = ?").get(T)).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM usage_ledgers WHERE thread_id = ?").get(T)).toEqual({ n: 0 });
    s.rows.length = 0;
    expect(await reader.reportOf(T, "codex")).toBeNull();
    expect(s.lists().at(-1)?.afterSeq).toBeUndefined();
  });
});
