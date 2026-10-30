import type { BudgetPolicy } from "../../src/budget.js";
import type { UsageReport } from "../../src/report.js";
import { readPolicy } from "../../src/wire.js";

const THREAD_ID = /^thr_[0-9a-z]{6,40}$/;
const TIMEOUT_MS = 500;

export interface BbReporter {
  report(report: UsageReport, mode: string): Promise<void>;
  /** bb's latest budget policy for this thread, or null before bb has sent one. */
  policy(): BudgetPolicy | null;
}

/**
 * Sends the report to the Burn bb plugin and keeps the budget policy bb answers
 * with. Only bb's own pi reports: a `pi -p` started from the thread's shell
 * inherits both variables but runs in print mode. Never throws; a failed send is
 * retried on the next event.
 */
export function createBbReporter(opts: {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): BbReporter {
  const env = opts.env ?? process.env;
  const send = opts.fetch ?? fetch;
  let lastSent = "";
  let policy: BudgetPolicy | null = null;
  return {
    policy: () => policy,
    async report(report, mode) {
      const url = env.BURN_BB_URL ?? "";
      const threadId = env.BB_THREAD_ID ?? "";
      const token = env.BURN_BB_TOKEN ?? "";
      if (mode !== "rpc" || !/^https?:\/\//.test(url) || !THREAD_ID.test(threadId)) return;
      const key = JSON.stringify(report);
      if (key === lastSent) return;
      try {
        const res = await send(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token === "" ? {} : { "x-burn-token": token }) },
          body: JSON.stringify({ threadId, sentAt: Date.now(), report }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          // An unread body would keep its connection open.
          await res.body?.cancel();
          return;
        }
        lastSent = key;
        policy = readPolicy(await res.json().catch(() => null)) ?? policy;
      } catch {
        // bb is down or reloading; the next event sends again.
      }
    },
  };
}
