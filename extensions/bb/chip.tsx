import { type PluginThreadHeaderActionProps, useBbNavigate, useSettings } from "@get-bb/plugin-sdk/app";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { budgetFraction, budgetState } from "../../src/budget.js";
import { formatAgo, formatBudget, formatCost, formatDelta, formatTokens, isTokenOnly } from "../../src/format.js";
import { BurnCard } from "./card.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import type { UsageAnswer } from "./contract.js";
import { useFooterMount } from "./footer.js";
import { FlameIcon } from "./icon.js";
import { cn } from "./lib/utils.js";
import { openPanelIn, registerPanelOpener } from "./panel-requests.js";
import { readPrefs } from "./prefs.js";
import { copySummary } from "./summary.js";
import { useNow, useUsage } from "./usage.js";

/** A running thread whose report is this old has stopped reporting. */
export const STALE_MS = 5 * 60_000;
const FRESH_MS = 6000;
const FADE_MS = 600;

export type ChipTone = "default" | "near" | "over" | "waiting";

export interface ChipView {
  tone: ChipTone;
  value: string;
  unit: string | null;
  /** The delta, the budget (" / $10") or the age of a report that stopped coming. */
  suffix: { kind: "delta" | "budget" | "age"; text: string } | null;
  /** How far along the budget (at most 1), for the line under a chip near or over it. */
  progress: number | null;
  running: boolean;
  stale: boolean;
  tokenOnly: boolean;
  label: string;
  title: string;
}

const WAITING_TITLE = "Waiting for the first model call. Burn shows the thread's cost once it has used a model.";

/** What the chip shows for an answer; pure so every state can be tested. */
export function chipView(answer: UsageAnswer | null, opts: { now: number; fresh: boolean; chipShows: "delta" | "cost" }): ChipView {
  const report = answer?.report ?? null;
  if (report === null) {
    return {
      tone: "waiting",
      value: "—",
      unit: null,
      suffix: null,
      progress: null,
      running: false,
      stale: false,
      tokenOnly: false,
      label: "Thread cost: waiting for the first model call. Click for details.",
      title: WAITING_TITLE,
    };
  }
  const tokenOnly = isTokenOnly(report);
  const t = report.tokens;
  const value = tokenOnly ? formatTokens(t.input + t.output + t.cacheRead + t.cacheWrite) : formatCost(report);
  const reportedAt = answer?.reportedAt ?? opts.now;
  // A Claude Code turn can run for minutes before bb records its usage, so silence there is not a stall.
  const stale = answer?.source !== "events" && report.running && opts.now - reportedAt >= STALE_MS;
  const budget = answer?.budget?.amount ?? null;
  const state = tokenOnly ? "none" : budgetState(report.cost.total, budget);
  const tone: ChipTone = state === "near" || state === "over" ? state : "default";
  const running = report.running && !stale;
  let suffix: ChipView["suffix"] = null;
  if (stale) suffix = { kind: "age", text: `· ${formatAgo(reportedAt, opts.now)}` };
  else if (tone !== "default" && budget !== null) suffix = { kind: "budget", text: `/ ${formatBudget(budget)}` };
  else if (opts.chipShows === "delta" && !tokenOnly && (running || opts.fresh)) suffix = { kind: "delta", text: formatDelta(answer?.family.lastTurnCost ?? report.lastTurnCost) };
  const total = `${value}${tokenOnly ? " tok" : ""}`;
  const budgetNote = budget !== null && !tokenOnly ? ` of ${formatBudget(budget)}` : "";
  const estimate = report.estimated ? " Estimated from list prices." : "";
  return {
    tone,
    value,
    unit: tokenOnly ? "tok" : null,
    suffix,
    progress: tone === "default" ? null : Math.min(1, budgetFraction(report.cost.total, budget) ?? 0),
    running,
    stale,
    tokenOnly,
    label: `Thread cost ${total}${budgetNote}. Click for the breakdown.`,
    title: stale
      ? `Thread cost ${total}. Burn has seen no new usage for ${formatAgo(reportedAt, opts.now)} while the thread was working.${estimate}`
      : `Thread cost ${total}${budgetNote}${running ? ", the thread is working" : ""}. Click for the breakdown.${estimate}`,
  };
}

/** "in" for a few seconds after the total changes (not on the first report), then "out" while it fades. */
function useFreshness(total: number | null): "in" | "out" | null {
  const [phase, setPhase] = useState<"in" | "out" | null>(null);
  const last = useRef<number | null>(null);
  useEffect(() => {
    const prev = last.current;
    last.current = total;
    if (prev === null || total === null || total === prev) return;
    setPhase("in");
    const fade = setTimeout(() => setPhase("out"), FRESH_MS - FADE_MS);
    const gone = setTimeout(() => setPhase(null), FRESH_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [total]);
  return phase;
}

const TONES: Record<ChipTone, { chip: string; flame: string }> = {
  default: { chip: "bg-state-hover text-foreground", flame: "text-warning" },
  near: { chip: "bg-warning/15 text-warning-text", flame: "text-warning" },
  over: { chip: "bg-destructive/15 text-destructive-text", flame: "text-destructive" },
  waiting: { chip: "border-dashed border-border bg-transparent text-muted-foreground", flame: "text-muted-foreground" },
};

/** "compact" is the flame alone, for a phone's header, where the full chip leaves no room for the title. */
type Placement = "footer" | "header" | "compact";

function ChipFace({ view, fresh, placement }: { view: ChipView; fresh: "in" | "out" | null; placement: Placement }) {
  const tone = TONES[view.tone];
  const suffix = view.suffix;
  const flame = view.tokenOnly ? "text-muted-foreground" : tone.flame;
  if (placement === "compact") return <FlameIcon className={cn("size-4", flame)} />;
  return (
    <>
      <FlameIcon className={flame} />
      <b className="font-semibold">{view.value}</b>
      {view.unit !== null ? <span className="text-muted-foreground">{view.unit}</span> : null}
      {suffix !== null ? (
        <span
          data-suffix={suffix.kind}
          className={cn(
            suffix.kind === "delta" ? "text-muted-foreground" : "opacity-80",
            suffix.kind === "delta" && fresh === "in" && !view.running && "text-success animate-in fade-in-0 slide-in-from-bottom-1 duration-300",
            suffix.kind === "delta" && fresh === "out" && !view.running && "text-success opacity-0 transition-opacity duration-500",
            "motion-reduce:animate-none motion-reduce:transition-none",
          )}
        >
          {suffix.text}
        </span>
      ) : null}
      {view.progress !== null ? (
        <i
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-0.5 bg-current opacity-70"
          style={{ width: `${view.progress * 100}%` }}
        />
      ) : null}
      {view.running ? <span aria-hidden="true" data-burn-shimmer="" data-placement={placement} className="pointer-events-none absolute inset-0" /> : null}
    </>
  );
}

function BurnChip({ threadId, answer, placement }: { threadId: string; answer: UsageAnswer | null; placement: Placement }) {
  const prefs = readPrefs(useSettings().values);
  const navigate = useBbNavigate();
  const now = useNow(30_000);
  const fresh = useFreshness(answer?.report ? answer.report.cost.total + (answer.family.total ?? 0) : null);
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const view = chipView(answer, { now, fresh: fresh !== null, chipShows: prefs.chipShows });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-burn-chip-button=""
          data-placement={placement}
          data-tone={view.tone}
          data-running={view.running ? "" : undefined}
          aria-label={view.label}
          title={view.title}
          className={cn(
            "relative inline-flex shrink-0 cursor-pointer items-center overflow-hidden rounded-full border border-transparent text-xs whitespace-nowrap tabular-nums",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:ring-1 data-[state=open]:ring-ring",
            placement === "compact" ? "size-7 justify-center" : "gap-1 pr-2 pl-1.5",
            placement === "footer" ? "h-5" : placement === "header" && "h-6",
            TONES[view.tone].chip,
            view.stale && "opacity-60",
          )}
        >
          <ChipFace view={view} fresh={fresh} placement={placement} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side={placement === "footer" ? "top" : "bottom"}
        align="end"
        className="w-[340px] p-0"
        aria-label="Burn: what this thread cost"
        onOpenAutoFocus={(event) => {
          // Start on the dialog, not the price button: its focus opens the calculation.
          // Tab still reaches the price and exposes the tooltip intentionally.
          event.preventDefault();
          contentRef.current?.focus();
        }}
      >
        <BurnCard
          answer={answer}
          threadId={threadId}
          defaultBudget={prefs.threadBudget}
          discounted={prefs.discounted}
          now={now}
          onOpenDetails={() => {
            setOpen(false);
            openPanelIn(navigate, null);
          }}
          onCopy={async () => (answer?.report ? copySummary(answer.report, answer.title, answer.budget) : false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * A thread header action, which bb always mounts, unlike a prompt-box action. It shows the chip beside
 * the context circle under the prompt box, or here in the header when that row is not on screen. A phone
 * shows that row only while the prompt box is expanded, and its header is too narrow for the chip, so
 * there the header gets the flame alone. It stays mounted either way, so the chip moves to the row once it appears.
 */
export function BurnHeaderAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps): ReactNode {
  const prefs = readPrefs(useSettings().values);
  const navigate = useBbNavigate();
  const { answer } = useUsage(threadId, { withChildren: true });
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const mount = useFooterMount(prefs.chip ? anchor : null);
  useEffect(() => registerPanelOpener(threadId, (params) => openPanelIn(navigate, params)), [threadId, navigate]);
  const placement: Placement = mount !== null ? "footer" : isCompactViewport ? "compact" : "header";
  const chip = prefs.chip ? <BurnChip threadId={threadId} answer={answer} placement={placement} /> : null;
  return (
    <span ref={setAnchor} className={prefs.chip && mount === null ? "inline-flex items-center" : "hidden"}>
      {chip !== null && mount !== null ? createPortal(chip, mount) : chip}
    </span>
  );
}
