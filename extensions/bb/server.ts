import type { BbPluginApi, PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { budgetState, EXPENSIVE_MIN_USD, EXPENSIVE_MULTIPLE, shouldStop } from "../../src/budget.js";
import { applyDiscounts, DISCOUNT_MAX, DISCOUNT_MIN, NO_DISCOUNTS, sameDiscounts } from "../../src/discounts.js";
import { formatUsd, usageLabel } from "../../src/format.js";
import { buildReport, type UsageReport } from "../../src/report.js";
import type { UsageReply } from "../../src/wire.js";
import { ALERT_CHANNEL } from "./alerts.js";
import { effectiveBudget, type OwnBudget, policyFor, positiveOrNull } from "./budgets.js";
import { BUDGET_MAX, type CostRow, type Family, rpcContract } from "./contract.js";
import { createThreadDirectory, type ThreadRow } from "./directory.js";
import { budgetKey, logKey, REPORT_PREFIX, reportKey, SETTINGS_COPY_KEY, stoppedKey } from "./keys.js";
import { alertEvents, alertFor } from "./notify.js";
import { discountsOf } from "./prefs.js";
import { type Stored, storedSchema, usageEnvelopeSchema } from "./schema.js";
import { createReportSource } from "./sources.js";
import { withOwnedThreads, spawnedTurnCost } from "./family.js";
import { checkDailyBudget, createSpendHandlers, type SpendDeps } from "./spend/server.js";

export { rpcContract } from "./contract.js";

// The report is stored as one plugin KV value, which bb caps at 256 KiB.
const REPORT_MAX_BYTES = 240 * 1024;
const MAX_THREADS = 500;
const TITLE_TTL_MS = 60_000;
const CHILDREN_MAX = 50;
const UNTITLED = "Untitled thread";
/** A pi report this recent means the thread's Burn pi extension is reporting. */
const PI_FRESH_MS = 2 * 60_000;
/** How long an answer waits for hosts; a slower host's figures arrive as a usage signal. */
const HOST_WAIT_MS = 1000;
/** The daily check reads every thread active since yesterday, so it runs at most this often. */
const DAILY_CHECK_MS = 30_000;
/** How long after the plugin loads the background warm-up starts, so it never slows startup. */
const WARM_DELAY_MS = 3_000;
/** The warm-up reads the details of threads touched in the Burn page's longest range, 30 days. */
const WARM_DAYS = 30;
/** bb's updatedAt stands still while a turn runs, so a thread in one of these may have spent since then. */
const RUNNING = new Set(["starting", "active", "stopping"]);

const budgetSetting = z
  .number()
  .positive("Enter an amount above zero, or leave it empty for no budget.")
  .max(BUDGET_MAX, "Enter an amount up to $1,000,000.");

const PERCENT = "Enter a percentage from -100 to 100, or 0 for list price.";
const discountSetting = z.number().min(DISCOUNT_MIN, PERCENT).max(DISCOUNT_MAX, PERCENT);

export const SETTINGS = {
  chip: {
    type: "boolean",
    label: "Cost chip",
    description:
      "Shows what the thread has cost beside the context circle under the prompt box, or in the thread header when that row is not on screen, where a phone shows the flame alone. Click it for the breakdown.",
    default: true,
  },
  chipShows: {
    type: "select",
    label: "Chip shows",
    description: "What the chip reads between prompts: the total and, for a few seconds after each prompt, what it added; or the total alone.",
    options: ["delta", "cost"],
    experimental_optionLabels: { delta: "Cost and last turn", cost: "Cost only" },
    default: "delta",
  },
  threadBudget: {
    type: "number",
    label: "Thread budget",
    description:
      "Dollars per thread. The chip turns amber at 80% and red at 100%. A thread's own budget, set from the chip, the Burn panel or the thread menu, overrides it. Empty means no budget.",
    experimental_schema: budgetSetting,
  },
  dailyBudget: {
    type: "number",
    label: "Daily budget",
    description: "Dollars per day across all threads. Burn notifies you once a day when all threads together pass it. Empty means no daily budget.",
    experimental_schema: budgetSetting,
  },
  budgetAlerts: {
    type: "boolean",
    label: "Budget alerts",
    description: "Notifies you when a thread reaches 80% and 100% of its budget, once each.",
    default: true,
  },
  stopAtBudget: {
    type: "boolean",
    label: "Stop a thread at its budget",
    description:
      "Off by default: Burn never stops a thread unless you turn this on. When on, Burn stops the run whose cost crosses the thread's budget: in a pi thread with the Burn pi extension, the extension stops the run itself; otherwise Burn stops the thread's current work through bb. Claude Code threads are not stopped, because their cost arrives only as each turn ends. Send another prompt to continue; Burn does not stop a thread that is already over its budget again.",
    default: false,
  },
  flagOverBudget: {
    type: "boolean",
    label: "Flag threads over budget in the sidebar",
    description: "A red flame replaces the status glyph of a thread that is over its budget.",
    default: true,
  },
  notifyExpensiveTurn: {
    type: "boolean",
    label: "Notify after an unusually expensive turn",
    description: `Off by default. When on, Burn notifies you after a prompt that costs at least ${EXPENSIVE_MULTIPLE} times the thread's median turn and at least ${formatUsd(EXPENSIVE_MIN_USD)}.`,
    default: false,
  },
  discount: {
    type: "number",
    label: "Discount (%)",
    description:
      "Percent off list price for every cost Burn shows, budgets included. 16 means you pay 84% of list price. 0 means list price; a negative number, such as -10, adds 10%.",
    default: 0,
    experimental_schema: discountSetting,
  },
  inputDiscount: {
    type: "number",
    label: "Input discount (%)",
    description: "Replaces the discount above for uncached input tokens. Empty means the discount above.",
    experimental_schema: discountSetting,
  },
  outputDiscount: {
    type: "number",
    label: "Output discount (%)",
    description: "Replaces the discount above for output tokens, reasoning included. Empty means the discount above.",
    experimental_schema: discountSetting,
  },
  cacheReadDiscount: {
    type: "number",
    label: "Cache read discount (%)",
    description: "Replaces the discount above for cache reads. Empty means the discount above.",
    experimental_schema: discountSetting,
  },
  cacheWriteDiscount: {
    type: "number",
    label: "Cache write discount (%)",
    description: "Replaces the discount above for cache writes. Empty means the discount above.",
    experimental_schema: discountSetting,
  },
} satisfies PluginSettingDescriptors;

const ownBudgetSchema = z.object({ budget: z.number().finite().positive().nullable() });
const stoppedSchema = z.object({ at: z.number() });

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const sameSetting = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

/**
 * The settings to put back after bb forgot them. bb deletes a plugin's settings
 * when the plugin is removed, so Burn keeps its own copy in its storage, which
 * survives. A value the copy holds while bb reports the setting's default was
 * lost that way and goes back; a value bb holds of its own — what the user set
 * while the plugin was off — is left alone.
 */
export function settingsToRestore(copy: Record<string, unknown>, effective: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, was] of Object.entries(copy)) {
    // A setting Burn no longer declares, or one nobody ever set, has nothing to put back.
    if (!(key in SETTINGS)) continue;
    if (typeof was !== "string" && typeof was !== "number" && typeof was !== "boolean") continue;
    const fallback = (SETTINGS as Record<string, { default?: unknown }>)[key]?.default ?? null;
    if (!sameSetting(was, fallback) && sameSetting(effective[key], fallback)) out[key] = was;
  }
  return out;
}

/** Keeps `map` to the `max` most recently set keys. */
function remember<V>(map: Map<string, V>, key: string, value: V, max = MAX_THREADS): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

const topModel = (report: UsageReport): string | null => report.byModel[0]?.key ?? null;

/**
 * A thread's merged report. `source` is "pi" while its Burn pi extension is
 * reporting, else where Burn read it: "log" or "events"; `at` is when either last changed.
 */
interface Resolved {
  report: UsageReport;
  source: "pi" | "log" | "events";
  at: number;
}

// A thread born after the plugin loaded has nothing earlier to be quiet about.
const EMPTY = buildReport([], null);

/** A report a POST just stored, used in place of the latest when looking at that POST. */
type Pinned = { threadId: string; stored: Stored };

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define(SETTINGS);
  // bb deletes a plugin's settings when the plugin is removed, so Burn keeps its own copy in its storage, which survives.
  const keepSettings = async (values: Record<string, unknown>): Promise<void> => {
    try {
      await bb.storage.kv.set(SETTINGS_COPY_KEY, values);
    } catch (err) {
      bb.log.warn(`keeping a copy of Burn's settings failed: ${message(err)}`);
    }
  };
  settings.onChange((next) => void keepSettings(next));
  const kept = await bb.storage.kv.get<Record<string, unknown>>(SETTINGS_COPY_KEY);
  if (kept !== undefined) {
    const lost = settingsToRestore(kept, await settings.get());
    const keys = Object.keys(lost);
    if (keys.length > 0) {
      try {
        await settings.experimental_set(lost as Parameters<typeof settings.experimental_set>[0]);
        bb.log.info(`put back ${keys.join(", ")}, which bb forgot when the plugin was removed`);
      } catch (err) {
        bb.log.warn(`putting back the settings bb forgot with the plugin failed: ${message(err)}`);
      }
    }
  }
  await keepSettings(await settings.get());
  // Every thread's row, shared by the report source, the sidebar flags and the Burn page, so none of them asks bb per thread.
  const directory = createThreadDirectory(bb);
  // null: the thread has no stored report, so it is not read from KV again.
  const reports = new Map<string, Stored | null>();
  const budgets = new Map<string, OwnBudget>();
  const titles = new Map<string, { title: string | null; at: number }>();
  const observed = new Map<string, UsageReport>();
  const stops = new Map<string, number | null>();
  let observing: Promise<void> = Promise.resolve();
  let disposed = false;
  let dailyTimer: ReturnType<typeof setTimeout> | undefined;
  let warmTimer: ReturnType<typeof setTimeout> | undefined;
  let dailyAt = Number.NEGATIVE_INFINITY;
  bb.onDispose(() => {
    disposed = true;
    clearTimeout(dailyTimer);
    clearTimeout(warmTimer);
  });
  const source = createReportSource(bb, { onChange: changed, threads: directory });
  const loadedAt = Date.now();

  async function load(threadId: string): Promise<Stored | null> {
    if (reports.has(threadId)) return reports.get(threadId) ?? null;
    const raw = await bb.storage.kv.get<unknown>(reportKey(threadId));
    if (raw === undefined) {
      remember(reports, threadId, null);
      return null;
    }
    const parsed = storedSchema.safeParse(raw);
    if (!parsed.success) {
      await bb.storage.kv.delete(reportKey(threadId));
      remember(reports, threadId, null);
      return null;
    }
    remember(reports, threadId, parsed.data);
    return parsed.data;
  }

  async function stoppedOf(threadId: string): Promise<number | null> {
    if (stops.has(threadId)) return stops.get(threadId) ?? null;
    const raw = await bb.storage.kv.get<unknown>(stoppedKey(threadId));
    const parsed = stoppedSchema.safeParse(raw);
    if (raw !== undefined && !parsed.success) await bb.storage.kv.delete(stoppedKey(threadId));
    const at = parsed.success ? parsed.data.at : null;
    remember(stops, threadId, at);
    return at;
  }

  /**
   * Each thread's report. Every figure comes from what Burn read itself: a pi
   * thread's session logs on the machine that runs it, or the usage bb records
   * for other harnesses; else from the report its pi sent. That report adds only
   * what a log cannot know: pi's own budget, when pi stopped a run, and the
   * context window. Whether it is working comes from bb.
   */
  async function resolveMany(threadIds: readonly string[], pinned?: Pinned, prices: "settings" | "list" = "settings"): Promise<Map<string, Resolved>> {
    const ids = [...new Set(threadIds)];
    const [logs, values] = await Promise.all([source.reportsOf(ids, { deadlineMs: HOST_WAIT_MS }), settings.get()]);
    const discounts = prices === "list" ? NO_DISCOUNTS : discountsOf(values);
    const out = new Map<string, Resolved>();
    await Promise.all(
      ids.map(async (threadId) => {
        const [stored, stopped, running] = await Promise.all([
          pinned?.threadId === threadId ? pinned.stored : load(threadId),
          stoppedOf(threadId),
          source.running(threadId),
        ]);
        const log = logs.get(threadId);
        const base = log?.report ?? stored?.report;
        if (!base) return;
        const pi = stored?.report ?? null;
        const piStopped = pi?.stoppedAt ?? null;
        const report = applyDiscounts(
          {
            ...base,
            budget: pi?.budget ?? null,
            stoppedAt: piStopped === null || stopped === null ? (piStopped ?? stopped) : Math.max(piStopped, stopped),
            context: pi?.context ?? base.context,
            running,
          },
          discounts,
        );
        const fromPi = stored !== null && Date.now() - stored.at < PI_FRESH_MS;
        out.set(threadId, { report, source: fromPi ? "pi" : (log?.source ?? "log"), at: Math.max(log?.at ?? 0, stored?.at ?? 0) });
      }),
    );
    return out;
  }

  async function resolve(threadId: string): Promise<Resolved | null> {
    return (await resolveMany([threadId])).get(threadId) ?? null;
  }

  const reportsIn = (resolved: Map<string, Resolved>, ids: readonly string[]): { id: string; report: UsageReport }[] =>
    ids.flatMap((id) => {
      const got = resolved.get(id);
      return got ? [{ id, report: got.report }] : [];
    });

  /**
   * The listed threads `keep` picks, and every thread that reported but bb did
   * not list (one created since the last listing); every thread that reported
   * when bb cannot list them.
   */
  async function threadsWhere(keep: (thread: ThreadRow) => boolean): Promise<string[]> {
    const reported = (await bb.storage.kv.list(REPORT_PREFIX)).map((key) => key.slice(REPORT_PREFIX.length));
    let rows: ThreadRow[];
    try {
      rows = await directory.all();
    } catch (err) {
      bb.log.warn(`listing threads failed, so only reporting threads count: ${message(err)}`);
      return reported;
    }
    const known = new Set(rows.map((t) => t.id));
    return [...rows.filter(keep).map((t) => t.id), ...reported.filter((id) => !known.has(id))];
  }

  /** Reports of every thread that may have spent since `since`: active since then, or running now. */
  async function threadReports(since: number, prices: "settings" | "list" = "settings"): Promise<{ entries: { threadId: string; report: UsageReport }[]; reading: number }> {
    const ids = await threadsWhere((t) => t.updatedAt >= since || RUNNING.has(t.status));
    const resolved = await resolveMany(ids, undefined, prices);
    return { entries: reportsIn(resolved, ids).map(({ id, report }) => ({ threadId: id, report })), reading: source.reading(ids) };
  }

  async function ownBudget(threadId: string): Promise<OwnBudget> {
    if (budgets.has(threadId)) return budgets.get(threadId);
    const raw = await bb.storage.kv.get<unknown>(budgetKey(threadId));
    let own: OwnBudget;
    if (raw !== undefined) {
      const parsed = ownBudgetSchema.safeParse(raw);
      if (parsed.success) own = parsed.data.budget;
      else await bb.storage.kv.delete(budgetKey(threadId));
    }
    remember(budgets, threadId, own);
    return own;
  }

  type Values = Awaited<ReturnType<typeof settings.get>>;

  async function budgetOf(threadId: string, report: UsageReport | null, values?: Values) {
    const { threadBudget } = values ?? (await settings.get());
    return effectiveBudget(await ownBudget(threadId), threadBudget, report?.budget ?? null);
  }

  async function policyOf(threadId: string) {
    return policyFor(await ownBudget(threadId), await settings.get());
  }

  /** The thread's title, cached briefly; null when bb cannot say (the failure is logged once per TTL). */
  async function titleOf(threadId: string): Promise<string | null> {
    const cached = titles.get(threadId);
    if (cached && Date.now() - cached.at < TITLE_TTL_MS) return cached.title;
    let title: string | null = null;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      title = thread.title ?? thread.titleFallback ?? null;
    } catch (err) {
      bb.log.warn(`looking up the title of ${threadId} failed: ${message(err)}`);
    }
    remember(titles, threadId, { title, at: Date.now() });
    return title;
  }

  async function descendantsOf(threadIds: readonly string[], strict = false): Promise<Map<string, string[]>> {
    try {
      // Archived and hidden children still cost money, and thread-spend counts them too.
      const { threads } = await bb.sdk.threads.experimental_listDescendants({ threadIds, includeArchived: true, includeHidden: true });
      const rows = await directory.all();
      return new Map(threads.map((t) => [t.threadId, withOwnedThreads(t.threadId, t.descendantIds, rows)]));
    } catch (err) {
      bb.log.warn(`listing the child threads of ${threadIds.length} thread(s) failed: ${message(err)}`);
      if (strict) throw err;
      return new Map();
    }
  }

  async function familyOf(report: UsageReport | null, reported: { id: string; report: UsageReport }[]): Promise<Family> {
    const total = reported.reduce((sum, c) => sum + c.report.cost.total, report?.cost.total ?? 0);
    const calls = reported.reduce((sum, c) => sum + c.report.calls, report?.calls ?? 0);
    const estimated = (report?.estimated ?? false) || reported.some((c) => c.report.estimated);
    const costliest = reported.sort((a, b) => b.report.cost.total - a.report.cost.total).slice(0, CHILDREN_MAX);
    const children = await Promise.all(
      costliest.map(async ({ id, report: r }) => ({
        threadId: id,
        title: (await titleOf(id)) ?? UNTITLED,
        cost: r.cost.total,
        ...(r.agents ? {agents: r.agents} : {}),
        calls: r.calls,
        running: r.running,
        model: topModel(r),
        estimated: r.estimated,
      })),
    );
    const all = [report, ...reported.map(r => r.report)];
    const rows = all.flatMap(r => r?.agents?.rows ?? []);
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    for (const row of rows) for (const key of Object.keys(cost) as (keyof typeof cost)[]) cost[key] += row.cost[key];
    // Family consumers need only a total; individual rows stay with each displayed thread.
    const agentRows = rows.length ? [{ id: "family-total", calls: rows.reduce((n, r) => n + r.calls, 0), cost, estimated: rows.some(r => r.estimated) }] : [];
    const agents = { coverage: all.every(r => r?.agents?.coverage === "available") ? "available" as const : "partial" as const, rows: agentRows, count: rows.length };
    return { total, calls, estimated, children, agents };
  }

  async function costRow(threadId: string, report: UsageReport | null, children: { id: string; report: UsageReport }[], values: Values): Promise<CostRow> {
    const budget = await budgetOf(threadId, report, values);
    const cost = report?.cost.total ?? 0;
    return {
      threadId,
      cost: report ? cost : null,
      label: report ? usageLabel(report) : null,
      familyCost: children.length > 0 ? children.reduce((sum, c) => sum + c.report.cost.total, cost) : null,
      budget,
      state: budgetState(cost, budget?.amount),
      estimated: (report?.estimated ?? false) || children.some((c) => c.report.estimated),
    };
  }

  const spendDeps: SpendDeps = {
    bb,
    budgetOf: async (threadId, report) => (await budgetOf(threadId, report))?.amount ?? null,
    dailyBudget: async () => positiveOrNull((await settings.get()).dailyBudget),
    reports: threadReports,
    descendantsOf: ids => descendantsOf(ids, true),
    rowsOf: async (ids) => {
      const out = new Map<string, { title: string; projectId: string; providerId: string }>();
      await Promise.all(
        ids.map(async (id) => {
          const row = await directory.one(id);
          if (row) out.set(id, { title: row.title || row.titleFallback || UNTITLED, projectId: row.projectId, providerId: row.providerId });
        }),
      );
      return out;
    },
  };

  /** Publishes the toasts a change in a thread's figures earns. */
  async function announce(threadId: string, prev: UsageReport, next: UsageReport, values: Values): Promise<void> {
    const budget = (await budgetOf(threadId, next, values))?.amount ?? null;
    const events = alertEvents(prev, next, { budget, budgetAlerts: values.budgetAlerts, notifyExpensiveTurn: values.notifyExpensiveTurn });
    if (events.length === 0) return;
    const title = (await titleOf(threadId)) ?? UNTITLED;
    for (const event of events) bb.realtime.publish(ALERT_CHANNEL, alertFor(event, threadId, title, Date.now()));
  }

  /**
   * The server's stop, for a thread without the Burn pi extension: only with the
   * stop setting on, while bb says the thread is working, for the change that
   * crosses its budget. A thread whose extension has reported is left to it: the
   * extension stops its own run from the policy in each reply, and bb's stop,
   * which also releases the thread's runtime, must not race it.
   */
  async function stopAtBudget(threadId: string, prev: UsageReport, next: UsageReport, values: Values): Promise<void> {
    if (!values.stopAtBudget || !next.running) return;
    // A harness that reports a turn as it ends has nothing left to stop.
    if (!(await source.harnessOf(threadId))?.perCall) return;
    const policy = policyFor(await ownBudget(threadId), values);
    if (!shouldStop(policy, prev.cost.total, next.cost.total)) return;
    if ((await load(threadId)) !== null) return;
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch (err) {
      bb.log.warn(`stopping ${threadId} at its budget failed: ${message(err)}`);
      return;
    }
    const at = Date.now();
    remember(stops, threadId, at);
    const held = observed.get(threadId);
    if (held) remember(observed, threadId, { ...held, stoppedAt: at });
    try {
      await bb.storage.kv.set(stoppedKey(threadId), { at });
    } catch (err) {
      bb.log.warn(`saving the stop of ${threadId} failed: ${message(err)}`);
    }
    const title = (await titleOf(threadId)) ?? UNTITLED;
    bb.realtime.publish(ALERT_CHANNEL, alertFor({ kind: "stopped", stoppedAt: at, budget: policy.budget }, threadId, title, at));
  }

  async function look(threadIds: readonly string[], pinned?: Pinned): Promise<void> {
    // observed keeps list prices, so both figures get the same discounts and a changed setting is never spend.
    const [resolved, values] = await Promise.all([resolveMany(threadIds, pinned, "list"), settings.get()]);
    const discounts = discountsOf(values);
    for (const threadId of threadIds) {
      const atList = resolved.get(threadId)?.report;
      if (!atList) continue;
      const seen = observed.get(threadId) ?? (atList.startedAt >= loadedAt ? EMPTY : null);
      const next = applyDiscounts(atList, discounts);
      const prev = seen === null ? null : applyDiscounts(seen, discounts);
      // A lower figure, at list price or discounted, is a source catching up, not spend; keeping the higher one crosses no threshold twice.
      if (seen !== null && prev !== null && (atList.cost.total < seen.cost.total || next.cost.total < prev.cost.total)) continue;
      remember(observed, threadId, atList);
      if (prev === null) continue;
      await stopAtBudget(threadId, prev, next, values);
      await announce(threadId, prev, next, values);
    }
    checkDailySoon();
  }

  /** Checks the daily budget now, or DAILY_CHECK_MS after the last check, so a burst of changes checks it once. */
  function checkDailySoon(): void {
    if (disposed || dailyTimer !== undefined) return;
    dailyTimer = setTimeout(
      () => {
        dailyTimer = undefined;
        dailyAt = Date.now();
        checkDailyBudget(spendDeps).then(
          (daily) => {
            if (daily !== null && !disposed) bb.realtime.publish(ALERT_CHANNEL, daily);
          },
          (err: unknown) => {
            if (!disposed) bb.log.warn(`checking the daily budget failed: ${message(err)}`);
          },
        );
      },
      Math.max(0, dailyAt + DAILY_CHECK_MS - Date.now()),
    );
  }

  /**
   * Looks at threads whose figures may have changed, one look at a time and in
   * order: compares each merged report with the last one seen, then applies the
   * stop and publishes the alerts it earns. The first look at a thread from
   * before the plugin loaded only sets the baseline, so reopening a thread
   * already over its budget stays quiet; a newer thread starts from nothing.
   */
  function observe(threadIds: readonly string[], pinned?: Pinned): Promise<void> {
    const run = observing.then(() => (disposed ? undefined : look(threadIds, pinned)));
    observing = run.catch(() => undefined);
    return run;
  }

  settings.onChange((next, prev) => {
    if (disposed || sameDiscounts(discountsOf(next), discountsOf(prev))) return;
    bb.realtime.publish("usage", {});
    // Repriced spend is not new spend: a day it already puts over the daily budget is marked as alerted, silently.
    checkDailyBudget(spendDeps).catch((err: unknown) => bb.log.warn(`checking the daily budget after a discount change failed: ${message(err)}`));
  });

  /** The source's news: a host saw these threads' logs change, or bb says they started or stopped working. */
  function changed(threadIds: string[]): void {
    observe(threadIds)
      .catch((err: unknown) => {
        if (!disposed) bb.log.warn(`looking at the new figures of ${threadIds.length} thread(s) failed: ${message(err)}`);
      })
      .finally(async () => {
        if (disposed) return;
        const about = new Set(threadIds);
        try {
          const rows = await directory.all();
          let grew = true;
          while (grew) {
            grew = false;
            for (const row of rows) if (about.has(row.id)) {
              for (const parent of [row.parentThreadId, row.lifecycleOwnerThreadId]) if (parent && !about.has(parent)) {
                about.add(parent); grew = true;
              }
            }
          }
        } catch { bb.realtime.publish("usage", {}); }
        if (!disposed) for (const threadId of about) bb.realtime.publish("usage", { threadId });
      });
  }

  bb.rpc.register(rpcContract, {
    usage: async ({ threadId, listPrice }) => {
      const descendants = (await descendantsOf([threadId])).get(threadId) ?? [];
      const resolved = await resolveMany([threadId, ...descendants], undefined, listPrice ? "list" : "settings");
      const own = resolved.get(threadId) ?? null;
      const report = own?.report ?? null;
      const [budget, policy, title, family] = await Promise.all([
        budgetOf(threadId, report),
        policyOf(threadId),
        titleOf(threadId),
        familyOf(report, reportsIn(resolved, descendants)),
      ]);
      if (report) {
        family.lastTurnCost = spawnedTurnCost(threadId, report.turns.at(-1)?.at, report.lastTurnCost,
          reportsIn(resolved, descendants), await directory.all().catch(() => []));
      }
      return { report, source: own?.source ?? null, reportedAt: own?.at ?? null, title, budget, policy, family };
    },
    setBudget: async ({ threadId, budget }) => {
      if (budget === "default") await bb.storage.kv.delete(budgetKey(threadId));
      else await bb.storage.kv.set(budgetKey(threadId), { budget });
      remember(budgets, threadId, budget === "default" ? undefined : budget);
      bb.realtime.publish("usage", { threadId });
      const report = (await resolve(threadId))?.report ?? null;
      return { budget: await budgetOf(threadId, report), policy: await policyOf(threadId) };
    },
    costs: async ({ threadIds }) => {
      const [descendants, values] = await Promise.all([descendantsOf(threadIds), settings.get()]);
      const resolved = await resolveMany([...threadIds, ...[...descendants.values()].flat()]);
      return {
        threads: await Promise.all(
          threadIds.map((id) => costRow(id, resolved.get(id)?.report ?? null, reportsIn(resolved, descendants.get(id) ?? []), values)),
        ),
      };
    },
    overBudget: async () => {
      // The sidebar shows no archived thread, so none is read for its flag.
      const ids = await threadsWhere((t) => t.archivedAt === null);
      const [resolved, values] = await Promise.all([resolveMany(ids), settings.get()]);
      const rows = await Promise.all(
        reportsIn(resolved, ids).map(async ({ id: threadId, report }) => {
          const budget = await budgetOf(threadId, report, values);
          const cost = report.cost.total;
          return budget !== null && budgetState(cost, budget.amount) === "over"
            ? { threadId, cost, budget: budget.amount, estimated: report.estimated }
            : null;
        }),
      );
      return { threads: rows.filter((r) => r !== null) };
    },
    ...createSpendHandlers(spendDeps),
  });

  // The Burn pi extension reports each change here (extensions/pi/bb-report.ts) and applies the policy in the reply.
  bb.http.route("POST", "/usage", async (c) => {
    const text = await c.req.text();
    if (Buffer.byteLength(text, "utf8") > REPORT_MAX_BYTES) return c.json({ ok: false, error: "usage report too large" } satisfies UsageReply, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ ok: false, error: "usage report is not JSON" } satisfies UsageReply, 400);
    }
    const envelope = usageEnvelopeSchema.safeParse(body);
    if (!envelope.success) return c.json({ ok: false, error: "invalid usage report" } satisfies UsageReply, 400);
    const { threadId, sentAt, report } = envelope.data;
    const policy = await policyOf(threadId);
    const held = await load(threadId);
    if (held && sentAt < held.sentAt) return c.json({ ok: true, policy } satisfies UsageReply);
    const stored: Stored = { report, sentAt, at: Date.now() };
    remember(reports, threadId, stored);
    try {
      await bb.storage.kv.set(reportKey(threadId), stored);
    } catch (err) {
      bb.log.warn(`saving the usage report of ${threadId} failed: ${message(err)}`);
    }
    bb.realtime.publish("usage", { threadId });
    // After the reply, so a slow look at the thread never delays pi.
    observe([threadId], { threadId, stored }).catch((err: unknown) => {
      if (!disposed) bb.log.warn(`publishing the alerts of ${threadId} failed: ${message(err)}`);
    });
    return c.json({ ok: true, policy } satisfies UsageReply);
  });

  bb.providers.experimental_contributeEnv("pi", () => [
    {
      name: "BURN_BB_URL",
      value: { serverPath: `/api/v1/plugins/${bb.pluginId}/http/usage` },
      reason: "Where the Burn pi extension reports this thread's cost to the Burn plugin",
    },
  ]);

  // A thread moving in or out of the archive moves in or out of the sidebar's flags.
  for (const name of ["thread.archived", "thread.unarchived"] as const) {
    bb.events.on(name, () => {
      directory.refresh();
    });
  }

  bb.events.on("thread.deleted", async ({ thread }) => {
    directory.refresh();
    reports.delete(thread.id);
    budgets.delete(thread.id);
    titles.delete(thread.id);
    observed.delete(thread.id);
    stops.delete(thread.id);
    try {
      await Promise.all([source.forget(thread.id), ...[reportKey, budgetKey, logKey, stoppedKey].map((key) => bb.storage.kv.delete(key(thread.id)))]);
    } catch (err) {
      bb.log.warn(`forgetting the usage report of ${thread.id} failed: ${message(err)}`);
    }
  });

  // Read the details of the threads the Burn page is most likely to ask about, so its first open
  // over a thousand threads answers from a warm cache instead of looking each one up.
  warmTimer = setTimeout(() => {
    if (disposed) return;
    threadsWhere((t) => t.updatedAt >= Date.now() - WARM_DAYS * 86_400_000)
      .then((ids) => source.warm(ids))
      .catch((err: unknown) => {
        if (!disposed) bb.log.warn(`warming the threads' details failed: ${message(err)}`);
      });
  }, WARM_DELAY_MS);
}
