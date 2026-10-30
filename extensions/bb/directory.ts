import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * What Burn needs about one thread. `threads.list` already carries all of it,
 * so a pass over every thread costs a page of calls instead of one per thread:
 * `title`, `projectId`, `providerId`, `environmentId`, `environmentHostId`,
 * `status` and `updatedAt` are exactly what `threads.get` and
 * `environments.get` were asked for one thread at a time.
 */
export interface ThreadRow {
  id: string;
  title: string | null;
  titleFallback: string | null;
  projectId: string;
  providerId: string;
  environmentId: string | null;
  hostId: string | null;
  status: string;
  updatedAt: number;
  archivedAt: number | null;
  parentThreadId?: string | null;
  sourceThreadId?: string | null;
  createdAt?: number;
  lifecycleOwnerThreadId?: string | null;
}

export interface ThreadDirectory {
  /** Every thread bb knows up to the page cap, archived and hidden included, listed at most once a TTL. */
  all(): Promise<ThreadRow[]>;
  /** One thread's row; null when bb has no such thread. */
  one(threadId: string): Promise<ThreadRow | null>;
  /** Forget the cached listing, so the next read lists again (a thread archived, unarchived or deleted). */
  refresh(): void;
}

/** bb's page size, as `threads.list` is asked for elsewhere. */
const PAGE = 200;
/** A cap on the pages a single pass takes: 10,000 threads. */
const PAGES_MAX = 50;
const TTL_MS = 60_000;

/** One row of a `threads.list` page, as far as Burn reads it. */
type ListedRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

const toRow = (t: ListedRow): ThreadRow => ({
  id: t.id,
  parentThreadId: t.parentThreadId,
  sourceThreadId: t.sourceThreadId,
  createdAt: t.createdAt,
  lifecycleOwnerThreadId: t.lifecycleOwnerThreadId,
  title: t.title,
  titleFallback: t.titleFallback,
  projectId: t.projectId,
  providerId: t.providerId,
  environmentId: t.environmentId,
  hostId: t.environmentHostId,
  status: t.status,
  updatedAt: t.updatedAt,
  archivedAt: t.archivedAt,
});

interface Listing {
  at: number;
  rows: ThreadRow[];
  byId: Map<string, ThreadRow>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One listing of every thread, shared by the report source, the sidebar flags
 * and the Burn page. Without it each of them asked bb about each thread on its
 * own, which is what made a page over a thousand threads take seconds.
 */
export function createThreadDirectory(bb: BbPluginApi, opts: { now?: () => number } = {}): ThreadDirectory {
  const now = opts.now ?? Date.now;
  let held: Listing | null = null;
  let running: Promise<Listing> | null = null;
  // Bumped by refresh: a listing that a refresh overtook is not kept, so the next read lists again.
  let generation = 0;
  // A direct read under way per thread, so concurrent callers join it instead of asking bb again.
  const directing = new Map<string, Promise<ThreadRow | null>>();

  async function list(): Promise<Listing> {
    if (held && now() - held.at < TTL_MS) return held;
    if (running) return running;
    const mine = generation;
    const taking = (async () => {
      const rows: ThreadRow[] = [];
      for (let page = 0; page < PAGES_MAX; page++) {
        const got = await bb.sdk.threads.list({ includeHidden: true, limit: PAGE, offset: page * PAGE });
        for (const t of got) if (t.deletedAt === null) rows.push(toRow(t));
        if (got.length < PAGE) break;
      }
      const found: Listing = { at: now(), rows, byId: new Map(rows.map((r) => [r.id, r])) };
      if (mine === generation) held = found;
      return found;
    })();
    running = taking;
    try {
      return await taking;
    } finally {
      if (running === taking) running = null;
    }
  }

  /** A thread the listing did not carry: created since it was taken, or one bb knows another way. */
  function direct(threadId: string): Promise<ThreadRow | null> {
    const under = directing.get(threadId);
    if (under) return under;
    const run = (async (): Promise<ThreadRow | null> => {
      try {
        const t = await bb.sdk.threads.get({ threadId });
        if (t.deletedAt !== null) return null;
        let hostId: string | null = null;
        if (t.environmentId !== null) hostId = (await bb.sdk.environments.get({ environmentId: t.environmentId })).hostId;
        return {
          id: t.id,
          parentThreadId: t.parentThreadId,
          sourceThreadId: t.sourceThreadId,
          createdAt: t.createdAt,
          lifecycleOwnerThreadId: t.lifecycleOwnerThreadId,
          title: t.title,
          titleFallback: t.titleFallback,
          projectId: t.projectId,
          providerId: t.providerId,
          environmentId: t.environmentId,
          hostId,
          status: t.status,
          updatedAt: t.updatedAt,
          archivedAt: t.archivedAt,
        };
      } catch (err) {
        // A thread bb cannot read is left out, but the failure is named rather than read as a deletion.
        bb.log.warn(`reading thread ${threadId} failed: ${message(err)}`);
        return null;
      }
    })();
    directing.set(threadId, run);
    run.then(
      () => directing.delete(threadId),
      () => directing.delete(threadId),
    );
    return run;
  }

  return {
    async all() {
      return (await list()).rows;
    },
    async one(threadId) {
      const found = await list();
      // A thread the listing does not carry: created since it was taken, or one bb has forgotten.
      return found.byId.get(threadId) ?? direct(threadId);
    },
    refresh() {
      held = null;
      generation++;
    },
  };
}
