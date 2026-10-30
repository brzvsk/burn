import type { CostParts, DayRow, UsageReport } from "./report.js";

/** Percent off list price per line item; a negative number raises the price. */
export interface Discounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const NO_DISCOUNTS: Discounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const DISCOUNT_MIN = -100;
export const DISCOUNT_MAX = 100;

/**
 * Total minus its parts above this, in dollars, is cost a harness reported as
 * one total. Anything smaller, negative included, is roundoff from adding the
 * totals and the parts separately.
 */
const REMAINDER_MIN = 1e-9;

const KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Some line item is not at list price. */
export const hasDiscounts = (d: Discounts): boolean => KINDS.some((k) => d[k] !== 0);

export const sameDiscounts = (a: Discounts, b: Discounts): boolean => KINDS.every((k) => a[k] === b[k]);

export function discountCost(cost: CostParts, d: Discounts): CostParts {
  const remainder = cost.total - (cost.input + cost.output + cost.cacheRead + cost.cacheWrite);
  const input = cost.input * (1 - d.input / 100);
  const output = cost.output * (1 - d.output / 100);
  const cacheRead = cost.cacheRead * (1 - d.cacheRead / 100);
  const cacheWrite = cost.cacheWrite * (1 - d.cacheWrite / 100);
  const total = input + output + cacheRead + cacheWrite + (remainder > REMAINDER_MIN ? remainder : 0);
  return { input, output, cacheRead, cacheWrite, total };
}

function discountDay(day: DayRow, d: Discounts): DayRow {
  const { total, ...costs } = discountCost({ ...day.costs, total: day.cost }, d);
  const ratio = day.cost > 0 ? total / day.cost : 0;
  return { ...day, cost: total, costs, models: day.models.map((m) => ({ ...m, cost: m.cost * ratio })) };
}

/**
 * The report priced with `d`. The totals, each day and the split by line item
 * are exact; figures that hold only a total (per call, prompt, model and hour)
 * take the report's overall discount.
 */
export function applyDiscounts(report: UsageReport, d: Discounts): UsageReport {
  if (!hasDiscounts(d) || report.cost.total === 0) return report;
  const cost = discountCost(report.cost, d);
  const ratio = cost.total / report.cost.total;
  const scale = (n: number): number => n * ratio;
  return {
    ...report,
    cost,
    lastTurnCost: scale(report.lastTurnCost),
    ...(report.agents ? {agents: {...report.agents, rows: report.agents.rows.map(a => ({...a, cost: discountCost(a.cost, d)}))}} : {}),
    byModel: report.byModel.map((m) => ({ ...m, cost: scale(m.cost) })),
    series: report.series.map((s) => ({ ...s, cost: scale(s.cost) })),
    turns: report.turns.map((t) => ({ ...t, cost: scale(t.cost), callCosts: t.callCosts.map(scale) })),
    days: report.days.map((day) => discountDay(day, d)),
    utcDays: report.utcDays.map((day) => discountDay(day, d)),
    hours: report.hours.map((h) => ({ ...h, cost: scale(h.cost) })),
  };
}
