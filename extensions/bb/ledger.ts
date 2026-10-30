import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { listCost, priceOf } from "../../src/prices.js";
import { type CostParts, type EntryLike, promptExcerpt, type TokenParts } from "../../src/report.js";
import type { Harness } from "./harnesses.js";

export type EventRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
type RowOf<T extends EventRow["type"]> = Extract<EventRow, { type: T }>;

/** The thread events a ledger reads: who asked for each turn, and what each session used and cost. */
export const USAGE_EVENTS = ["client/turn/requested", "turn/started", "thread/tokenUsage/updated", "thread/contextWindowUsage/updated"] as const;

/** A session's token counts as its provider bridge gives them to bb. */
export type Totals = RowOf<"thread/tokenUsage/updated">["data"]["tokenUsage"]["total"];

export type SplitTokens = TokenParts & { reasoning: number };

/** What one usage event added to a thread; `model` is the bare id the latest request named. */
export type LedgerRecord =
  | { kind: "prompt"; at: number; text: string }
  | { kind: "tokens"; at: number; session: string; model: string; tokens: SplitTokens; single: boolean }
  | { kind: "cost"; at: number; session: string; model: string; usd: number };

export interface SessionState {
  total: Totals | null;
  /** The session's latest cumulative cost in dollars. */
  usd: number | null;
  /** The harness recorded a cost for the session, so its tokens are never priced. */
  costed: boolean;
}

export interface LedgerState {
  /** The seq of the last usage event read. */
  afterSeq: number | null;
  /** When the newest change a report reads arrived. */
  at: number | null;
  model: string | null;
  sessions: Record<string, SessionState>;
  /** Native child turns share the parent provider id in BB; their counters do not. */
  childTurns?: Record<string, string>;
}

export interface Ledger {
  state: LedgerState;
  records: LedgerRecord[];
}

export const newLedger = (): Ledger => ({ state: { afterSeq: null, at: null, model: null, sessions: {} }, records: [] });

const UNKNOWN_MODEL = "unknown";
const FIELDS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

const same = (a: Totals, b: Totals): boolean => FIELDS.every((f) => a[f] === b[f]);
const isZero = (t: Totals): boolean => FIELDS.every((f) => (t[f] ?? 0) === 0);

function minus(a: Totals, b: Totals): Totals {
  const out: Totals = { ...a };
  for (const f of FIELDS) {
    const value = a[f];
    if (value !== undefined) out[f] = Math.max(0, value - (b[f] ?? 0));
  }
  return out;
}

const sessionOf = (state: LedgerState, id: string): SessionState =>
  (Object.hasOwn(state.sessions, id) ? state.sessions[id] : undefined) ?? { total: null, usd: null, costed: false };

/**
 * What a session's new total adds. Bridges that sum `last` in worker memory
 * start again from zero when the worker restarts, so a lower total, or one equal
 * to its own last call after a larger one, counts in full.
 */
function addedBy(prev: Totals | null, total: Totals, last: Totals): Totals {
  if (prev === null) return total;
  const restarted = total.totalTokens < prev.totalTokens || (prev.totalTokens > 0 && same(total, last) && !same(total, prev));
  return restarted ? total : minus(total, prev);
}

/** bb's token counts as Burn's kinds. Reasoning is shown, never priced: it is part of output. */
export function splitTokens(t: Totals, inCache: boolean | null): SplitTokens {
  const cacheWrite = t.cacheWriteInputTokens ?? 0;
  const cacheRead = t.cacheReadInputTokens ?? Math.max(0, t.cachedInputTokens - cacheWrite);
  const inside =
    inCache ?? (t.totalTokens > 0 && cacheRead + cacheWrite > 0 && t.totalTokens < t.inputTokens + t.outputTokens + cacheRead + cacheWrite);
  return {
    input: inside ? Math.max(0, t.inputTokens - cacheRead - cacheWrite) : t.inputTokens,
    output: t.outputTokens,
    cacheRead,
    cacheWrite,
    reasoning: t.reasoningOutputTokens,
  };
}

/** Folds one event into the state; true when it changed what a report reads. */
function fold(state: LedgerState, row: EventRow, harness: Harness, out: LedgerRecord[]): boolean {
  switch (row.type) {
    case "turn/started": {
      if (harness.separateChildCounters && row.scope.kind === "turn" && row.data.parentToolCallId) {
        state.childTurns ??= {};
        state.childTurns[row.scope.turnId] = row.data.parentToolCallId;
      }
      return false;
    }
    case "client/turn/requested": {
      const { data } = row;
      state.model = data.execution.model;
      // bb's own notices and steers into a running turn are not prompts; counting them would split turns.
      if (data.initiator === "system" || data.target.kind === "steer") return false;
      // Plugins add agent-only blocks, such as instructions, that the user never typed.
      const seen = data.input.filter((block) => !("visibility" in block && block.visibility === "agent-only"));
      out.push({ kind: "prompt", at: row.createdAt, text: promptExcerpt(seen) });
      return true;
    }
    case "thread/tokenUsage/updated": {
      const { providerThreadId, tokenUsage } = row.data;
      const child = row.scope.kind === "turn" ? state.childTurns?.[row.scope.turnId] : undefined;
      const id = child ? `${providerThreadId}:child:${child}` : providerThreadId;
      const session = sessionOf(state, id);
      const added = addedBy(session.total, tokenUsage.total, tokenUsage.last);
      state.sessions[id] = { ...session, total: tokenUsage.total };
      if (isZero(added)) return false;
      out.push({
        kind: "tokens",
        at: row.createdAt,
        session: id,
        model: state.model ?? UNKNOWN_MODEL,
        tokens: splitTokens(added, harness.cacheInInput),
        single: same(added, tokenUsage.last),
      });
      return true;
    }
    case "thread/contextWindowUsage/updated": {
      const { providerThreadId, contextWindowUsage } = row.data;
      const child = row.scope.kind === "turn" ? state.childTurns?.[row.scope.turnId] : undefined;
      const id = child ? `${providerThreadId}:child:${child}` : providerThreadId;
      const { cost } = contextWindowUsage;
      if (cost === undefined) return false;
      const session = sessionOf(state, id);
      const usd = cost.currency === "USD";
      // A session's cost is cumulative; a drop means it started again.
      const gain = !usd ? 0 : session.usd === null || cost.amount < session.usd ? cost.amount : cost.amount - session.usd;
      state.sessions[id] = { ...session, usd: usd ? cost.amount : session.usd, costed: true };
      if (gain > 0) out.push({ kind: "cost", at: row.createdAt, session: id, model: state.model ?? UNKNOWN_MODEL, usd: gain });
      return gain > 0 || !session.costed;
    }
    default:
      return false;
  }
}

/**
 * Folds new events, oldest first, into the ledger. Returns the records they
 * added, or null when nothing a report reads changed; a session that first
 * records a cost is a change without a record.
 */
export function addRows(ledger: Ledger, rows: readonly EventRow[], harness: Harness): LedgerRecord[] | null {
  const { state } = ledger;
  const added: LedgerRecord[] = [];
  let changed = false;
  for (const row of rows) {
    if (state.afterSeq !== null && row.seq <= state.afterSeq) continue;
    state.afterSeq = row.seq;
    if (fold(state, row, harness, added)) {
      changed = true;
      state.at = row.createdAt;
    }
  }
  ledger.records.push(...added);
  return changed ? added : null;
}

const zeroCost = (): CostParts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

/**
 * The ledger as session log entries for buildReport. Tokens are priced here, not
 * when they arrive, so a cost that arrives later replaces their estimate.
 */
export function ledgerEntries(ledger: Ledger, providerId: string, harness: Harness): EntryLike[] {
  const { state } = ledger;
  return ledger.records.map((record) => {
    const timestamp = new Date(record.at).toISOString();
    switch (record.kind) {
      case "prompt":
        return { type: "message", timestamp, message: { role: "user", content: record.text } };
      case "tokens": {
        const { prices } = harness;
        const price = prices === null || sessionOf(state, record.session).costed ? null : priceOf(prices, record.model);
        const cost = price === null ? zeroCost() : listCost(price, record.tokens, { tiers: harness.perCall && record.single });
        const usage = { ...record.tokens, cost, estimated: price !== null };
        return { type: "message", timestamp, ...(record.session.includes(":child:") ? {agentId: record.session} : {}), message: { role: "assistant", provider: providerId, model: record.model, usage } };
      }
      case "cost": {
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { ...zeroCost(), total: record.usd } };
        return { type: "usage", timestamp, ...(record.session.includes(":child:") ? {agentId: record.session} : {}), provider: providerId, model: record.model, usage };
      }
    }
  });
}
