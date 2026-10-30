import { type BbNavigate, useBbNavigate, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { ALERT_CHANNEL, type BurnAlert, isBurnAlert } from "./alerts.js";
import type { rpcContract } from "./contract.js";
import { overBudgetStatus, setRowFlags } from "./flags.js";
import { requestPanel } from "./panel-requests.js";
import { readPrefs } from "./prefs.js";
import { errorText, useOnReconnect } from "./usage.js";

const SEEN_MAX = 500;
const REFRESH_MS = 1000;

// Alerts land when a turn ends, often while the user is in another window. A budget crossed or a stopped
// thread waits for them; sonner's default 4 seconds is too short for a title, a sentence and a button.
const ALERT_DURATION_MS: Record<BurnAlert["kind"], number> = {
  near: 15_000,
  daily: 15_000,
  expensive: 10_000,
  over: Infinity,
  stopped: Infinity,
};

// One overlay mounts per window, so this is "once per window".
const seen = new Set<string>();

/** Shows an alert as a toast unless this window already showed it; says whether it did. */
export function showAlert(alert: BurnAlert, navigate: BbNavigate): boolean {
  if (seen.has(alert.id)) return false;
  seen.add(alert.id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
  const { threadId } = alert;
  const action =
    threadId === null
      ? { label: "Open Spend", onClick: () => navigate.toPluginPanel("spend") }
      : alert.kind === "expensive"
        ? { label: "Open details", onClick: () => requestPanel(navigate, threadId, null) }
        : { label: "Open thread", onClick: () => navigate.toThread(threadId) };
  const options = { id: alert.id, description: alert.body, action, duration: ALERT_DURATION_MS[alert.kind], closeButton: true };
  if (alert.kind === "over" || alert.kind === "stopped") toast.error(alert.title, options);
  else if (alert.kind === "expensive") toast(alert.title, options);
  else toast.warning(alert.title, options);
  return true;
}

/**
 * Mounted once per window: shows each Burn alert as a toast and keeps the
 * sidebar's over-budget flags current while that setting is on.
 */
export function BurnOverlay(): ReactNode {
  const { flagOverBudget, threadBudget } = readPrefs(useSettings().values);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Signals arriving while a check runs leave a mark; the check that is running answers them with one more pass.
  const flight = useRef<{ again: boolean } | null>(null);
  const currentFlag = useRef(flagOverBudget);
  currentFlag.current = flagOverBudget;
  const mounted = useRef(true);

  const refresh = useCallback(function run() {
    if (!flagOverBudget) {
      latest.current++;
      flight.current = null;
      setRowFlags(new Map());
      return;
    }
    const under = flight.current;
    if (under) {
      under.again = true;
      return;
    }
    const mine = { again: false };
    flight.current = mine;
    const asked = ++latest.current;
    const done = (): void => {
      if (flight.current === mine) flight.current = null;
      if (mine.again && flight.current === null && mounted.current && currentFlag.current) run();
    };
    rpc.call("overBudget", {}).then(
      ({ threads }) => {
        if (asked === latest.current) setRowFlags(new Map(threads.map((t) => [t.threadId, overBudgetStatus(t)])));
        done();
      },
      (cause: unknown) => {
        console.warn(`Burn: checking which threads are over budget failed: ${errorText(cause)}`);
        done();
      },
    );
  }, [rpc, flagOverBudget]);

  // refresh does not read threadBudget, but a new one moves threads over or under their budget.
  useEffect(refresh, [refresh, threadBudget]);
  useEffect(
    () => () => {
      mounted.current = false;
      flight.current = null;
      clearTimeout(timer.current);
      latest.current++;
      setRowFlags(new Map());
    },
    [],
  );
  useRealtime(
    "usage",
    useCallback(() => {
      clearTimeout(timer.current);
      timer.current = setTimeout(refresh, REFRESH_MS);
    }, [refresh]),
  );
  useOnReconnect(refresh);
  useRealtime(
    ALERT_CHANNEL,
    useCallback(
      (payload: unknown) => {
        if (isBurnAlert(payload)) showAlert(payload, navigate);
      },
      [navigate],
    ),
  );
  return null;
}
