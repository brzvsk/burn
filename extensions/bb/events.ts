import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PriceOverrides } from "../../src/prices.js";
import { buildReport, type UsageReport } from "../../src/report.js";
import { harnessOf, harnessWithPrices } from "./harnesses.js";
import { addRows, type EventRow, type Ledger, type LedgerRecord, type LedgerState, ledgerEntries, USAGE_EVENTS } from "./ledger.js";

/** bb's largest page of thread events. */
const PAGE = 100;
const REPORT_TTL_MS = 60_000;
const CACHE_MAX = 1000;

// Append-only: bb.storage.migrate rejects an edited or reordered statement.
const MIGRATIONS = [
  "CREATE TABLE usage_ledgers (thread_id TEXT PRIMARY KEY, state TEXT NOT NULL)",
  "CREATE TABLE usage_records (thread_id TEXT NOT NULL, n INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY (thread_id, n))",
];

export interface EventReader {
  /** The thread's report from the usage bb recorded; null until it has used a model. `at` is when it last changed. */
  reportOf(threadId: string, providerId: string): Promise<{ report: UsageReport; at: number } | null>;
  /** Read the thread again the next time it is asked for. */
  invalidate(threadId: string): void;
  /** Rebuild every held report, as after a price change. */
  invalidateAll(): void;
  forget(threadId: string): Promise<void>;
}

interface Held {
  ledger: Ledger;
  report: UsageReport | null;
  checkedAt: number;
  dirty: boolean;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function reportFrom(ledger: Ledger, providerId: string, overrides: PriceOverrides): UsageReport | null {
  if (!ledger.records.some((r) => r.kind !== "prompt")) return null;
  return buildReport(ledgerEntries(ledger, providerId, harnessWithPrices(providerId, overrides)), null);
}

/**
 * Every thread that pi does not run, read from the usage events its provider
 * bridge sends bb. bb deletes older usage events, so Burn keeps what it read in
 * the plugin's database and reads only newer events after that. bb says within
 * a second when a thread has new events; `onChange` names the threads whose
 * figures changed.
 */
export function createEventReader(
  bb: BbPluginApi,
  opts: { onChange(threadIds: string[]): void; now?: () => number; overrides?: () => PriceOverrides },
): EventReader {
  const now = opts.now ?? Date.now;
  const held = new Map<string, Held>();
  const chains = new Map<string, Promise<unknown>>();
  let migrated = false;
  // Bumped by invalidateAll, so a read that started before a price change does not cache its old-price figures.
  let generation = 0;

  function db() {
    const handle = bb.storage.database();
    if (!migrated) {
      bb.storage.migrate(handle, MIGRATIONS);
      migrated = true;
    }
    return handle;
  }

  function load(threadId: string, providerId: string, overrides: PriceOverrides): Held {
    const handle = db();
    const row = handle.prepare("SELECT state FROM usage_ledgers WHERE thread_id = ?").get(threadId) as { state: string } | undefined;
    const records = (handle.prepare("SELECT record FROM usage_records WHERE thread_id = ? ORDER BY n").all(threadId) as { record: string }[]).map(
      (r) => JSON.parse(r.record) as LedgerRecord,
    );
    const state: LedgerState = row ? (JSON.parse(row.state) as LedgerState) : { afterSeq: null, at: null, model: null, sessions: {} };
    const ledger = { state, records };
    return { ledger, report: reportFrom(ledger, providerId, overrides), checkedAt: Number.NEGATIVE_INFINITY, dirty: true };
  }

  function save(threadId: string, ledger: Ledger, from: number): void {
    const handle = db();
    const insert = handle.prepare("INSERT INTO usage_records (thread_id, n, record) VALUES (?, ?, ?)");
    const upsert = handle.prepare("INSERT INTO usage_ledgers (thread_id, state) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET state = excluded.state");
    handle.transaction(() => {
      for (let n = from; n < ledger.records.length; n++) insert.run(threadId, n, JSON.stringify(ledger.records[n]));
      upsert.run(threadId, JSON.stringify(ledger.state));
    })();
  }

  async function newRows(threadId: string, afterSeq: number | null): Promise<EventRow[]> {
    const rows: EventRow[] = [];
    let after = afterSeq;
    for (;;) {
      const page = await bb.sdk.threads.events.list({
        threadId,
        types: USAGE_EVENTS,
        order: "asc",
        limit: String(PAGE),
        ...(after !== null ? { afterSeq: String(after) } : {}),
      });
      rows.push(...page);
      const last = page.at(-1);
      if (page.length < PAGE || last === undefined) return rows;
      after = last.seq;
    }
  }

  async function readNow(threadId: string, providerId: string, overrides: PriceOverrides): Promise<{ got: Held; changed: boolean }> {
    const startedAt = generation;
    const got = held.get(threadId) ?? load(threadId, providerId, overrides);
    const rows = await newRows(threadId, got.ledger.state.afterSeq);
    const from = got.ledger.records.length;
    const added = addRows(got.ledger, rows, harnessOf(providerId));
    if (rows.length > 0) {
      try {
        save(threadId, got.ledger, from);
      } catch (err) {
        // The ledger in memory is now ahead of the database; reload it rather than save records out of order.
        held.delete(threadId);
        throw err;
      }
    }
    if (added !== null) got.report = reportFrom(got.ledger, providerId, overrides);
    got.checkedAt = now();
    got.dirty = false;
    // A price change during this read means its figures are stale; leave the cache empty for the next read to rebuild.
    if (generation === startedAt) remember(held, threadId, got);
    else got.dirty = true;
    return { got, changed: added !== null };
  }

  /** Reads of one thread run one at a time, so none folds the same events twice. */
  function read(threadId: string, providerId: string, overrides: PriceOverrides): Promise<{ got: Held; changed: boolean }> {
    const run = (chains.get(threadId) ?? Promise.resolve()).then(() => readNow(threadId, providerId, overrides));
    const tail = run.catch(() => undefined);
    chains.set(threadId, tail);
    void tail.then(() => {
      if (chains.get(threadId) === tail) chains.delete(threadId);
    });
    return run;
  }

  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (harnessOf(thread.providerId).reader !== "events") return;
    try {
      const { changed } = await read(thread.id, thread.providerId, opts.overrides?.() ?? {});
      if (changed) opts.onChange([thread.id]);
    } catch (err) {
      bb.log.warn(`reading the usage bb recorded for ${thread.id} failed: ${message(err)}`);
    }
  });

  return {
    async reportOf(threadId, providerId) {
      const overrides = opts.overrides?.() ?? {};
      let got = held.get(threadId);
      if (got === undefined || got.dirty || now() - got.checkedAt >= REPORT_TTL_MS) {
        try {
          got = (await read(threadId, providerId, overrides)).got;
        } catch (err) {
          bb.log.warn(`reading the usage bb recorded for ${threadId} failed, so Burn shows the last figures it read: ${message(err)}`);
          got = held.get(threadId);
        }
      }
      if (!got?.report) return null;
      return { report: got.report, at: got.ledger.state.at ?? got.report.updatedAt };
    },
    invalidate(threadId) {
      const got = held.get(threadId);
      if (got) got.dirty = true;
    },
    invalidateAll() {
      generation++;
      held.clear();
    },
    async forget(threadId) {
      held.delete(threadId);
      const handle = db();
      handle.transaction(() => {
        handle.prepare("DELETE FROM usage_records WHERE thread_id = ?").run(threadId);
        handle.prepare("DELETE FROM usage_ledgers WHERE thread_id = ?").run(threadId);
      })();
    },
  };
}
