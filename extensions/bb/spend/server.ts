import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { budgetState } from "../../../src/budget.js";
import { formatAmount, formatBudget, median, modelName } from "../../../src/format.js";
import { CALL_TIME_BUCKETS, type DayRow, dayKey, type ModelRow, OTHER_KEY, outputPerSec, TOOLS_KEY, type UsageReport } from "../../../src/report.js";
import type { BurnAlert } from "../alerts.js";
import { harnessName } from "../harnesses.js";
import { REPORT_PREFIX, SPEND_PANELS_KEY } from "../keys.js";
import { type Stored, storedSchema } from "../schema.js";
import { SPEND_PANELS, type SpendMetric, type SpendOutput, type SpendPanel, type SpendPanels, type SpendRange, type SpendZone } from "./contract.js";
import { dayDate, localDays, RANGE_DAYS } from "./days.js";
import { activityGrid, addUsage, callTimeQuantile, emptyUsage, type Usage } from "./tally.js";

export interface SpendDeps {
  bb: BbPluginApi;
  /** The budget that applies to a thread: its own, else the setting, else the one pi reported. */
  budgetOf(threadId: string, report: UsageReport): Promise<number | null>;
  /** The Daily budget setting, or null when unset. */
  dailyBudget(): Promise<number | null>;
  /**
   * Every thread's report that may have spend since `since`. server.ts adds
   * threads that never reported, read from their session logs; without it,
   * only the reports stored in KV count. `prices` "list" leaves out Burn's discount settings.
   * `reading` is how many of those threads' figures were still being read when the answer was made.
   */
  reports?(since: number, prices?: "settings" | "list"): Promise<{ entries: Entry[]; reading: number }>;
  /** Title, project and provider of these threads, from one shared listing rather than a call per thread. */
  rowsOf?(ids: readonly string[]): Promise<Map<string, { title: string; projectId: string; providerId: string }>>;
  descendantsOf?(ids: readonly string[]): Promise<Map<string, string[]>>;
  now?: () => number;
}

export const DAILY_ALERT_PREFIX = "daily-alert:";
export const dailyAlertKey = (day: string): string => `${DAILY_ALERT_PREFIX}${day}`;

const META_TTL_MS = 60_000;
const DAY_MS = 86_400_000;
const TOP_THREADS = 10;
const CHART_MODELS = 4;
const MODEL_ROWS_MAX = 10;
/** `experimental_listDescendants` takes 1–200 ids per call. */
const SDK_BATCH = 200;
const SDK_CONCURRENCY = 8;
const UNTITLED = "Untitled thread";
const UNKNOWN_PROJECT = "Unknown project";
const KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

interface ThreadMeta {
  title: string;
  projectId: string;
  providerId: string;
  childCount: number;
}

export interface Entry {
  threadId: string;
  report: UsageReport;
}

interface Counted extends Entry {
  meta: ThreadMeta;
  /** Use over the chosen days. */
  used: Usage;
}

/** What the Models table's ratios are read from: a model's use over the whole life of the threads in range. */
type Life = Omit<ModelRow, "key" | "cost" | "tokens">;

interface ModelSum {
  key: string;
  providerId: string;
  used: Usage;
  estimated: boolean;
}

/** The counted threads' use over the chosen days. */
interface RangeSums {
  perDay: Map<string, { used: Usage; models: Map<string, Usage> }>;
  chart: Map<string, Usage>;
  /** Keyed by provider id and model key, so one model under two harnesses is two rows; a report's own Other is OTHER_KEY. */
  models: Map<string, ModelSum>;
  life: Map<string, Life>;
  mix: SpendOutput["mix"];
  callTime: number[];
  failed: number;
  aborted: number;
  prompts: number;
}

const add = (map: Map<string, number>, key: string, cost: number): void => {
  map.set(key, (map.get(key) ?? 0) + cost);
};

/** The Usage held under `key`, created empty the first time. */
function usageAt<K>(map: Map<K, Usage>, key: K): Usage {
  let used = map.get(key);
  if (!used) {
    used = emptyUsage();
    map.set(key, used);
  }
  return used;
}

const kindTokens = (t: DayRow["tokens"]): number => t.input + t.output + t.cacheRead + t.cacheWrite;
const dayUsage = (d: DayRow): Usage => ({ cost: d.cost, tokens: kindTokens(d.tokens), calls: d.calls });
const valuesIn = (map: Map<string, Usage>, metric: SpendMetric): Map<string, number> => new Map([...map].map(([key, used]) => [key, used[metric]]));

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const parse = (raw: unknown): Stored | null => {
  const parsed = storedSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** Every stored report entry, unparsed. */
async function readEntries(bb: BbPluginApi): Promise<{ key: string; raw: unknown }[]> {
  const keys = await bb.storage.kv.list(REPORT_PREFIX);
  const raws = await Promise.all(keys.map((key) => bb.storage.kv.get<unknown>(key)));
  return keys.flatMap((key, i) => (raws[i] === undefined ? [] : [{ key, raw: raws[i] }]));
}

/** Every stored report that parses; entries that do not are skipped and left alone. */
async function readReports(bb: BbPluginApi): Promise<Entry[]> {
  return (await readEntries(bb)).flatMap(({ key, raw }) => {
    const stored = parse(raw);
    return stored ? [{ threadId: key.slice(REPORT_PREFIX.length), report: stored.report }] : [];
  });
}

/** The biggest keys, Other last; past `max` keys, the rest fold into Other. */
function topKeys(values: Map<string, number>, max: number): { keys: string[]; fold: (key: string) => string } {
  const sorted = [...values.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);
  const named = sorted.filter((k) => k !== OTHER_KEY);
  const head = new Set(sorted.length <= max ? named : named.slice(0, max - 1));
  const keys = head.size < sorted.length ? [...head, OTHER_KEY] : [...head];
  return { keys, fold: (key) => (head.has(key) ? key : OTHER_KEY) };
}

/** A report's spend per day in `zone`. Burn 0.2 sent no UTC days, so its local days stand in for them. */
const daysIn = (report: UsageReport, zone: SpendZone): DayRow[] =>
  zone === "utc" && report.utcDays.length > 0 ? report.utcDays : report.days;

function rangeModels(days: readonly DayRow[], inRange: ReadonlySet<string>): Map<string, number> {
  const models = new Map<string, number>();
  for (const d of days) if (inRange.has(d.day)) for (const m of d.models) add(models, m.key, m.cost);
  return models;
}

function topModel(models: Map<string, number>, report: UsageReport): string | null {
  const isModel = (key: string): boolean => key !== OTHER_KEY && key !== TOOLS_KEY;
  const ranked = [...models.entries()].filter(([k, c]) => isModel(k) && c > 0).sort((a, b) => b[1] - a[1]);
  const key = ranked[0]?.[0] ?? report.byModel.find((m) => isModel(m.key))?.key;
  return key === undefined ? null : modelName(key);
}

function sumRange(counted: readonly Counted[], dayList: readonly string[], tz: SpendZone): RangeSums {
  const sums: RangeSums = {
    perDay: new Map(dayList.map((d) => [d, { used: emptyUsage(), models: new Map<string, Usage>() }])),
    chart: new Map(),
    models: new Map(),
    life: new Map(),
    mix: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costs: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    callTime: new Array<number>(CALL_TIME_BUCKETS).fill(0),
    failed: 0,
    aborted: 0,
    prompts: 0,
  };
  for (const row of counted) {
    const { providerId } = row.meta;
    for (const d of daysIn(row.report, tz)) {
      const slot = sums.perDay.get(d.day);
      if (!slot) continue;
      addUsage(slot.used, dayUsage(d));
      sums.prompts += d.prompts;
      for (const k of KINDS) {
        sums.mix.tokens[k] += d.tokens[k];
        sums.mix.costs[k] += d.costs[k];
      }
      sums.mix.tokens.reasoning += d.tokens.reasoning;
      d.callTime.forEach((n, i) => {
        sums.callTime[i] = (sums.callTime[i] ?? 0) + n;
      });
      sums.failed += d.failed;
      sums.aborted += d.aborted;
      for (const m of d.models) {
        addUsage(usageAt(slot.models, m.key), m);
        addUsage(usageAt(sums.chart, m.key), m);
        const key = m.key === OTHER_KEY ? OTHER_KEY : `${providerId}\n${m.key}`;
        const stat = sums.models.get(key) ?? { key: m.key, providerId, used: emptyUsage(), estimated: false };
        addUsage(stat.used, m);
        stat.estimated ||= row.report.estimated;
        sums.models.set(key, stat);
      }
    }
    for (const m of row.report.byModel) {
      const key = `${providerId}\n${m.key}`;
      const life = sums.life.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, timed: 0, ms: 0, timedOutput: 0, failed: 0 };
      life.input += m.input;
      life.output += m.output;
      life.cacheRead += m.cacheRead;
      life.cacheWrite += m.cacheWrite;
      life.calls += m.calls;
      life.timed += m.timed;
      life.ms += m.ms;
      life.timedOutput += m.timedOutput;
      life.failed += m.failed;
      sums.life.set(key, life);
    }
  }
  return sums;
}

const NO_RATIOS = { cacheHitPct: null, avgCallMs: null, outputPerSec: null, failedPct: null };

function ratios(life: Life | undefined): Pick<SpendOutput["modelStats"][number], keyof typeof NO_RATIOS> {
  if (!life) return NO_RATIOS;
  const prompt = life.input + life.cacheRead + life.cacheWrite;
  return {
    cacheHitPct: prompt > 0 ? (life.cacheRead / prompt) * 100 : null,
    avgCallMs: life.timed > 0 ? life.ms / life.timed : null,
    outputPerSec: outputPerSec(life),
    failedPct: life.timed > 0 ? (life.failed / life.timed) * 100 : null,
  };
}

/** The Models table: the top MODEL_ROWS_MAX by `metric`, the rest and any report's own Other folded into one Other row. */
function modelStats(sums: RangeSums, metric: SpendMetric): SpendOutput["modelStats"] {
  const named = [...sums.models.entries()]
    .filter(([key]) => key !== OTHER_KEY)
    .sort(([ka, a], [kb, b]) => b.used[metric] - a.used[metric] || ka.localeCompare(kb));
  const rows: SpendOutput["modelStats"] = named
    .slice(0, MODEL_ROWS_MAX)
    .map(([key, m]) => ({ key: m.key, harness: harnessName(m.providerId), ...m.used, ...ratios(sums.life.get(key)), estimated: m.estimated }));
  const rest = named.slice(MODEL_ROWS_MAX).map(([, m]) => m);
  const own = sums.models.get(OTHER_KEY);
  if (own) rest.push(own);
  if (rest.length > 0) {
    const used = emptyUsage();
    for (const m of rest) addUsage(used, m.used);
    rows.push({ key: OTHER_KEY, harness: null, ...used, ...NO_RATIOS, estimated: rest.some((m) => m.estimated) });
  }
  return rows;
}

/** The chart's days and models: the top CHART_MODELS by `metric`, each day's slices those with a value in it. */
function chartOf(sums: RangeSums, dayList: readonly string[], metric: SpendMetric): Pick<SpendOutput, "days" | "models"> {
  const { keys, fold } = topKeys(valuesIn(sums.chart, metric), CHART_MODELS);
  const days = dayList.map((day) => {
    const slot = sums.perDay.get(day);
    const folded = new Map<string, Usage>();
    if (slot) for (const [key, used] of slot.models) addUsage(usageAt(folded, fold(key)), used);
    const models = keys.flatMap((key) => {
      const used = folded.get(key);
      return used !== undefined && used[metric] > 0 ? [{ key, ...used }] : [];
    });
    return { day, ...(slot?.used ?? emptyUsage()), models };
  });
  const folded = new Map<string, Usage>();
  for (const [key, used] of sums.chart) addUsage(usageAt(folded, fold(key)), used);
  return { days, models: keys.map((key) => ({ key, ...(folded.get(key) ?? emptyUsage()) })) };
}

const isPanel = (v: unknown): v is SpendPanel => typeof v === "string" && (SPEND_PANELS as readonly string[]).includes(v);

export function createSpendHandlers(deps: SpendDeps): {
  spend(input: {
    range: SpendRange;
    projectId: string | null;
    tz?: SpendZone;
    metric?: SpendMetric;
    listPrice?: boolean;
    end?: string | null;
  }): Promise<SpendOutput>;
  spendPanels(input: Record<string, never>): Promise<SpendPanels>;
  setSpendPanels(input: SpendPanels): Promise<SpendPanels>;
} {
  const now = deps.now ?? Date.now;
  const { bb } = deps;
  const threads = new Map<string, { at: number; meta: ThreadMeta | null }>();
  let projects: { at: number; names: Map<string, string> } | null = null;

  async function projectNames(): Promise<Map<string, string>> {
    if (projects && now() - projects.at < META_TTL_MS) return projects.names;
    const list = await bb.sdk.projects.list({ includePersonal: true });
    projects = { at: now(), names: new Map(list.map((p) => [p.id, p.name])) };
    return projects.names;
  }

  /** Title, project, harness and child count of each thread that still exists; missing threads are left out. */
  async function threadMeta(ids: readonly string[]): Promise<Map<string, ThreadMeta>> {
    const at = now();
    const stale = ids.filter((id) => {
      const held = threads.get(id);
      return !held || at - held.at >= META_TTL_MS;
    });
    const children = new Map<string, number>();
    for (const batch of chunks(stale, SDK_BATCH)) {
      if (deps.descendantsOf) {
        for (const [id, ids] of await deps.descendantsOf(batch)) children.set(id, ids.length);
        continue;
      }
      const { threads: found } = await bb.sdk.threads.experimental_listDescendants({
        threadIds: batch,
        includeArchived: true,
        includeHidden: true,
      });
      for (const t of found) children.set(t.threadId, t.descendantIds.length);
    }
    const live = [...children.keys()];
    const fresh = new Map<string, ThreadMeta>();
    // With the shared listing, title, project and provider come from it; without one, each thread is read on its own.
    const rows = deps.rowsOf ? await deps.rowsOf(live) : null;
    if (rows) {
      for (const id of live) {
        const row = rows.get(id);
        if (row) fresh.set(id, { title: row.title, projectId: row.projectId, providerId: row.providerId, childCount: children.get(id) ?? 0 });
      }
    } else {
      const got = await mapLimit(live, SDK_CONCURRENCY, (threadId) => bb.sdk.threads.get({ threadId }));
      for (const t of got) {
        fresh.set(t.id, { title: t.title || t.titleFallback || UNTITLED, projectId: t.projectId, providerId: t.providerId, childCount: children.get(t.id) ?? 0 });
      }
    }
    for (const id of stale) threads.set(id, { at, meta: fresh.get(id) ?? null });
    const wanted = new Set(ids);
    for (const id of threads.keys()) if (!wanted.has(id)) threads.delete(id);
    const out = new Map<string, ThreadMeta>();
    for (const id of ids) {
      const meta = threads.get(id)?.meta;
      if (meta) out.set(id, meta);
    }
    return out;
  }

  return {
    async spend({ range, projectId, tz = "local", metric = "cost", listPrice = false, end = null }) {
      const today = localDays(now(), 1, 0, tz)[0] as string;
      const at = dayDate(end !== null && end < today ? end : today, tz).getTime();
      const length = RANGE_DAYS[range];
      const dayList = localDays(at, length, 0, tz);
      const inRange: ReadonlySet<string> = new Set(dayList);
      const before = new Set(localDays(at, length, length, tz));

      // A day of slack: the range and the period before it, whatever daylight saving does.
      const since = dayDate(dayList[0] as string, tz).getTime() - (length + 1) * DAY_MS;
      const { entries, reading } = deps.reports
        ? await deps.reports(since, listPrice ? "list" : "settings")
        : { entries: await readReports(bb), reading: 0 };
      // Budgets apply to the discounted figures, so a list-price answer leaves them out rather than compare the two.
      const [metas, names, dailyBudget] = await Promise.all([
        threadMeta(entries.map((e) => e.threadId)),
        entries.length > 0 ? projectNames() : new Map<string, string>(),
        listPrice ? null : deps.dailyBudget(),
      ]);

      const options = new Map<string, string>();
      const counted: Counted[] = [];
      let previousTotal = 0;
      let previousTokens = 0;
      let reportedThreads = 0;
      for (const entry of entries) {
        const meta = metas.get(entry.threadId);
        if (!meta) continue;
        reportedThreads++;
        const name = names.get(meta.projectId);
        if (name !== undefined) options.set(meta.projectId, name);
        if (projectId !== null && meta.projectId !== projectId) continue;
        const used = emptyUsage();
        for (const d of daysIn(entry.report, tz)) {
          if (before.has(d.day)) {
            previousTotal += d.cost;
            previousTokens += kindTokens(d.tokens);
          }
          if (inRange.has(d.day)) addUsage(used, dayUsage(d));
        }
        // Token-only harnesses, and threads whose only calls failed with no usage, count too.
        if (used.cost > 0 || used.tokens > 0 || used.calls > 0) counted.push({ ...entry, meta, used });
      }

      const sums = sumRange(counted, dayList, tz);
      const { days, models } = chartOf(sums, dayList, metric);

      const budgets = listPrice ? counted.map(() => null) : await Promise.all(counted.map((row) => deps.budgetOf(row.threadId, row.report)));
      const overBudgetCount = counted.filter((row, i) => budgetState(row.report.cost.total, budgets[i]) === "over").length;

      const byProject = new Map<string, Usage>();
      const byHarness = new Map<string, { used: Usage; estimated: boolean }>();
      for (const row of counted) {
        addUsage(usageAt(byProject, row.meta.projectId), row.used);
        const harness = byHarness.get(row.meta.providerId) ?? { used: emptyUsage(), estimated: false };
        addUsage(harness.used, row.used);
        harness.estimated ||= row.report.estimated;
        byHarness.set(row.meta.providerId, harness);
      }
      const projectRows: SpendOutput["projects"] = [...byProject.entries()]
        .map(([id, used]) => {
          const name = names.get(id);
          return name === undefined ? { projectId: null, name: UNKNOWN_PROJECT, ...used } : { projectId: id, name, ...used };
        })
        .sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name));
      const harnesses: SpendOutput["harnesses"] = [...byHarness.entries()]
        .map(([providerId, h]) => ({ providerId, name: harnessName(providerId), ...h.used, estimated: h.estimated }))
        .sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name));

      const order = counted.map((row, i) => ({ row, budget: budgets[i] ?? null }));
      order.sort(
        (a, b) =>
          b.row.used[metric] - a.row.used[metric] ||
          b.row.report.cost.total - a.row.report.cost.total ||
          a.row.threadId.localeCompare(b.row.threadId),
      );
      const top: SpendOutput["threads"] = order.slice(0, TOP_THREADS).map(({ row, budget }) => ({
        threadId: row.threadId,
        title: row.meta.title,
        projectName: names.get(row.meta.projectId) ?? null,
        model: topModel(rangeModels(daysIn(row.report, tz), inRange), row.report),
        harness: harnessName(row.meta.providerId),
        childCount: row.meta.childCount,
        calls: row.used.calls,
        tokens: row.used.tokens,
        rangeCost: row.used.cost,
        total: row.report.cost.total,
        budget,
        running: row.report.running,
        estimated: row.report.estimated,
      }));

      const totals = emptyUsage();
      for (const row of counted) addUsage(totals, row.used);
      // Only threads that cost something, so a harness that records no cost cannot pull the median or the per-call cost down.
      const priced = counted.filter((row) => row.used.cost > 0);
      const pricedCalls = priced.reduce((sum, row) => sum + row.used.calls, 0);
      const mixTokens = sums.mix.tokens;
      const prompt = mixTokens.input + mixTokens.cacheRead + mixTokens.cacheWrite;

      return {
        range,
        tz,
        metric,
        today,
        days,
        total: totals.cost,
        previousTotal,
        tokens: totals.tokens,
        previousTokens,
        calls: totals.calls,
        prompts: sums.prompts,
        runningCount: counted.filter((row) => row.report.running).length,
        threadCount: counted.length,
        overBudgetCount,
        medianThreadCost: median(priced.map((row) => row.used.cost)),
        perCall: pricedCalls > 0 ? totals.cost / pricedCalls : null,
        cacheHitPct: prompt > 0 ? (mixTokens.cacheRead / prompt) * 100 : null,
        mix: sums.mix,
        callTime: {
          buckets: sums.callTime,
          timed: sums.callTime.reduce((sum, n) => sum + n, 0),
          failed: sums.failed,
          aborted: sums.aborted,
          p50: callTimeQuantile(sums.callTime, 0.5),
          p90: callTimeQuantile(sums.callTime, 0.9),
        },
        activity: activityGrid(
          counted.flatMap((row) => row.report.hours),
          dayList,
          tz,
          metric,
        ),
        threads: top,
        projects: projectRows,
        models,
        modelStats: modelStats(sums, metric),
        harnesses,
        projectOptions: [...options.entries()]
          .map(([id, name]) => ({ projectId: id, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        dailyBudget,
        reportedThreads,
        reading,
        estimated: counted.some((row) => row.report.estimated),
        listPrice,
      };
    },

    async spendPanels() {
      const raw = await bb.storage.kv.get<unknown>(SPEND_PANELS_KEY);
      const list = typeof raw === "object" && raw !== null ? (raw as { hidden?: unknown }).hidden : undefined;
      // A newer Burn may have stored panels this one does not know.
      return { hidden: Array.isArray(list) ? [...new Set(list.filter(isPanel))] : [] };
    },

    async setSpendPanels({ hidden }) {
      const panels = { hidden: [...new Set(hidden)] };
      await bb.storage.kv.set(SPEND_PANELS_KEY, panels);
      return panels;
    },
  };
}

/**
 * Parsed reports by KV key, per plugin load. server.ts stamps `at` on every
 * write, so an entry whose `sentAt` and `at` are unchanged is the same report
 * and is not parsed again on every incoming report. Only the days are kept.
 */
const daysByHost = new WeakMap<BbPluginApi, Map<string, { sig: string; days: DayRow[] | null }>>();
const dailyChecks = new WeakMap<BbPluginApi, Promise<unknown>>();

function signature(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { sentAt, at } = raw as { sentAt?: unknown; at?: unknown };
  return typeof sentAt === "number" && typeof at === "number" ? `${sentAt}:${at}` : null;
}

interface DaySpend {
  cost: number;
  threads: number;
  /** Some of the cost is a list-price estimate. */
  estimated: boolean;
}

async function todaySpend(bb: BbPluginApi, today: string): Promise<DaySpend> {
  const memo = daysByHost.get(bb) ?? new Map<string, { sig: string; days: DayRow[] | null }>();
  daysByHost.set(bb, memo);
  const entries = await readEntries(bb);
  const seen = new Set(entries.map((e) => e.key));
  for (const key of memo.keys()) if (!seen.has(key)) memo.delete(key);
  let cost = 0;
  let threads = 0;
  for (const { key, raw } of entries) {
    const sig = signature(raw);
    const held = memo.get(key);
    let days: DayRow[] | null;
    if (sig !== null && held?.sig === sig) days = held.days;
    else {
      days = parse(raw)?.report.days ?? null;
      if (sig !== null) memo.set(key, { sig, days });
    }
    const spent = days?.find((d) => d.day === today)?.cost ?? 0;
    if (spent > 0) threads++;
    cost += spent;
  }
  // Only Burn pi extensions store reports here, and pi records every cost.
  return { cost, threads, estimated: false };
}

function todayFrom(entries: Entry[], today: string): DaySpend {
  let cost = 0;
  let threads = 0;
  let estimated = false;
  for (const { report } of entries) {
    const spent = report.days.find((d) => d.day === today)?.cost ?? 0;
    if (spent > 0) {
      threads++;
      estimated ||= report.estimated;
    }
    cost += spent;
  }
  return { cost, threads, estimated };
}

async function checkOnce(deps: SpendDeps): Promise<BurnAlert | null> {
  const budget = await deps.dailyBudget();
  if (budget === null || !(budget > 0)) return null;
  const at = (deps.now ?? Date.now)();
  const today = dayKey(at);
  const key = dailyAlertKey(today);
  if ((await deps.bb.storage.kv.get(key)) !== undefined) return null;
  const { cost, threads, estimated } = deps.reports
    ? todayFrom((await deps.reports(dayDate(today).getTime() - DAY_MS)).entries, today)
    : await todaySpend(deps.bb, today);
  if (cost < budget) return null;
  await deps.bb.storage.kv.set(key, { at });
  return {
    id: `daily:${today}`,
    kind: "daily",
    threadId: null,
    title: "Daily budget reached",
    body: `${formatAmount(cost, estimated)} spent across ${threads} ${threads === 1 ? "thread" : "threads"} today, over the ${formatBudget(budget)} daily budget.`,
    at,
  };
}

/**
 * server.ts calls this after storing each report; it returns the daily-budget
 * alert once per local day when the day's spend across all threads first
 * reaches the Daily budget setting, else null. Checks run one at a time per
 * plugin load, so two reports arriving together cannot both fire it.
 */
export function checkDailyBudget(deps: SpendDeps): Promise<BurnAlert | null> {
  const run = (dailyChecks.get(deps.bb) ?? Promise.resolve()).then(() => checkOnce(deps));
  dailyChecks.set(
    deps.bb,
    run.catch(() => undefined),
  );
  return run;
}
