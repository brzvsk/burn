import { type ComponentPropsWithoutRef, type ReactNode, useEffect, useState } from "react";
import { budgetFraction, budgetState } from "../../src/budget.js";
import {
  formatAgo,
  formatAmount,
  formatBudget,
  formatClock,
  formatDelta,
  formatDuration,
  formatSpeed,
  formatUsd,
  isTokenOnly,
  modelName,
  usageLabel,
} from "../../src/format.js";
import { outputPerSec, type UsageReport } from "../../src/report.js";
import { agentLabel, CostBreakdown } from "./agents.js";
import { BudgetEditor } from "./budget-editor.js";
import { budgetWords, type EffectiveBudget } from "./budgets.js";
import { CallChart, callPoints, Meter, StackedBar } from "./charts.js";
import { Button } from "./components/ui/button.js";
import type { UsageAnswer } from "./contract.js";
import { CheckIcon, CopyIcon, FlameIcon, GaugeIcon, PanelIcon } from "./icon.js";
import { cn } from "./lib/utils.js";

export function Label({ children, aside }: { children: ReactNode; aside?: ReactNode }): ReactNode {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">
      <span>{children}</span>
      {aside !== undefined ? <span className="font-medium tracking-normal normal-case">{aside}</span> : null}
    </div>
  );
}

export function WaitingNotice(): ReactNode {
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="waiting">
      <div className="font-semibold">Waiting for the first model call</div>
      <p className="text-muted-foreground">
        Burn shows a thread's cost after its first model call: from pi's session log in pi threads, from opencode's database in OpenCode threads, and from the usage bb records for other harnesses.
        Claude Code reports as each turn ends.
      </p>
    </div>
  );
}

export function EstimatedNote(): ReactNode {
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="estimated">
      ~ Estimated from list prices: this harness records no cost.
    </p>
  );
}

export function DiscountNote(): ReactNode {
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="discounted">
      After the discounts in Burn's settings.
    </p>
  );
}

export function StoppedNotice({ stoppedAt, budget }: { stoppedAt: number; budget: EffectiveBudget | null }): ReactNode {
  const at = budget === null ? "its budget" : `the ${formatBudget(budget.amount)} budget`;
  return (
    <p role="note" className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive-text">
      Burn stopped a run at {at} at {formatClock(stoppedAt)}. Send another prompt to keep going.
    </p>
  );
}

const TONE_FILL = { none: "bg-success", ok: "bg-success", near: "bg-warning", over: "bg-destructive" } as const;

/** The budget bar with its share and what is left, or "No budget" with a button to set one. */
export function BudgetStatus({ cost, budget, onSet }: { cost: number; budget: EffectiveBudget | null; onSet?: () => void }): ReactNode {
  if (budget === null) {
    return (
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>No budget</span>
        {onSet !== undefined ? (
          <Button variant="ghost" className="h-6 px-2" onClick={onSet}>
            Set budget
          </Button>
        ) : null}
      </div>
    );
  }
  const words = budgetWords(cost, budget);
  return (
    <div className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground tabular-nums" data-testid="budget-status">
      <Meter fraction={budgetFraction(cost, budget.amount) ?? 0} fill={TONE_FILL[budgetState(cost, budget.amount)]} />
      <div className="flex justify-between gap-2">
        <span>{words.share}</span>
        <span>{words.left}</span>
      </div>
    </div>
  );
}

export const KIND_COLOURS = {
  input: "bg-timeline-accent",
  cacheRead: "bg-success",
  cacheWrite: "bg-attention",
  output: "bg-pr-merged",
} as const;

const KINDS = [
  ["input", "Input"],
  ["cacheWrite", "Cache write"],
  ["cacheRead", "Cache read"],
  ["output", "Output"],
] as const;

/** "Where it went": cost by token kind as one bar and a two-column legend. */
export function WhereItWent({ report }: { report: UsageReport }): ReactNode {
  const { cost } = report;
  const pct = (n: number): string => (cost.total > 0 ? `${Math.round((n / cost.total) * 100)}%` : "–");
  return (
    <div data-testid="where-it-went">
      <Label aside={report.cacheHitPct !== null ? `cache hit ${report.cacheHitPct.toFixed(0)}%` : undefined}>Where it went</Label>
      <StackedBar parts={(["input", "cacheRead", "cacheWrite", "output"] as const).map((k) => ({ key: k, value: cost[k], className: KIND_COLOURS[k] }))} />
      <div className="mt-2 grid grid-cols-2 gap-x-3.5 gap-y-1 text-xs">
        {KINDS.map(([key, label]) => (
          // The label gives way before the figures do: a wider UI font (a monospace theme, say) must not push the row past the card.
          <div key={key} className="flex min-w-0 items-center gap-1.5">
            <i className={cn("size-2 shrink-0 rounded-[2px]", KIND_COLOURS[key])} />
            <span className="truncate" title={label}>
              {label}
            </span>
            <span className="ml-auto shrink-0 tabular-nums">{formatUsd(cost[key])}</span>
            <span className="w-7 shrink-0 text-right text-muted-foreground tabular-nums">{pct(cost[key])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Models({ report }: { report: UsageReport }): ReactNode {
  if (report.byModel.length === 0) return null;
  const top = Math.max(...report.byModel.map((m) => m.cost)) || 1;
  return (
    <div data-testid="models">
      <Label>Models</Label>
      {report.byModel.map((m) => {
        const speed = outputPerSec(m);
        return (
          <div key={m.key} className="grid grid-cols-[1fr_auto_3rem] items-center gap-2 py-0.5 text-xs">
            {/* The name gives way before the calls and speed do; the title keeps it whole. */}
            <span className="flex min-w-0 items-baseline gap-1" title={m.key}>
              <span className="truncate">{modelName(m.key)}</span>
              {m.calls > 0 ? (
                <small className="shrink-0 text-muted-foreground tabular-nums">
                  {m.calls} calls{speed !== null ? ` · ${formatSpeed(speed)}` : ""}
                </small>
              ) : null}
            </span>
            <Meter fraction={m.cost / top} fill="bg-timeline-accent" className="h-1 w-16" />
            <span className="text-right tabular-nums">{formatUsd(m.cost)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** "$49.97 with 3 child threads", when any child thread has cost something. */
export function familyLine(answer: UsageAnswer): string | null {
  const { family, report } = answer;
  const count = family.children.length;
  if (count === 0 || report === null || family.total <= report.cost.total) return null;
  return `${formatAmount(family.total, family.estimated)} with ${count} child ${count === 1 ? "thread" : "threads"}`;
}

const updatedText = (answer: UsageAnswer | null, now: number): string =>
  answer?.reportedAt == null ? "not reported yet" : `updated ${formatAgo(answer.reportedAt, now)} ago`;

const meta = (report: UsageReport): string =>
  report.calls === 0
    ? "No model calls yet"
    : `${report.calls} calls · ${report.turnCount} prompts · ${formatDuration(report.updatedAt - report.startedAt)}`;

/** A quiet toolbar button: an icon and a short label in small muted text. */
export function ActionButton({ icon, children, className, ...props }: ComponentPropsWithoutRef<"button"> & { icon: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 min-w-0 items-center justify-center gap-1.5 px-2 text-[11px] font-medium whitespace-nowrap text-muted-foreground transition-colors",
        "hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground focus-visible:outline-none",
        "aria-expanded:bg-state-hover aria-expanded:text-foreground",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

const COPIED_MS = 1500;

/** Swaps to "Copied" with a check for a moment after a copy that worked. */
export function useCopied(): [boolean, (copy: () => Promise<boolean>) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return [copied, (copy) => void copy().then((ok) => setCopied(ok))];
}

/** The copy action on its own, as the Burn tab shows it. */
export function CopyAction({ onCopy }: { onCopy: () => Promise<boolean> }): ReactNode {
  const [copied, copy] = useCopied();
  return (
    <ActionButton
      className="h-7 rounded-md border border-border"
      icon={copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      onClick={() => copy(onCopy)}
    >
      {copied ? "Copied" : "Copy cost summary"}
    </ActionButton>
  );
}

export interface BurnCardProps {
  answer: UsageAnswer | null;
  threadId: string;
  defaultBudget: number | null;
  /** Some discount in Burn's settings is not 0. */
  discounted: boolean;
  now: number;
  onOpenDetails: () => void;
  onCopy: () => Promise<boolean>;
}

/** The chip's popover: what the thread cost, against its budget, where it went and on which models. */
export function BurnCard({ answer, threadId, defaultBudget, discounted, now, onOpenDetails, onCopy }: BurnCardProps): ReactNode {
  const [editing, setEditing] = useState(false);
  const [copied, copy] = useCopied();
  const report = answer?.report ?? null;
  const budget = answer?.budget ?? null;
  const editor = editing ? (
    <div className="border-t border-border px-3 py-2.5">
      <BudgetEditor threadId={threadId} budget={budget} defaultBudget={defaultBudget} autoFocus onDone={() => setEditing(false)} />
    </div>
  ) : null;
  const points = report ? callPoints(report) : [];
  const updated = updatedText(answer, now);
  const withChildren = answer ? familyLine(answer) : null;
  return (
    <div className="flex w-[340px] max-w-full flex-col text-xs" data-testid="burn-card">
      <div className="flex items-center justify-between px-3 pt-2.5 text-[11.5px] text-muted-foreground">
        <span className="flex items-center gap-1.5 font-semibold text-foreground">
          <FlameIcon className="text-warning" />
          Burn
        </span>
        <span>{updated}</span>
      </div>
      {report === null ? (
        <div className="px-3 py-2.5">
          <WaitingNotice />
        </div>
      ) : (
        <>
          <div className="px-3 py-2.5">
            <div className="flex items-baseline gap-2.5">
              <CostBreakdown answer={answer!}><span className="text-[26px] leading-tight font-semibold tracking-tight tabular-nums">{usageLabel(report)}</span></CostBreakdown>
              {!isTokenOnly(report) && report.lastTurnCost > 0 ? (
                <span className="rounded-full bg-success/15 px-1.5 py-px text-[11.5px] font-semibold text-success tabular-nums">
                  {formatDelta(answer?.family.lastTurnCost ?? report.lastTurnCost)} last turn
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-muted-foreground tabular-nums">{meta(report)}</div>
            {report.estimated ? <EstimatedNote /> : null}
            {discounted && !isTokenOnly(report) ? <DiscountNote /> : null}
            {withChildren !== null ? (
              <div className="text-muted-foreground tabular-nums" data-testid="with-children">
                {withChildren}
              </div>
            ) : null}
            <div className="mt-1 text-[11px] text-muted-foreground tabular-nums" data-testid="agents-line">
              Subagents · {agentLabel(report.agents)}
            </div>
            {isTokenOnly(report) ? null : <BudgetStatus cost={report.cost.total} budget={budget} onSet={() => setEditing(true)} />}
            {report.stoppedAt !== null ? (
              <div className="mt-2">
                <StoppedNotice stoppedAt={report.stoppedAt} budget={budget} />
              </div>
            ) : null}
          </div>
          {editor}
          {isTokenOnly(report) ? null : (
            <div className="border-t border-border px-3 py-2.5">
              <WhereItWent report={report} />
            </div>
          )}
          {points.length > 0 ? (
            <div className="border-t border-border px-3 pt-2.5 pb-2" data-testid="per-call">
              <Label aside="hover a bar">Per call</Label>
              <CallChart points={points} />
            </div>
          ) : null}
          {report.byModel.length > 0 ? (
            <div className="border-t border-border px-3 py-2.5">
              <Models report={report} />
            </div>
          ) : null}
        </>
      )}
      {report === null ? editor : null}
      <div
        role="toolbar"
        aria-label="Burn actions"
        className={cn("grid divide-x divide-border border-t border-border", report !== null ? "grid-cols-3" : "grid-cols-2")}
      >
        <ActionButton icon={<PanelIcon />} onClick={onOpenDetails}>
          Open details
        </ActionButton>
        <ActionButton icon={<GaugeIcon />} onClick={() => setEditing((on) => !on)} aria-expanded={editing}>
          Set budget…
        </ActionButton>
        {report !== null ? (
          <ActionButton icon={copied ? <CheckIcon className="text-success" /> : <CopyIcon />} onClick={() => copy(onCopy)}>
            {copied ? "Copied" : "Copy summary"}
          </ActionButton>
        ) : null}
      </div>
    </div>
  );
}
