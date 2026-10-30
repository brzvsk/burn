import type { ThreadRow } from "./directory.js";

/** BB descendants follow parentThreadId; workflow workers instead have a lifecycle owner.
 * Close over both edges, once per thread, including nested workflows and cycles.
 */
export function withOwnedThreads(
  root: string,
  descendants: readonly string[],
  rows: readonly Pick<ThreadRow, "id" | "parentThreadId" | "lifecycleOwnerThreadId">[],
): string[] {
  const seen = new Set([root, ...descendants]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      if ((row.parentThreadId && seen.has(row.parentThreadId)) || (row.lifecycleOwnerThreadId && seen.has(row.lifecycleOwnerThreadId))) {
        seen.add(row.id);
        changed = true;
      }
    }
  }
  seen.delete(root);
  return [...seen];
}

/** Workers remain attached to the prompt that created their direct ancestor.
 * Never replay each child's lastTurnCost in a later prompt. Older/reused workers
 * without a causal turn link remain in family.total but not this delta.
 */
export function spawnedTurnCost(root: string, at: number | undefined, own: number,
  reports: readonly {id: string; report: {cost: {total: number}}}[], rows: readonly ThreadRow[]): number {
  if (at === undefined) return own;
  const byId = new Map(rows.map(r => [r.id, r]));
  let total = own;
  for (const child of reports) {
    let row = byId.get(child.id);
    const seen = new Set<string>();
    while (row && !seen.has(row.id)) {
      seen.add(row.id);
      const parent = row.parentThreadId ?? row.lifecycleOwnerThreadId;
      if (parent === root) {
        if (row.createdAt !== undefined && row.createdAt >= at) total += child.report.cost.total;
        break;
      }
      row = parent ? byId.get(parent) : undefined;
    }
  }
  return total;
}
