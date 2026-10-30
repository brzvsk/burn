import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { UsageReport } from "../../src/report.js";
import type { ThreadDirectory } from "./directory.js";
import { createEventReader } from "./events.js";
import { type Harness, harnessOf } from "./harnesses.js";
import { HOST_BATCH, hostContract, hostSignals } from "./host/contract.js";
import { sessionStem } from "./host/pi-sessions.js";
import { logKey } from "./keys.js";
import { usageReportSchema } from "./schema.js";

const FACTS_TTL_MS = 5 * 60_000;
const REPORT_TTL_MS = 60_000;
/** How many threads are looked up at once: enough to use a fast bb, few enough not to swamp it. */
const FACTS_CONCURRENCY = 32;
/** How long an unreachable host is left alone, and how often its failure is logged. */
const HOST_RETRY_MS = 60_000;
const HOST_TIMEOUT_MS = 25_000;
const SESSIONS_MAX = 32;
// Room for every thread a month of use touches: a scan over more threads than a cache holds evicts each entry just before it is read again.
const CACHE_MAX = 5000;
/** A held report takes about 10 KB, so fewer are kept than the small per-thread facts. */
const REPORTS_MAX = 2000;

/**
 * A report Burn read itself: "log" from a pi thread's session logs, "events"
 * from the usage bb records for other harnesses. `at` is when it last changed.
 */
export interface LogReport {
  report: UsageReport;
  at: number;
  source: "log" | "events";
}

export interface ReportSource {
  /**
   * The latest report of each thread that has one: from its host or bb's events, else the last one kept.
   * With `deadlineMs` it answers by then with what it has; reads still under way finish later, and
   * `onChange` names the threads whose figures they changed.
   */
  reportsOf(threadIds: readonly string[], opts?: { deadlineMs?: number }): Promise<Map<string, LogReport>>;
  /** Whether bb says the thread is working right now. */
  running(threadId: string): Promise<boolean>;
  /** How many of these threads' figures are still being read right now, for a progress line. */
  reading(threadIds: readonly string[]): number;
  /** Reads these threads' details in the background, so a page over them does not start cold. */
  warm(threadIds: readonly string[]): Promise<void>;
  /** How Burn reads the thread, or null when bb could not say. */
  harnessOf(threadId: string): Promise<Harness | null>;
  forget(threadId: string): Promise<void>;
}

/** What bb says about a thread: its provider, the machine that keeps its pi logs (null for none, or not pi) and its pi sessions. */
interface Facts {
  since?: number;
  parentSessionIds?: string[];
  at: number;
  hostId: string | null;
  /** null when the lookup failed. */
  providerId: string | null;
  sessionIds: string[];
  /** The file names the host reports changes by. */
  stems: Set<string>;
}

const logSchema = z.object({ report: usageReportSchema, at: z.number() });

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function remember<V>(map: Map<string, V>, key: string, value: V, max = CACHE_MAX): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Whether `work` settles by `until`, a Date.now() time; at Infinity it waits as long as `work` takes. */
function settlesBy(work: Promise<unknown>, until: number): Promise<boolean> {
  if (until === Number.POSITIVE_INFINITY) return work.then(() => true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, until - Date.now()));
  });
  return Promise.race([work.then(() => true), late]).finally(() => clearTimeout(timer));
}

/** Runs `fn` over `items`, `limit` at a time, so a page over a thousand threads does not fire them all at once. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Every thread's report. A pi thread's is read by the Burn host entry from its
 * session logs on the machine that runs it, and kept until the host signals
 * that one of the thread's logs changed, or a minute passes. Any other thread's
 * comes from the usage bb records (events.ts). `onChange` names the threads to
 * look at again.
 */
export function createReportSource(
  bb: BbPluginApi,
  opts: { onChange(threadIds: string[]): void; now?: () => number; threads?: ThreadDirectory },
): ReportSource {
  const now = opts.now ?? Date.now;
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const events = createEventReader(bb, { onChange: opts.onChange, now });
  const facts = new Map<string, Facts>();
  const statuses = new Map<string, string>();
  // Thread events seen per thread, so a lookup that an event overtook does not undo it.
  const heard = new Map<string, number>();
  const reports = new Map<string, { got: LogReport | null; checkedAt: number }>();
  // Bumped by every change, so a read that raced the change is not kept as current.
  const versions = new Map<string, number>();
  const saved = new Map<string, number>();
  const failedAt = new Map<string, number>();
  // The host read under way per thread, which a second caller joins instead of asking the host again, and
  // when the caller that started it stopped waiting: a joiner waits no longer, since that caller's late read signals.
  const reading = new Map<string, { run: Promise<void>; until: number }>();

  /** What the thread row says, however Burn got it: one shared listing, or a call of its own. */
  interface Looked {
    since?: number;
    sourceThreadId?: string | null;
    status: string;
    providerId: string;
    environmentId: string | null;
    hostId: string | null;
    /** Whether `hostId` is already known, so the fallback path does not ask again. */
    hostKnown: boolean;
  }

  async function lookup(threadId: string): Promise<Looked | null> {
    if (opts.threads) {
      const row = await opts.threads.one(threadId);
      return row === null
        ? null
        : {
            status: row.status,
            providerId: row.providerId,
            environmentId: row.environmentId,
            hostId: row.hostId,
            hostKnown: true,
            sourceThreadId: row.sourceThreadId,
            since: row.sourceThreadId ? row.createdAt : undefined,
          };
    }
    const thread = await bb.sdk.threads.get({ threadId });
    return {
      status: thread.status,
      providerId: thread.providerId,
      environmentId: thread.environmentId,
      hostId: null,
      hostKnown: false,
      sourceThreadId: thread.sourceThreadId,
      since: thread.sourceThreadId ? thread.createdAt : undefined,
    };
  }

  async function lookUp(threadId: string): Promise<Facts> {
    const before = heard.get(threadId) ?? 0;
    const row = await lookup(threadId);
    if (row === null) {
      if ((heard.get(threadId) ?? 0) === before) remember(statuses, threadId, "deleted");
      return { at: now(), hostId: null, providerId: null, sessionIds: [], stems: new Set() };
    }
    if ((heard.get(threadId) ?? 0) === before) remember(statuses, threadId, row.status);
    const reader = harnessOf(row.providerId).reader;
    if ((reader !== "pi-log" && reader !== "opencode-db" && reader !== "claude-log") || row.environmentId === null) {
      return { at: now(), hostId: null, providerId: row.providerId, sessionIds: [], stems: new Set() };
    }
    const hostId = row.hostKnown ? row.hostId : (await bb.sdk.environments.get({ environmentId: row.environmentId })).hostId;
    if (hostId === null) return { at: now(), hostId: null, providerId: row.providerId, sessionIds: [], stems: new Set() };
    const rows = await bb.sdk.threads.events.list({ threadId, types: ["thread/identity"] });
    const identities = rows.flatMap((row) => {
      const id = (row.data as { providerThreadId?: unknown } | null)?.providerThreadId;
      return typeof id === "string" && id !== "" ? [id] : [];
    });
    // The thread id too, for a session named after the thread rather than an identity.
    const sessionIds = [...new Set([...identities, threadId])].slice(-SESSIONS_MAX);
    // Only pi's bridge names its session files after these ids.
    const stems = reader === "pi-log" ? new Set(sessionIds.map(sessionStem)) : new Set<string>();
    let parentSessionIds: string[] | undefined;
    if (reader === "claude-log" && row.sourceThreadId) {
      const parentRows = await bb.sdk.threads.events.list({ threadId: row.sourceThreadId, types: ["thread/identity"] });
      parentSessionIds = [
        ...new Set(
          parentRows.flatMap((r) => {
            const id = (r.data as { providerThreadId?: unknown }).providerThreadId;
            return typeof id === "string" ? [id] : [];
          }),
        ),
      ].slice(-32);
    }
    return { at: now(), hostId, providerId: row.providerId, sessionIds, stems, since: row.since, parentSessionIds };
  }

  /** The lookup under way per thread, so a caller joins it instead of asking bb again. */
  const looking = new Map<string, Promise<Facts>>();

  async function factsOf(threadId: string): Promise<Facts> {
    const held = facts.get(threadId);
    if (held && now() - held.at < FACTS_TTL_MS) return held;
    const under = looking.get(threadId);
    if (under) return under;
    const run = (async (): Promise<Facts> => {
      let found: Facts;
      try {
        found = await lookUp(threadId);
      } catch (err) {
        bb.log.warn(`looking up thread ${threadId} failed, so Burn reads no session log for it: ${message(err)}`);
        found = { at: now(), hostId: null, providerId: null, sessionIds: [], stems: new Set() };
      }
      remember(facts, threadId, found);
      return found;
    })();
    looking.set(threadId, run);
    try {
      return await run;
    } finally {
      if (looking.get(threadId) === run) looking.delete(threadId);
    }
  }

  function invalidate(threadId: string): void {
    reports.delete(threadId);
    reading.delete(threadId);
    remember(versions, threadId, (versions.get(threadId) ?? 0) + 1);
  }

  const fresh = (threadId: string): boolean => {
    const held = reports.get(threadId);
    return held !== undefined && now() - held.checkedAt < REPORT_TTL_MS;
  };
  const hostDown = (hostId: string): boolean => now() - (failedAt.get(hostId) ?? Number.NEGATIVE_INFINITY) < HOST_RETRY_MS;

  async function save(threadId: string, got: LogReport): Promise<void> {
    if (saved.get(threadId) === got.at) return;
    try {
      await bb.storage.kv.set(logKey(threadId), { report: got.report, at: got.at });
      remember(saved, threadId, got.at);
    } catch (err) {
      bb.log.warn(`saving the log report of ${threadId} failed: ${message(err)}`);
    }
  }

  async function lastKept(threadId: string): Promise<LogReport | null> {
    const raw = await bb.storage.kv.get<unknown>(logKey(threadId));
    if (raw === undefined) return null;
    const parsed = logSchema.safeParse(raw);
    if (parsed.success) return { ...parsed.data, source: "log" };
    await bb.storage.kv.delete(logKey(threadId));
    return null;
  }

  async function ask(
    hostId: string,
    harness: "pi" | "opencode" | "claude",
    threadIds: string[],
    answers: Map<string, LogReport | null>,
  ): Promise<void> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (let start = 0; start < threadIds.length; start += HOST_BATCH) {
      const batch = threadIds.slice(start, start + HOST_BATCH);
      const seen = new Map(batch.map((id) => [id, versions.get(id) ?? 0]));
      const checkedAt = now();
      let answer: Awaited<ReturnType<typeof host.call<"reports">>>;
      try {
        answer = await host.call(
          "reports",
          {
            harness,
            timeZone,
            threads: batch.map((threadId) => ({
              threadId,
              sessionIds: facts.get(threadId)?.sessionIds ?? [threadId],
              ...(harness === "claude" && facts.get(threadId)?.since !== undefined ? { since: facts.get(threadId)!.since! } : {}),
              ...(harness === "claude" && facts.get(threadId)?.parentSessionIds !== undefined ? { parentSessionIds: facts.get(threadId)!.parentSessionIds! } : {}),
            })),
          },
          { hostId, timeoutMs: HOST_TIMEOUT_MS },
        );
      } catch (err) {
        failedAt.set(hostId, now());
        const what = harness === "claude" ? "Claude transcripts" : harness === "pi" ? "pi session logs" : "opencode's database";
        bb.log.warn(`reading ${what} on ${hostId} failed, so Burn shows the last figures it read there: ${message(err)}`);
        return;
      }
      failedAt.delete(hostId);
      for (const { threadId, report, at } of answer.reports) {
        let got: LogReport | null = report !== null && at !== null ? { report, at, source: "log" } : null;
        if (harness === "claude" && got?.report.coverage === "partial") {
          const kept = await lastKept(threadId);
          if (kept && kept.report.coverage !== "partial") {
            got = {
              ...kept,
              report: {
                ...kept.report,
                coverage: "partial",
                coverageNote: "Partial latest Claude history: showing the last saved transcript report.",
              },
            };
          }
        }
        answers.set(threadId, got);
        if ((versions.get(threadId) ?? 0) === seen.get(threadId)) remember(reports, threadId, { got, checkedAt }, REPORTS_MAX);
        if (got) await save(threadId, got);
      }
    }
  }

  host.experimental_onSignal("changed", ({ hostId, payload }) => {
    const changed = new Set(payload.sessionIds);
    const hit: string[] = [];
    for (const [threadId, f] of facts) {
      if (f.hostId === hostId && (payload.all || [...f.stems].some((stem) => changed.has(stem)))) hit.push(threadId);
    }
    for (const threadId of hit) invalidate(threadId);
    if (hit.length > 0) opts.onChange(hit);
  });

  host.experimental_onWorkerExit(({ hostId }) => {
    for (const [threadId, f] of facts) if (f.hostId === hostId) invalidate(threadId);
  });

  function hear(thread: { id: string; status: string }): void {
    remember(heard, thread.id, (heard.get(thread.id) ?? 0) + 1);
    remember(statuses, thread.id, thread.status);
  }

  /** bb stores a turn's usage just before the thread goes idle, so a status change reads the thread's events again. */
  function heardStatus(thread: { id: string; status: string; providerId: string }): void {
    hear(thread);
    const reader = harnessOf(thread.providerId).reader;
    if (reader === "events") events.invalidate(thread.id);
    // opencode records a call when it finishes, and Burn has no watch on its database.
    else if (reader === "opencode-db" || reader === "claude-log") {
      invalidate(thread.id);
      if (reader === "claude-log") events.invalidate(thread.id);
    }
    opts.onChange([thread.id]);
  }

  bb.events.on("thread.active", ({ thread }) => {
    // A thread that just started may have a session bb had not named yet.
    if (harnessOf(thread.providerId).reader !== "events") facts.delete(thread.id);
    heardStatus(thread);
  });
  for (const name of ["thread.idle", "thread.failed"] as const) bb.events.on(name, ({ thread }) => heardStatus(thread));
  // Burn has no watch on opencode's database; bb records the thread's events, at most once a second, while opencode works.
  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (!["opencode-db", "claude-log"].includes(harnessOf(thread.providerId).reader)) return;
    invalidate(thread.id);
    opts.onChange([thread.id]);
  });

  return {
    async reportsOf(threadIds, { deadlineMs } = {}) {
      const ids = [...new Set(threadIds)];
      const answers = new Map<string, LogReport | null>();
      const fromEvents = new Map<string, LogReport | null>();
      const own: Promise<void>[] = [];
      const joined = new Map<Promise<void>, number>();
      const until = deadlineMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + deadlineMs;
      // Facts are looked up a few threads at a time and only until the deadline, so a page over a
      // thousand threads answers with what is ready rather than waiting for every thread.
      const stale = ids.filter((threadId) => !fresh(threadId));
      const looked: Array<{ threadId: string } & Facts> = [];
      const factsRun = eachLimit(stale, FACTS_CONCURRENCY, async (threadId) => {
        looked.push({ threadId, ...(await factsOf(threadId)) });
      });
      const factsInTime = await settlesBy(factsRun, until);
      // Nothing below awaits until every read is registered, so two callers never ask a host for the same thread.
      const wanted = new Map<string, { hostId: string; harness: "pi" | "opencode" | "claude"; threadIds: string[] }>();
      for (const { threadId, hostId, providerId } of looked) {
        if (fresh(threadId)) continue;
        const reader = providerId === null ? null : harnessOf(providerId).reader;
        if (providerId !== null && reader === "events") {
          own.push(events.reportOf(threadId, providerId).then((got) => void fromEvents.set(threadId, got && { ...got, source: "events" })));
          continue;
        }
        const under = reading.get(threadId);
        if (under) {
          joined.set(under.run, Math.min(until, under.until));
          continue;
        }
        if (hostId === null || hostDown(hostId)) continue;
        const harness = reader === "claude-log" ? "claude" : reader === "opencode-db" ? "opencode" : "pi";
        const key = `${hostId}:${harness}`;
        const group = wanted.get(key) ?? { hostId, harness, threadIds: [] };
        group.threadIds.push(threadId);
        wanted.set(key, group);
      }
      // Snapshot before any await below: only the threads already in `wanted` are accounted for here,
      // so the rest are exactly the ones a late fact lookup still has to signal.
      const ready = new Set(looked.map((l) => l.threadId));
      for (const { hostId, harness, threadIds: asked } of wanted.values()) {
        const run = ask(hostId, harness, asked, answers);
        for (const threadId of asked) reading.set(threadId, { run, until });
        const done = () => {
          for (const threadId of asked) if (reading.get(threadId)?.run === run) reading.delete(threadId);
        };
        run.then(done, done);
        own.push(run);
      }
      const waits = [settlesBy(Promise.all(own), until), ...[...joined].map(([run, by]) => settlesBy(run, by))];
      const inTime = (await Promise.all(waits)).every(Boolean);

      /** What the reads said, once done; undefined for a thread they left as it was. */
      const latest = (threadId: string): LogReport | null | undefined => {
        if (fromEvents.has(threadId)) return fromEvents.get(threadId) ?? null;
        if (answers.has(threadId)) return answers.get(threadId) ?? null;
        return fresh(threadId) ? (reports.get(threadId)?.got ?? null) : undefined;
      };
      const out = new Map<string, LogReport>();
      await eachLimit(ids, FACTS_CONCURRENCY, async (threadId) => {
        const got = latest(threadId);
        if (fromEvents.has(threadId)) {
          if (got) out.set(threadId, got);
          return;
        }
        const best = got ?? (await lastKept(threadId));
        if (best) out.set(threadId, best);
        else if (facts.get(threadId)?.providerId === "claude-code") {
          const fallback = await events.reportOf(threadId, "claude-code");
          if (fallback)
            out.set(threadId, {
              ...fallback,
              source: "events",
              report: {
                ...fallback.report,
                coverage: "partial",
                coverageNote: "Limited coverage: saved history is unavailable; some subagent usage and earlier turns may be missing.",
              },
            });
        }
      });
      if (!factsInTime) {
        factsRun.then(
          () => {
            const late = stale.filter((threadId) => !ready.has(threadId));
            if (late.length > 0) opts.onChange(late);
          },
          (err: unknown) => bb.log.warn(`looking up the threads of ${ids.length} thread(s) failed: ${message(err)}`),
        );
      }
      if (!inTime) {
        Promise.all([...own, ...joined.keys()]).then(
          () => {
            const late = ids.filter((threadId) => {
              const got = latest(threadId);
              return got != null && got.at !== out.get(threadId)?.at;
            });
            if (late.length > 0) opts.onChange(late);
          },
          (err: unknown) => bb.log.warn(`reading the reports of ${ids.length} thread(s) failed: ${message(err)}`),
        );
      }
      return out;
    },
    async running(threadId) {
      // Reads only what is known. A lookup of its own would fire one per thread the moment
      // `resolveMany` runs, undoing the bound `reportsOf` puts on the same work; `reportsOf`
      // and `warm` populate the status, and a thread event keeps it current.
      return statuses.get(threadId) === "active";
    },
    reading(threadIds) {
      // Host reads only: each is followed by a signal when it settles, so the count cannot latch.
      // Facts lookups are not counted, since a background `warm` starts ones no answer will signal.
      let count = 0;
      for (const threadId of threadIds) if (reading.has(threadId)) count++;
      return count;
    },
    async warm(threadIds) {
      await eachLimit([...new Set(threadIds)], FACTS_CONCURRENCY, async (threadId) => {
        await factsOf(threadId);
      });
    },
    harnessOf: async (threadId) => {
      const { providerId } = await factsOf(threadId);
      return providerId === null ? null : harnessOf(providerId);
    },
    async forget(threadId) {
      for (const map of [facts, statuses, heard, reports, versions, saved, reading, looking]) map.delete(threadId);
      await events.forget(threadId);
    },
  };
}
