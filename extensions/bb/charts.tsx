import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { formatClock, formatUsd } from "../../src/format.js";
import type { UsageReport } from "../../src/report.js";
import { cn } from "./lib/utils.js";

/** One model call as the per-call chart draws it. */
export interface CallPoint {
  at: number;
  cost: number;
  turn: number;
  /** 1-based position of the call in its turn, and the turn's call count. */
  call: number;
  calls: number;
  /** The thread's total once this call was paid for. */
  total: number;
}

/**
 * The report's recent calls with their place in their turn. The series holds
 * only the latest calls, so a turn cut off at its start still counts from the
 * turn's real call count.
 */
export function callPoints(report: UsageReport): CallPoint[] {
  const { series } = report;
  const turnCalls = new Map(report.turns.map((t) => [t.n, t.calls]));
  const inSeries = new Map<number, number>();
  for (const p of series) inSeries.set(p.turn, (inSeries.get(p.turn) ?? 0) + 1);
  const seen = new Map<number, number>();
  let total = Math.max(0, report.cost.total - series.reduce((sum, p) => sum + p.cost, 0));
  return series.map((p) => {
    total += p.cost;
    const shown = inSeries.get(p.turn) ?? 0;
    const calls = Math.max(turnCalls.get(p.turn) ?? shown, shown);
    const index = (seen.get(p.turn) ?? 0) + 1;
    seen.set(p.turn, index);
    return { at: p.at, cost: p.cost, turn: p.turn, call: calls - shown + index, calls, total };
  });
}

export const callTip = (p: CallPoint): string =>
  `Turn ${p.turn} · call ${p.call}/${p.calls} · ${formatUsd(p.cost)} · total ${formatUsd(p.total)}`;

/** Where the hover label starts: centred on its bar, but never past either edge of the chart. */
export function tipLeft(index: number, count: number, chartWidth: number, tipWidth: number): number {
  const centre = ((index + 0.5) / count) * chartWidth;
  return Math.max(0, Math.min(centre - tipWidth / 2, chartWidth - tipWidth));
}

const W = 316;
const H = 86;
const P = 4;

/**
 * Per-call bars over alternating turn bands, with the running total as a line.
 * The priciest call is drawn in the warning colour and the latest in the accent.
 */
export function CallChart({ points, className }: { points: CallPoint[]; className?: string }): ReactNode {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  // Measured before paint: a label centred on an edge bar would overflow the popover and give it a horizontal scrollbar.
  useLayoutEffect(() => {
    if (hover === null || box.current === null || tip.current === null) return;
    tip.current.style.left = `${tipLeft(hover, points.length, box.current.clientWidth, tip.current.offsetWidth)}px`;
  }, [hover, points.length]);
  if (points.length === 0) return null;
  const slot = (W - 2 * P) / points.length;
  const bar = Math.max(1, slot * 0.66);
  const peak = Math.max(...points.map((p) => p.cost));
  const peakIndex = peak > 0 ? points.findIndex((p) => p.cost === peak) : -1;
  const first = (points[0] as CallPoint).total - (points[0] as CallPoint).cost;
  const span = (points[points.length - 1] as CallPoint).total - first || 1;
  const bands: { x: number; width: number }[] = [];
  let runStart = 0;
  let runIndex = 0;
  points.forEach((p, i) => {
    const next = points[i + 1];
    if (next !== undefined && next.turn === p.turn) return;
    if (runIndex % 2 === 1) bands.push({ x: P + runStart * slot, width: (i + 1 - runStart) * slot });
    runStart = i + 1;
    runIndex++;
  });
  const line = points
    .map((p, i) => `${(P + i * slot + bar / 2).toFixed(1)},${(H - P - ((p.total - first) / span) * (H - 2 * P)).toFixed(1)}`)
    .join(" ");
  const hovered = hover === null ? undefined : points[hover];
  return (
    <div ref={box} className={cn("relative", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[86px] w-full"
        role="img"
        aria-label="Cost per call, with the running total"
        onMouseLeave={() => setHover(null)}
      >
        {bands.map((b) => (
          <rect key={b.x} x={b.x} y={0} width={b.width} height={H} className="fill-foreground" opacity={0.05} />
        ))}
        {points.map((p, i) => {
          const h = peak > 0 ? Math.max(2, (p.cost / peak) * (H - 2 * P) * 0.8) : 2;
          const tone = i === peakIndex ? "fill-warning" : i === points.length - 1 ? "fill-timeline-accent" : "fill-success";
          return (
            <rect
              key={i}
              data-bar={i}
              x={P + i * slot}
              y={H - P - h}
              width={bar}
              height={h}
              rx={1.5}
              className={tone}
              opacity={hover === null ? 0.85 : hover === i ? 1 : 0.45}
            />
          );
        })}
        <polyline points={line} fill="none" className="stroke-pr-merged" strokeWidth={1.5} strokeLinejoin="round" opacity={0.9} />
        {points.map((p, i) => (
          <rect
            key={`hit-${i}`}
            data-call={i}
            x={P + i * slot}
            y={0}
            width={slot}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          >
            <title>{callTip(p)}</title>
          </rect>
        ))}
      </svg>
      {hovered !== undefined && hover !== null ? (
        <div
          ref={tip}
          role="status"
          className="pointer-events-none absolute top-0 left-0 -translate-y-full rounded-md bg-foreground px-1.5 py-1 text-[11px] whitespace-nowrap text-background tabular-nums"
        >
          {callTip(hovered)}
        </div>
      ) : null}
      <div className="mt-0.5 flex justify-between text-[10.5px] text-muted-foreground tabular-nums">
        <span>{formatClock((points[0] as CallPoint).at)}</span>
        <span>{turnSpan(points)}</span>
        <span>{formatClock((points[points.length - 1] as CallPoint).at)}</span>
      </div>
    </div>
  );
}

function turnSpan(points: CallPoint[]): string {
  const turns = points.map((p) => p.turn);
  const low = Math.min(...turns);
  const high = Math.max(...turns);
  return low === high ? `turn ${low}` : `turns ${low} to ${high}`;
}

/** Parts of one whole side by side, each as wide as its share. */
export function StackedBar({ parts, className }: { parts: { key: string; value: number; className: string }[]; className?: string }): ReactNode {
  const shown = parts.filter((p) => p.value > 0);
  // Normalise to shares: CSS leaves free space when flex-grow factors sum below 1,
  // so raw dollar amounts left a cheap thread's bar mostly background.
  const total = shown.reduce((sum, p) => sum + p.value, 0);
  return (
    <div className={cn("flex h-2 gap-0.5 overflow-hidden rounded-full bg-state-hover", className)} role="presentation">
      {shown.map((p) => (
        <i key={p.key} data-part={p.key} className={cn("block h-full min-w-px", p.className)} style={{ flexGrow: total > 0 ? p.value / total : 0, flexBasis: 0 }} />
      ))}
    </div>
  );
}

/** A thin bar filled to `fraction` (clamped to 0–1). */
export function Meter({ fraction, className, fill }: { fraction: number; className?: string; fill: string }): ReactNode {
  const width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10}%`;
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-state-hover", className)}>
      <i className={cn("block h-full rounded-full", fill)} style={{ width }} />
    </div>
  );
}

/** One small bar per call cost, scaled to the largest; `hot` is drawn in the warning colour. */
export function MiniBars({ values, hot }: { values: number[]; hot?: number }): ReactNode {
  if (values.length === 0) return null;
  const peak = Math.max(...values) || 1;
  return (
    <div className="flex h-7 items-end gap-[3px]" role="img" aria-label="Cost of each call">
      {values.map((v, i) => (
        <i
          key={i}
          title={formatUsd(v)}
          className={cn("block w-3.5 rounded-t-sm", i === hot ? "bg-warning" : "bg-success")}
          style={{ height: `${Math.max(3, Math.round((v / peak) * 28))}px` }}
        />
      ))}
    </div>
  );
}
