import { type JsonValue, type PluginThreadPanelProps, useBbNavigate, useSettings } from "@get-bb/plugin-sdk/app";
import { type ReactNode, useState } from "react";
import {
  formatAmount,
  formatBudget,
  formatClock,
  formatDuration,
  formatSpeed,
  formatTokens,
  formatUsd,
  isTokenOnly,
  modelName,
  turnMultiple,
  usageLabel,
} from "../../src/format.js";
import { outputPerSec, reportOutputPerSec, type TurnRow, type UsageReport } from "../../src/report.js";
import { AgentRows, CostBreakdown, agentLabel } from "./agents.js";
import { BudgetEditor } from "./budget-editor.js";
import { BudgetStatus, CopyAction, EstimatedNote, Label, Models, StoppedNotice, WaitingNotice, WhereItWent } from "./card.js";
import { MiniBars } from "./charts.js";
import type { Family, UsageAnswer } from "./contract.js";
import { cn } from "./lib/utils.js";
import { readPrefs } from "./prefs.js";
import { copySummary } from "./summary.js";
import { useUsage } from "./usage.js";

/** A turn at least this many times the median of the others is drawn in the warning tone. */
export const HOT_MULTIPLE = 2;

/** Panel params come back from persistence, so read them defensively. */
export const wantsBudgetFocus = (params: JsonValue | null): boolean =>
  typeof params === "object" && params !== null && !Array.isArray(params) && params.focus === "budget";

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub: string }): ReactNode {
  return (
    <div className="rounded-lg bg-surface-raised px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-px text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function Kpis({ answer, report, atList }: { answer: UsageAnswer; report: UsageReport; atList: boolean }): ReactNode {
  const tokenOnly = isTokenOnly(report);
  const own = report.cost.total;
  const { family, budget } = answer;
  const kids = family.children.length;
  const fromKids = family.total - own;
  const speed = reportOutputPerSec(report);
  const share = budget !== null && !tokenOnly ? `${Math.round((own / budget.amount) * 100)}% of ${formatBudget(budget.amount)} budget` : "No budget";
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2" data-testid="kpis">
      <Kpi label="This thread" value={<CostBreakdown answer={answer} scope="thread">{usageLabel(report)}</CostBreakdown>} sub={atList ? "At list price" : share} />
      {kids > 0 ? (
        <Kpi
          label={`With ${kids} ${kids === 1 ? "child" : "children"}`}
          value={<CostBreakdown answer={answer} scope="family">{formatAmount(family.total, family.estimated)}</CostBreakdown>}
          sub={`+${formatUsd(fromKids)} in children (${family.total > 0 ? Math.round((fromKids / family.total) * 100) : 0}%)`}
        />
      ) : (
        <Kpi label="Children" value="None" sub="No child thread has reported" />
      )}
      <Kpi label="With agents" value={agentLabel(family.agents)} sub={family.agents?.rows.length ? `${family.agents.count ?? family.agents.rows.length} subagents · part of the totals above${family.agents.coverage === "partial" ? " · partial" : ""}` : family.agents?.coverage === "available" ? "No saved subagent usage" : "Source has no complete agent breakdown"} />
      <Kpi
        label="Per call"
        value={report.calls > 0 && !tokenOnly ? formatAmount(own / report.calls, report.estimated) : "—"}
        sub={`${report.calls} calls · ${formatDuration(report.updatedAt - report.startedAt)}`}
      />
      <Kpi label="Cache" value={report.cacheHitPct !== null ? `${report.cacheHitPct.toFixed(0)}%` : "—"} sub="hit rate" />
      <Kpi label="Speed" value={speed !== null ? formatSpeed(speed) : "—"} sub={speed !== null ? "output, timed calls" : "no timed calls"} />
    </div>
  );
}

const promptText = (turn: TurnRow): string => turn.prompt || (turn.n === 0 ? "Before the first prompt" : "(no text)");

function TurnDetail({ turn, multiple }: { turn: TurnRow; multiple: number | null }): ReactNode {
  const hot = multiple !== null && multiple >= HOT_MULTIPLE;
  const peak = turn.callCosts.indexOf(Math.max(...turn.callCosts));
  const partial = turn.calls > turn.callCosts.length;
  const speed = outputPerSec(turn);
  return (
    <div className="grid gap-2 border-t border-border bg-timeline-accent/5 py-2.5 pr-3 pl-10 text-xs" data-testid={`turn-${turn.n}-detail`}>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-muted-foreground">
        <span>
          <b className="font-semibold text-foreground tabular-nums">{turn.calls}</b> calls
        </span>
        <b className="font-semibold text-foreground tabular-nums">{formatDuration(turn.endAt - turn.at)}</b>
        {speed !== null ? <b className="font-semibold text-foreground tabular-nums">{formatSpeed(speed)}</b> : null}
        {turn.models.length > 0 ? <span>{turn.models.map(modelName).join(", ")}</span> : null}
        {hot ? <span className="text-[11px] font-semibold text-warning-text">{multiple.toFixed(1)}× the median turn</span> : null}
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-muted-foreground">
        {(
          [
            ["input", turn.tokens.input],
            ["cache read", turn.tokens.cacheRead],
            ["cache write", turn.tokens.cacheWrite],
            ["output", turn.tokens.output],
          ] as const
        ).map(([label, n]) => (
          <span key={label}>
            {label} <b className="font-semibold text-foreground tabular-nums">{formatTokens(n)}</b>
          </span>
        ))}
      </div>
      {turn.callCosts.length > 0 ? (
        <div className="flex items-end gap-2">
          <MiniBars values={turn.callCosts} hot={hot ? peak : undefined} />
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {partial ? `last ${turn.callCosts.length}: ` : ""}
            {turn.callCosts.map(formatUsd).join(" · ")}
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {turn.tools.length > 0 ? (
          turn.tools.map((t) => (
            <span key={t.name} className="rounded-[5px] bg-state-hover px-1.5 py-px font-mono text-[11px]">
              {t.name} ×{t.count}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">no tools</span>
        )}
      </div>
    </div>
  );
}

function Turns({ report }: { report: UsageReport }): ReactNode {
  const [order, setOrder] = useState<"newest" | "costliest">("newest");
  const [open, setOpen] = useState<number | null>(null);
  const turns = report.turns;
  if (turns.length === 0) {
    return (
      <section>
        <Label>Turns</Label>
        <p className="text-xs text-muted-foreground">No prompts yet.</p>
      </section>
    );
  }
  const rows = order === "newest" ? [...turns].reverse() : [...turns].sort((a, b) => b.cost - a.cost || b.n - a.n);
  const top = Math.max(...turns.map((t) => t.cost)) || 1;
  const segment = (value: "newest" | "costliest", label: string) => (
    <button
      type="button"
      aria-pressed={order === value}
      onClick={() => setOrder(value)}
      className={cn("rounded-[5px] px-2 py-0.5", order === value ? "bg-state-hover text-foreground" : "text-muted-foreground")}
    >
      {label}
    </button>
  );
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label aside={report.turnCount > turns.length ? `last ${turns.length} of ${report.turnCount}` : undefined}>Turns</Label>
        <span className="inline-flex rounded-md bg-surface-recessed p-0.5 text-[11.5px]" role="group" aria-label="Order turns by">
          {segment("newest", "Newest")}
          {segment("costliest", "Costliest")}
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border" data-testid="turns">
        {rows.map((turn, i) => {
          const multiple = turnMultiple(turn, turns);
          const hot = multiple !== null && multiple >= HOT_MULTIPLE;
          const expanded = open === turn.n;
          return (
            <div key={turn.n} className={cn(i > 0 && "border-t border-border")}>
              <button
                type="button"
                aria-expanded={expanded}
                data-turn={turn.n}
                data-hot={hot ? "" : undefined}
                onClick={() => setOpen(expanded ? null : turn.n)}
                className={cn(
                  "grid w-full grid-cols-[1.25rem_2.75rem_minmax(0,1fr)_3.5rem_4.5rem] items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-state-hover",
                  expanded && "bg-timeline-accent/10",
                )}
              >
                <span className="text-muted-foreground tabular-nums">{turn.n}</span>
                <span className="text-muted-foreground tabular-nums">{formatClock(turn.at)}</span>
                <span className="truncate" title={turn.prompt}>
                  {promptText(turn)}
                </span>
                <span className="text-right font-semibold tabular-nums">{formatUsd(turn.cost)}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-state-hover">
                  <i className={cn("block h-full rounded-full", hot ? "bg-warning" : "bg-success")} style={{ width: `${(turn.cost / top) * 100}%` }} />
                </span>
              </button>
              {expanded ? <TurnDetail turn={turn} multiple={multiple} /> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Discounted figures or list price, shown only while some discount is set. */
function PriceSwitch({ atList, onChange }: { atList: boolean; onChange: (atList: boolean) => void }): ReactNode {
  const segment = (value: boolean, label: string) => (
    <button
      type="button"
      aria-pressed={atList === value}
      onClick={() => onChange(value)}
      className={cn("rounded-[5px] px-2 py-0.5", atList === value ? "bg-state-hover text-foreground" : "text-muted-foreground")}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex self-start rounded-md bg-surface-recessed p-0.5 text-[11.5px]" role="group" aria-label="Prices">
        {segment(false, "With discounts")}
        {segment(true, "List price")}
      </span>
      <p className="text-[11px] text-muted-foreground" data-testid="price-note">
        {atList ? "List price, without your discounts. Budgets use the discounted figures." : "After the discounts in Burn's settings."}
      </p>
    </div>
  );
}

function Dot({ running }: { running: boolean }): ReactNode {
  return running ? (
    <i aria-label="running" data-burn-running-dot="" className="ml-1 size-2 rounded-full bg-timeline-accent text-timeline-accent" />
  ) : (
    <i aria-hidden="true" className="ml-1 size-2 rounded-full bg-muted-foreground" />
  );
}

function FamilyList({ answer, report, onOpen }: { answer: UsageAnswer; report: UsageReport; onOpen: (threadId: string) => void }): ReactNode {
  const family: Family = answer.family;
  if (family.children.length === 0 && !report.agents?.rows.length) return null;
  const top = report.byModel[0]?.key;
  const row = "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto_3.75rem] items-center gap-2 px-2.5 py-1.5 text-left";
  return (
    <section>
      <Label aside="live">This thread and its children</Label>
      <div className="overflow-hidden rounded-lg border border-border text-[12.5px]" data-testid="family">
        <div className={row}>
          <Dot running={report.running} />
          <span className="truncate">
            {answer.title ?? "This thread"}
            <span className="text-[11.5px] text-muted-foreground">
              {" "}
              · this thread{top !== undefined ? ` · ${modelName(top)}` : ""}
            </span>
          </span>
          <span className="text-[11.5px] text-muted-foreground tabular-nums">{report.calls} calls</span>
          <span className="text-right font-semibold tabular-nums">{usageLabel(report)}</span>
        </div>
        <AgentRows agents={report.agents} />
        {family.children.map((child) => (
          <div key={child.threadId}><button
            key={child.threadId}
            type="button"
            onClick={() => onOpen(child.threadId)}
            className={cn(row, "border-t border-border hover:bg-state-hover")}
            aria-label={`Open ${child.title}, ${formatAmount(child.cost, child.estimated)}`}
          >
            <Dot running={child.running} />
            <span className="truncate">
              {child.title}
              <span className="text-[11.5px] text-muted-foreground">
                {" "}
                · child{child.model !== null ? ` · ${modelName(child.model)}` : ""}
                {child.running ? "" : " · idle"}
              </span>
            </span>
            <span className="text-[11.5px] text-muted-foreground tabular-nums">{child.calls} calls</span>
            <span className="text-right font-semibold tabular-nums">{formatAmount(child.cost, child.estimated)}</span>
          </button><AgentRows agents={child.agents} /></div>
        ))}
        <div className={cn(row, "border-t border-border bg-surface-recessed font-semibold")} data-testid="family-total">
          <span />
          <span>Total</span>
          <span className="text-[11.5px] font-normal text-muted-foreground tabular-nums">{family.calls} calls</span>
          <span className="text-right tabular-nums">{formatAmount(family.total, family.estimated)}</span>
        </div>
      </div>
    </section>
  );
}

/** The Burn tab in a thread's side panel: every turn, child threads and the budget. */
export function BurnPanel({ threadId, params }: PluginThreadPanelProps): ReactNode {
  const prefs = readPrefs(useSettings().values);
  const navigate = useBbNavigate();
  const [listPrice, setListPrice] = useState(false);
  const atList = prefs.discounted && listPrice;
  const { answer, error } = useUsage(threadId, { withChildren: true, listPrice: atList });
  const report = answer?.report ?? null;
  const budget = answer?.budget ?? null;
  const prices = prefs.discounted ? <PriceSwitch atList={atList} onChange={setListPrice} /> : null;
  if (answer === null) {
    const loading = <p className="text-xs text-muted-foreground">{error !== null ? `Loading Burn's figures failed: ${error}` : "Loading…"}</p>;
    // The switch stays while its answer loads, so the segment just pressed keeps focus.
    return prices === null ? (
      loading
    ) : (
      <div className="flex flex-col gap-4 text-xs">
        {prices}
        {loading}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 text-xs" data-testid="burn-panel">
      {prices}
      {report === null ? <WaitingNotice /> : <Kpis answer={answer} report={report} atList={atList} />}
      {report?.coverageNote ? <p className="text-xs text-warning-text">{report.coverageNote}</p> : null}
      {report?.estimated ? <EstimatedNote /> : null}
      {report?.stoppedAt != null ? <StoppedNotice stoppedAt={report.stoppedAt} budget={budget} /> : null}
      {report !== null ? <Turns report={report} /> : null}
      {report !== null ? <FamilyList answer={answer} report={report} onOpen={(id) => navigate.toThread(id)} /> : null}
      <section data-testid="panel-budget">
        <Label>Budget</Label>
        {report !== null && !isTokenOnly(report) && !atList ? <BudgetStatus cost={report.cost.total} budget={budget} /> : null}
        <div className="mt-2">
          <BudgetEditor
            key={`${budget?.source ?? "none"}:${budget?.amount ?? ""}`}
            threadId={threadId}
            budget={budget}
            defaultBudget={prefs.threadBudget}
            autoFocus={wantsBudgetFocus(params)}
          />
        </div>
      </section>
      {report !== null && !isTokenOnly(report) ? <WhereItWent report={report} /> : null}
      {report !== null ? <Models report={report} /> : null}
      {report !== null ? (
        <div>
          <CopyAction onCopy={() => copySummary(report, answer.title, budget)} />
        </div>
      ) : null}
    </div>
  );
}
