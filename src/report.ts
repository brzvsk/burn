export interface CostParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface TokenParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type KindCosts = Omit<CostParts, "total">;

/** One provider/model's use over the whole session. */
export interface ModelRow extends TokenParts {
  key: string;
  cost: number;
  tokens: number;
  calls: number;
  /** Calls with a recorded duration. */
  timed: number;
  /** The timed calls' durations added up. */
  ms: number;
  /** The timed calls' output tokens, so a rate over `ms` leaves untimed calls out. */
  timedOutput: number;
  failed: number;
}

/** Use in one clock hour; `hour` counts hours since the Unix epoch, in UTC. */
export interface HourRow {
  hour: number;
  calls: number;
  tokens: number;
  cost: number;
}

/** One user prompt and every model call it led to, up to the next user prompt. */
export interface TurnRow {
  /** 1-based; 0 is usage recorded before the first user prompt. */
  n: number;
  at: number;
  endAt: number;
  /** The prompt's first characters on one line, or "" when it had no text. */
  prompt: string;
  calls: number;
  cost: number;
  tokens: TokenParts;
  /** The last CALL_COSTS_MAX call costs of the turn, in order. */
  callCosts: number[];
  /** The most-used tools, by count. */
  tools: { name: string; count: number }[];
  /** provider/model keys the turn's calls used. */
  models: string[];
  /** The timed calls' durations added up, and their output tokens. */
  ms: number;
  timedOutput: number;
}

/** Spend on one calendar day, YYYY-MM-DD. */
export interface DayRow {
  day: string;
  cost: number;
  calls: number;
  /** The day's costliest models; `tokens` counts all four kinds. */
  models: { key: string; cost: number; calls: number; tokens: number }[];
  /** User prompts sent that day. */
  prompts: number;
  tokens: TokenParts & { reasoning: number };
  costs: KindCosts;
  /** Timed calls per CALL_TIME_EDGES_MS bucket. */
  callTime: number[];
  /** Calls that ended in a provider error, and calls that were stopped. */
  failed: number;
  aborted: number;
}

export interface AgentUsage {
  /** Number of native agents when rows contains only a family aggregate. */
  count?: number;
  coverage: "available" | "partial";
  rows: { id: string; calls: number; cost: CostParts; estimated: boolean }[];
}

export interface UsageReport {
  /** Native agent spend is a subset of this report, never an additional charge. */
  agents?: AgentUsage;
  /** Limits of the available source, shown alongside its figures. */
  coverageNote?: string;
  coverage?: "available" | "partial";
  version: 2;
  startedAt: number;
  updatedAt: number;
  calls: number;
  lastTurnCost: number;
  tokens: TokenParts & { reasoning: number };
  cost: CostParts;
  cacheHitPct: number | null;
  context: { tokens: number | null; window: number; percent: number | null } | null;
  byModel: ModelRow[];
  /** The last SERIES_MAX calls; `turn` is the TurnRow.n the call belongs to. */
  series: { at: number; cost: number; tokens: number; turn: number }[];
  /** Every turn so far, including those no longer in `turns`. */
  turnCount: number;
  turns: TurnRow[];
  /** Local calendar days: the process zone's, or `opts.timeZone`'s. */
  days: DayRow[];
  /** The same spend by UTC calendar day. */
  utcDays: DayRow[];
  /** The newest HOURS_MAX hours that had use, oldest first. */
  hours: HourRow[];
  /** Set by the pi extension: true while pi is working on a prompt. */
  running: boolean;
  /** Set by the pi extension: the thread budget pi itself knows of (`/burn budget`), in dollars. */
  budget: number | null;
  /** Set by the pi extension: when Burn last stopped a run at the budget (only with stop at budget on). */
  stoppedAt: number | null;
  /** Some of the cost is a list-price estimate rather than recorded by the harness. */
  estimated: boolean;
}

/** Structural on purpose: pi's SessionEntry interfaces are assignable, and tests use plain objects. */
export type EntryLike = { type: string; timestamp: string; agentId?: string };

export const REPORT_VERSION = 2;
export const SERIES_MAX = 60;
export const MODELS_MAX = 8;
export const TURNS_MAX = 50;
export const DAYS_MAX = 60;
export const PROMPT_MAX = 120;
export const CALL_COSTS_MAX = 30;
export const TURN_TOOLS_MAX = 6;
export const TURN_MODELS_MAX = 3;
export const DAY_MODELS_MAX = 4;
export const TOOLS_KEY = "Tools/summaries";
export const OTHER_KEY = "Other";
/** Upper edges of the call-time buckets; the last bucket holds everything from the last edge up. */
export const CALL_TIME_EDGES_MS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000] as const;
export const CALL_TIME_BUCKETS = CALL_TIME_EDGES_MS.length + 1;
export const HOURS_MAX = 31 * 24;
export const HOUR_MS = 3_600_000;

/** Output tokens per second over the timed calls, or null with no timed output. */
export const outputPerSec = ({ timedOutput, ms }: { timedOutput: number; ms: number }): number | null =>
  timedOutput > 0 && ms > 0 ? timedOutput / (ms / 1000) : null;

/** The whole thread's output tokens per second, over every model's timed calls. */
export const reportOutputPerSec = (report: UsageReport): number | null =>
  outputPerSec({
    timedOutput: report.byModel.reduce((sum, m) => sum + m.timedOutput, 0),
    ms: report.byModel.reduce((sum, m) => sum + m.ms, 0),
  });

/** The index of the call-time bucket that `ms` falls in. */
export function callTimeBucket(ms: number): number {
  const i = CALL_TIME_EDGES_MS.findIndex((edge) => ms < edge);
  return i === -1 ? CALL_TIME_EDGES_MS.length : i;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  cost: CostParts;
  /** The cost came from a list price, not from the harness. */
  estimated?: boolean;
}

interface Counted {
  usage: Usage;
  key: string;
  call: boolean;
  durationMs?: number;
  stopReason?: string;
}

type Block = { type?: string; text?: string; name?: string };

interface Loose {
  type: string;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    responseModel?: string;
    usage?: Usage;
    content?: string | Block[];
    stopReason?: string;
    durationMs?: number;
  };
  usage?: Usage;
  provider?: string;
  model?: string;
}

interface TurnDraft extends TurnRow {
  toolCounts: Map<string, number>;
}

const tokensOf = (u: TokenParts): number => u.input + u.output + u.cacheRead + u.cacheWrite;

function classify(entry: Loose): Counted | null {
  const { message } = entry;
  if (entry.type === "message" && message?.role === "assistant" && message.usage) {
    return {
      usage: message.usage,
      key: `${message.provider}/${message.responseModel ?? message.model}`,
      call: true,
      durationMs: message.durationMs,
      stopReason: message.stopReason,
    };
  }
  if (entry.type === "usage" && entry.usage) {
    return { usage: entry.usage, key: `${entry.provider}/${entry.model}`, call: false };
  }
  if (entry.type === "message" && message?.role === "toolResult" && message.usage) {
    return { usage: message.usage, key: TOOLS_KEY, call: false };
  }
  if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
    return { usage: entry.usage, key: TOOLS_KEY, call: false };
  }
  return null;
}

/** The first PROMPT_MAX characters of a user message's text, whitespace collapsed. */
export function promptExcerpt(content: string | Block[] | undefined): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join(" ")
        : "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PROMPT_MAX ? `${flat.slice(0, PROMPT_MAX - 1)}…` : flat;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar day of a timestamp, YYYY-MM-DD, in `timeZone` (an IANA zone such as "UTC") or else the process zone. */
export function dayKey(ms: number, timeZone?: string): string {
  if (timeZone !== undefined) {
    let format = dayFormats.get(timeZone);
    if (!format) {
      format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
      dayFormats.set(timeZone, format);
    }
    return format.format(ms);
  }
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * When a forked session (a side chat, `/fork`) was created: its header names a
 * parent session. Its log starts with a copy of the parent's entries, which keep
 * their older timestamps, so only entries from this time on are its own.
 */
export function forkedAt(header: unknown): number | null {
  if (!isRecord(header) || typeof header.parentSession !== "string" || header.parentSession === "") return null;
  const at = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

function slimUsage(usage: unknown): Usage | undefined {
  if (!isRecord(usage) || !isRecord(usage.cost)) return undefined;
  const { cost } = usage;
  return {
    input: usage.input as number,
    output: usage.output as number,
    cacheRead: usage.cacheRead as number,
    cacheWrite: usage.cacheWrite as number,
    reasoning: usage.reasoning as number | undefined,
    cost: {
      input: cost.input as number,
      output: cost.output as number,
      cacheRead: cost.cacheRead as number,
      cacheWrite: cost.cacheWrite as number,
      total: cost.total as number,
    },
  };
}

/**
 * A session log entry cut down to what buildReport reads, so a reader that keeps
 * many logs in memory holds kilobytes rather than every prompt and tool output.
 * null for the session header and for anything that is not an entry.
 */
export function slimEntry(entry: unknown): EntryLike | null {
  if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.timestamp !== "string" || entry.type === "session") return null;
  const slim: Loose & EntryLike = { type: entry.type, timestamp: entry.timestamp, ...(typeof entry.agentId === "string" ? { agentId: entry.agentId } : {}) };
  const usage = slimUsage(entry.usage);
  if (usage) slim.usage = usage;
  if (entry.type === "usage") {
    slim.provider = entry.provider as string;
    slim.model = entry.model as string;
  }
  if (entry.type === "message" && isRecord(entry.message)) {
    const { role, provider, model, responseModel, content, stopReason, durationMs } = entry.message as NonNullable<Loose["message"]>;
    const message: NonNullable<Loose["message"]> = { role };
    if (provider !== undefined) message.provider = provider;
    if (model !== undefined) message.model = model;
    if (responseModel !== undefined) message.responseModel = responseModel;
    if (role === "assistant") {
      if (stopReason !== undefined) message.stopReason = stopReason;
      if (durationMs !== undefined) message.durationMs = durationMs;
    }
    const messageUsage = slimUsage(entry.message.usage);
    if (messageUsage) message.usage = messageUsage;
    if (role === "user") message.content = promptExcerpt(content);
    else if (Array.isArray(content)) {
      const calls = content.filter((b) => b?.type === "toolCall" && typeof b.name === "string").map((b) => ({ type: "toolCall", name: b.name }));
      if (calls.length > 0) message.content = calls;
    }
    slim.message = message;
  }
  return slim;
}

type DayModel = DayRow["models"][number];

interface DayDraft extends Omit<DayRow, "day" | "models"> {
  models: Map<string, DayModel>;
}

/** One counted usage, as the day, model and hour totals take it. */
interface Sample {
  key: string;
  usage: Usage;
  call: boolean;
  /** The call's duration when it is a call that recorded one. */
  ms: number | null;
  stopReason: string | undefined;
}

const newModelRow = (key: string): ModelRow => ({ key, cost: 0, tokens: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, timed: 0, ms: 0, timedOutput: 0, failed: 0 });

function dayDraft(days: Map<string, DayDraft>, day: string): DayDraft {
  let draft = days.get(day);
  if (!draft) {
    draft = {
      cost: 0,
      calls: 0,
      models: new Map(),
      prompts: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      costs: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      callTime: new Array<number>(CALL_TIME_BUCKETS).fill(0),
      failed: 0,
      aborted: 0,
    };
    days.set(day, draft);
  }
  return draft;
}

function addDay(draft: DayDraft, { key, usage, call, ms, stopReason }: Sample): void {
  const cost = usage.cost.total;
  draft.cost += cost;
  draft.tokens.input += usage.input;
  draft.tokens.output += usage.output;
  draft.tokens.cacheRead += usage.cacheRead;
  draft.tokens.cacheWrite += usage.cacheWrite;
  draft.tokens.reasoning += usage.reasoning ?? 0;
  draft.costs.input += usage.cost.input;
  draft.costs.output += usage.cost.output;
  draft.costs.cacheRead += usage.cost.cacheRead;
  draft.costs.cacheWrite += usage.cost.cacheWrite;
  const model = draft.models.get(key) ?? { key, cost: 0, calls: 0, tokens: 0 };
  model.cost += cost;
  model.tokens += tokensOf(usage);
  draft.models.set(key, model);
  if (!call) return;
  draft.calls++;
  model.calls++;
  if (ms === null) return;
  const bucket = callTimeBucket(ms);
  draft.callTime[bucket] = (draft.callTime[bucket] ?? 0) + 1;
  if (stopReason === "error") draft.failed++;
  if (stopReason === "aborted") draft.aborted++;
}

const dayRows = (days: Map<string, DayDraft>): DayRow[] =>
  [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-DAYS_MAX)
    .map(([day, { models, ...d }]) => ({ day, ...d, models: foldDayModels(models) }));

function foldModels(rows: Map<string, ModelRow>): ModelRow[] {
  const sorted = [...rows.values()].filter((r) => r.cost > 0 || r.tokens > 0).sort((a, b) => b.cost - a.cost);
  if (sorted.length <= MODELS_MAX) return sorted;
  const head = sorted.slice(0, MODELS_MAX - 1);
  const other = newModelRow(OTHER_KEY);
  for (const r of sorted.slice(MODELS_MAX - 1)) {
    other.cost += r.cost;
    other.tokens += r.tokens;
    other.calls += r.calls;
    other.input += r.input;
    other.output += r.output;
    other.cacheRead += r.cacheRead;
    other.cacheWrite += r.cacheWrite;
    other.timed += r.timed;
    other.ms += r.ms;
    other.timedOutput += r.timedOutput;
    other.failed += r.failed;
  }
  return [...head, other];
}

function foldDayModels(models: Map<string, DayModel>): DayModel[] {
  const rows = [...models.values()].filter((m) => m.cost > 0 || m.tokens > 0).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  if (rows.length <= DAY_MODELS_MAX) return rows;
  const other: DayModel = { key: OTHER_KEY, cost: 0, calls: 0, tokens: 0 };
  for (const r of rows.slice(DAY_MODELS_MAX - 1)) {
    other.cost += r.cost;
    other.calls += r.calls;
    other.tokens += r.tokens;
  }
  return [...rows.slice(0, DAY_MODELS_MAX - 1), other];
}

function addHour(hours: Map<number, HourRow>, at: number, { usage, call }: Sample): void {
  const hour = Math.floor(at / HOUR_MS);
  const row = hours.get(hour) ?? { hour, calls: 0, tokens: 0, cost: 0 };
  row.tokens += tokensOf(usage);
  row.cost += usage.cost.total;
  if (call) row.calls++;
  hours.set(hour, row);
}

function newTurn(n: number, at: number, prompt: string): TurnDraft {
  return {
    n,
    at,
    endAt: at,
    prompt,
    calls: 0,
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    callCosts: [],
    tools: [],
    models: [],
    ms: 0,
    timedOutput: 0,
    toolCounts: new Map(),
  };
}

function finishTurn({ toolCounts, ...turn }: TurnDraft): TurnRow {
  const tools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TURN_TOOLS_MAX)
    .map(([name, count]) => ({ name, count }));
  return { ...turn, tools };
}

function countTools(turn: TurnDraft, content: string | Block[] | undefined): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "toolCall" && typeof block.name === "string") {
      turn.toolCounts.set(block.name, (turn.toolCounts.get(block.name) ?? 0) + 1);
    }
  }
}

export interface ReportOptions {
  /** Count only entries from this time on: a forked session's `forkedAt`. */
  countFrom?: number | null;
  /** The IANA zone whose calendar days `days` uses; the process zone when undefined. */
  timeZone?: string;
}

export function buildReport(
  entries: readonly EntryLike[],
  context: UsageReport["context"] | undefined,
  opts: ReportOptions = {},
): UsageReport {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const cost: CostParts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const models = new Map<string, ModelRow>();
  const series: UsageReport["series"] = [];
  const turns: TurnRow[] = [];
  const days = new Map<string, DayDraft>();
  const utcDays = new Map<string, DayDraft>();
  const hours = new Map<number, HourRow>();
  const countFrom = opts.countFrom ?? null;
  let turn: TurnDraft | null = null;
  let turnCount = 0;
  let calls = 0;
  let lastTurnCost = 0;
  let estimated = false;
  let started = false;
  let startedAt = 0;
  let updatedAt = 0;

  for (const item of entries) {
    const entry = item as Loose & EntryLike;
    const parsed = Date.parse(entry.timestamp);
    if (countFrom !== null && parsed < countFrom) continue;
    const at = Number.isFinite(parsed) ? parsed : updatedAt;
    if (!started) {
      started = true;
      startedAt = at;
    }
    updatedAt = at;

    if (entry.type === "message" && entry.message?.role === "user") {
      lastTurnCost = 0;
      if (turn) turns.push(finishTurn(turn));
      turnCount++;
      turn = newTurn(turnCount, at, promptExcerpt(entry.message.content));
      dayDraft(days, dayKey(at, opts.timeZone)).prompts++;
      dayDraft(utcDays, dayKey(at, "UTC")).prompts++;
      continue;
    }
    const counted = classify(entry);
    if (!counted) continue;
    const { usage, key, call, durationMs, stopReason } = counted;
    const ms = call && typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
    const sample: Sample = { key, usage, call, ms, stopReason };

    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite;
    tokens.reasoning += usage.reasoning ?? 0;
    cost.input += usage.cost.input;
    cost.output += usage.cost.output;
    cost.cacheRead += usage.cost.cacheRead;
    cost.cacheWrite += usage.cost.cacheWrite;
    cost.total += usage.cost.total;
    lastTurnCost += usage.cost.total;
    if (usage.estimated === true && usage.cost.total > 0) estimated = true;

    const row = models.get(key) ?? newModelRow(key);
    row.cost += usage.cost.total;
    row.tokens += tokensOf(usage);
    row.input += usage.input;
    row.output += usage.output;
    row.cacheRead += usage.cacheRead;
    row.cacheWrite += usage.cacheWrite;
    const current: TurnDraft = turn ?? (turn = newTurn(0, at, ""));
    if (ms !== null) {
      row.timed++;
      row.ms += ms;
      row.timedOutput += usage.output;
      if (stopReason === "error") row.failed++;
      current.ms += ms;
      current.timedOutput += usage.output;
    }
    models.set(key, row);

    current.endAt = at;
    current.cost += usage.cost.total;
    current.tokens.input += usage.input;
    current.tokens.output += usage.output;
    current.tokens.cacheRead += usage.cacheRead;
    current.tokens.cacheWrite += usage.cacheWrite;

    addDay(dayDraft(days, dayKey(at, opts.timeZone)), sample);
    addDay(dayDraft(utcDays, dayKey(at, "UTC")), sample);
    addHour(hours, at, sample);

    if (call) {
      row.calls++;
      calls++;
      series.push({ at, cost: usage.cost.total, tokens: tokensOf(usage), turn: current.n });
      current.calls++;
      current.callCosts.push(usage.cost.total);
      if (current.callCosts.length > CALL_COSTS_MAX) current.callCosts.shift();
      if (!current.models.includes(key) && current.models.length < TURN_MODELS_MAX) current.models.push(key);
      countTools(current, entry.message?.content);
    }
  }
  if (turn) turns.push(finishTurn(turn));

  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return {
    ...(entries.some(e => e.agentId) ? { agents: {
      coverage: "partial" as const,
      rows: [...new Set(entries.flatMap(e => e.agentId ? [e.agentId] : []))].map(id => {
        const r = buildReport(entries.filter(e => e.agentId === id).map(({agentId, ...e}) => e), null, opts);
        return { id, calls: r.calls, cost: r.cost, estimated: r.estimated };
      }),
    } } : {}),
    version: REPORT_VERSION,
    startedAt,
    updatedAt,
    calls,
    lastTurnCost,
    tokens,
    cost,
    cacheHitPct: prompt > 0 ? (tokens.cacheRead / prompt) * 100 : null,
    context: context ?? null,
    byModel: foldModels(models),
    series: series.slice(-SERIES_MAX),
    turnCount,
    turns: turns.slice(-TURNS_MAX),
    days: dayRows(days),
    utcDays: dayRows(utcDays),
    hours: [...hours.values()].sort((a, b) => a.hour - b.hour).slice(-HOURS_MAX),
    running: false,
    budget: null,
    stoppedAt: null,
    estimated,
  };
}
