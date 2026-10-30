import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExperimentalHostRpcContext, ExperimentalHostWatchEvent, ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { CHANGED_MAX, hostContract, hostSignals } from "./contract.js";
import { createClaudeSessions, claudeProjectsDir } from "./claude-sessions.js";
import { createOpencodeDb, opencodeDbPath } from "./opencode-db.js";
import { createPiSessions, sessionDir } from "./pi-sessions.js";

type Context = ExperimentalHostRpcContext<typeof hostSignals>;

/** How long a call waits for its watch to be ready, about ten times what a watch takes. */
const WATCH_WAIT_MS = 1000;

/**
 * The folder's path with every symlink resolved, a part that does not exist yet
 * joined on as it is. Some machines link `~/.bb` elsewhere, and a file watcher
 * can refuse a root reached through a link.
 */
export async function realDir(dir: string): Promise<string> {
  const rest: string[] = [];
  for (let at = dir; ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...rest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) throw err;
      rest.unshift(basename(at));
    }
  }
}

/**
 * The Burn host entry: reads pi's session logs and opencode's database on the
 * machine bb runs it on, and signals the server as soon as a pi log changes so
 * the chip updates live.
 */
export function createHostEntry(opts: { dir: string; opencodeDb?: string; opencodeModels?: string; watchWaitMs?: number; claudeDir?: string }) {
  const claude = createClaudeSessions({ dir: opts.claudeDir ?? claudeProjectsDir() });
  const sessions = createPiSessions({ dir: opts.dir });
  const opencode = createOpencodeDb({ path: opts.opencodeDb ?? opencodeDbPath(), modelsPath: opts.opencodeModels });
  const watchWaitMs = opts.watchWaitMs ?? WATCH_WAIT_MS;
  let watch: Promise<ExperimentalHostWatchSubscription | null> | null = null;
  let live: ExperimentalHostWatchSubscription | null = null;

  async function onEvent(event: ExperimentalHostWatchEvent, context: Context): Promise<void> {
    if (event.kind === "watch-error") {
      // bb retries a watch that is not ready yet on its own; one that was ready has ended, so the next call starts another.
      const broken = live;
      if (broken === null) return;
      live = null;
      watch = null;
      await broken.dispose().catch(() => undefined);
      return;
    }
    if (event.kind === "rescan-required") return context.experimental_emitSignal("changed", { sessionIds: [], all: true });
    const ids = [...new Set(event.changes.map((c) => sessions.sessionIdOf(c.path)).filter((id) => id !== null))];
    if (ids.length === 0) return;
    await context.experimental_emitSignal("changed", ids.length > CHANGED_MAX ? { sessionIds: [], all: true } : { sessionIds: ids, all: false });
  }

  function startWatch(context: Context): Promise<ExperimentalHostWatchSubscription | null> {
    const run: Promise<ExperimentalHostWatchSubscription | null> = realDir(opts.dir)
      .then((rootPath) => context.experimental_watch({ rootPath, debounceMs: 150, maxWaitMs: 1000 }, (event) => onEvent(event, context)))
      .then(
        async (subscription) => {
          if (watch === run && !context.signal.aborted) {
            live = subscription;
            return subscription;
          }
          // bb disposes a watch whose call was cancelled before the watch was ready.
          if (watch === run) watch = null;
          await subscription.dispose().catch(() => undefined);
          return null;
        },
        () => {
          if (watch === run) watch = null;
          return null;
        },
      );
    return run;
  }

  /**
   * Watches the session folder from the first call on. A call waits a moment for the watch and no
   * longer: bb answers a watch only once its root is watched, which for a missing folder can take
   * until pi first writes there, and the reports do not need the watch.
   */
  async function ensureWatch(context: Context): Promise<void> {
    if (watch !== null) return;
    const run = startWatch(context);
    watch = run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run, new Promise((resolve) => (timer = setTimeout(resolve, watchWaitMs)))]).finally(() => clearTimeout(timer));
  }

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      reports: async ({ harness, threads, timeZone }, context) => {
        if (harness === "pi") await ensureWatch(context);
        const reports = [];
        for (const { threadId, sessionIds, since, parentSessionIds } of threads) {
          context.signal.throwIfAborted();
          const got = harness === "claude"
              ? await claude.reportOf(sessionIds, timeZone, { since, parentSessionIds })
              : harness === "opencode" ? await opencode.reportOf(sessionIds, timeZone) : await sessions.reportOf(sessionIds, timeZone);
          reports.push({ threadId, report: got?.report ?? null, at: got?.at ?? null });
        }
        return { dir: opts.dir, reports };
      },
    },
  });
}

export default createHostEntry({ dir: sessionDir() });
