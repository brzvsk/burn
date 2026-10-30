import { expect, it } from "vitest";
import { withOwnedThreads } from "../../extensions/bb/family.js";
it("includes lifecycle workers, nested workflows and their parented descendants exactly once", () => {
  const rows = [
    { id: "nested", lifecycleOwnerThreadId: "worker" },
    { id: "worker", lifecycleOwnerThreadId: "root" },
    { id: "child", parentThreadId: "worker" },
    { id: "root", parentThreadId: "nested" },
    { id: "other", lifecycleOwnerThreadId: "unrelated" },
  ];
  expect(withOwnedThreads("root", ["regular", "worker"], rows).sort()).toEqual(["child", "nested", "regular", "worker"]);
});

import { spawnedTurnCost } from '../../extensions/bb/family.js';
import type { ThreadRow } from '../../extensions/bb/directory.js';
it('keeps nested worker spend in its spawning prompt and never replays old last-turn totals', () => {
 const rows=[{id:'child',parentThreadId:'root',createdAt:110},{id:'nested',lifecycleOwnerThreadId:'child',createdAt:210},{id:'old',parentThreadId:'root',createdAt:50}] as ThreadRow[];
 const reports=[{id:'child',report:{cost:{total:2}}},{id:'nested',report:{cost:{total:3}}},{id:'old',report:{cost:{total:9}}}];
 expect(spawnedTurnCost('root',100,1,reports,rows)).toBe(6);
 expect(spawnedTurnCost('root',200,1,reports,rows)).toBe(1);
 expect(spawnedTurnCost('root',undefined,1,reports,rows)).toBe(1);
});
