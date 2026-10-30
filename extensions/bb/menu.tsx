import {
  experimental_THREAD_ACTION_GROUPS,
  type PluginThreadAction,
  type PluginThreadActionDataInput,
  type PluginThreadActionItemInput,
  type PluginThreadActionRegistration,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { formatAmount, formatBudget } from "../../src/format.js";
import { budgetWords } from "./budgets.js";
import type { CostRow, rpcContract } from "./contract.js";
import { FLAME_ICON } from "./icon.js";
import { requestPanel } from "./panel-requests.js";
import { readPrefs } from "./prefs.js";
import { copySummary } from "./summary.js";
import { errorText, isThreadId, useOnReconnect } from "./usage.js";

const BATCH_MAX = 200;
const REFRESH_MS = 750;

export interface ThreadCosts {
  rows: ReadonlyMap<string, CostRow>;
  copy(threadId: string): void;
}

/**
 * The cost of every thread on screen, fetched in one `costs` call for the ids
 * not loaded yet. Any `usage` signal can change a family total, so a burst of
 * signals refetches the visible ids once.
 */
export function useThreadCosts({ threadIds }: PluginThreadActionDataInput): ThreadCosts {
  const rpc = useRpc<typeof rpcContract>();
  const { threadBudget } = readPrefs(useSettings().values);
  const [rows, setRows] = useState<ReadonlyMap<string, CostRow>>(() => new Map());
  const asking = useRef(new Set<string>());
  const pendingRefresh = useRef(false);
  const visible = useRef(threadIds);
  visible.current = threadIds;

  const load = useCallback(
    function load(ids: readonly string[], replace: boolean) {
      const known = ids.filter(isThreadId);
      // A refresh that arrives while ids are being read joins those reads and runs once more when they settle.
      const wanted = known.filter((id) => !asking.current.has(id));
      if (replace && wanted.length < known.length) pendingRefresh.current = true;
      const settle = (): void => {
        if (pendingRefresh.current && asking.current.size === 0) {
          pendingRefresh.current = false;
          load(visible.current, true);
        }
      };
      for (let i = 0; i < wanted.length; i += BATCH_MAX) {
        const batch = wanted.slice(i, i + BATCH_MAX);
        for (const id of batch) asking.current.add(id);
        rpc.call("costs", { threadIds: batch }).then(
          ({ threads }) => {
            for (const id of batch) asking.current.delete(id);
            setRows((prev) => {
              const next = new Map(replace ? [...prev].filter(([id]) => visible.current.includes(id)) : prev);
              for (const row of threads) next.set(row.threadId, row);
              return next;
            });
            settle();
          },
          (cause: unknown) => {
            for (const id of batch) asking.current.delete(id);
            console.warn(`Burn: loading thread costs failed: ${errorText(cause)}`);
            settle();
          },
        );
      }
    },
    [rpc],
  );

  useEffect(() => {
    load(
      threadIds.filter((id) => !rows.has(id)),
      false,
    );
  }, [threadIds, rows, load]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshVisible = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load(visible.current, true), REFRESH_MS);
  }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useRealtime("usage", refreshVisible);
  useOnReconnect(refreshVisible);
  const firstBudget = useRef(true);
  useEffect(() => {
    if (firstBudget.current) firstBudget.current = false;
    else refreshVisible();
  }, [threadBudget, refreshVisible]);

  const copy = useCallback(
    (threadId: string) => {
      rpc.call("usage", { threadId }).then(
        (answer) => {
          if (answer.report === null) toast.error("This thread has not reported a cost yet");
          else void copySummary(answer.report, answer.title, answer.budget);
        },
        (cause: unknown) => toast.error(`Copying the cost summary failed: ${errorText(cause)}`),
      );
    },
    [rpc],
  );
  return useMemo(() => ({ rows, copy }), [rows, copy]);
}

/** "$4.82", "$4.82 · $6.64 with children", "No report yet", or nothing while loading. */
export function costDetail(row: CostRow | undefined): string | undefined {
  if (row === undefined) return undefined;
  if (row.label === null) return "No report yet";
  return row.familyCost !== null ? `${row.label} · ${formatAmount(row.familyCost, row.estimated)} with children` : row.label;
}

export function costAction({ thread, data, navigate }: PluginThreadActionItemInput<ThreadCosts>): PluginThreadAction {
  const row = data.rows.get(thread.id);
  const budget = row?.budget ?? null;
  const hint = budget === null ? undefined : row?.cost != null ? budgetWords(row.cost, budget).share : `${formatBudget(budget.amount)} budget`;
  return {
    label: "Cost",
    detail: costDetail(row),
    icon: FLAME_ICON,
    choices: {
      items: [
        { id: "open", label: "Open Burn panel" },
        { id: "budget", label: "Set budget…" },
        { id: "copy", label: "Copy cost summary", disabled: row !== undefined && row.label === null },
      ],
      ...(hint !== undefined ? { hint } : {}),
    },
    run: ({ value }) => {
      if (value === "copy") data.copy(thread.id);
      else requestPanel(navigate, thread.id, value === "budget" ? { focus: "budget" } : null);
    },
  };
}

export const costActionRegistration: PluginThreadActionRegistration<ThreadCosts> = {
  id: "cost",
  title: "Cost",
  icon: FLAME_ICON,
  group: experimental_THREAD_ACTION_GROUPS.state,
  // A submenu sits after the plain actions of its group.
  order: 100,
  useData: useThreadCosts,
  item: costAction,
};
