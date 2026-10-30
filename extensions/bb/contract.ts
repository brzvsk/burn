import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { agentUsageSchema, policySchema, THREAD_ID, usageReportSchema } from "./schema.js";
import { spendMethods } from "./spend/contract.js";

const amount = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const threadId = z.string().regex(THREAD_ID);
export const BUDGET_MAX = 1_000_000;

export const effectiveBudgetSchema = z.object({
  amount: z.number().finite().positive(),
  source: z.enum(["thread", "setting", "pi"]),
});

const familySchema = z.object({
  /** This thread and every descendant that has reported. */
  total: amount,
  lastTurnCost: amount.optional(),
  agents: agentUsageSchema.optional(),
  calls: count,
  /** Some of the total is a list-price estimate. */
  estimated: z.boolean(),
  children: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      cost: amount,
      agents: agentUsageSchema.optional(),
      calls: count,
      running: z.boolean(),
      /** The child's costliest provider/model key. */
      model: z.string().nullable(),
      estimated: z.boolean(),
    }),
  ),
});

const usageOutput = z.object({
  report: usageReportSchema.nullable(),
  /** "pi": its Burn pi extension reported it; "log": its pi session log; "events": bb's usage events. */
  source: z.enum(["pi", "log", "events"]).nullable(),
  reportedAt: z.number().nullable(),
  title: z.string().nullable(),
  budget: effectiveBudgetSchema.nullable(),
  policy: policySchema,
  family: familySchema,
});

const costRow = z.object({
  threadId: z.string(),
  cost: amount.nullable(),
  label: z.string().nullable(),
  /** This thread plus its descendants, or null when no descendant has reported. */
  familyCost: amount.nullable(),
  budget: effectiveBudgetSchema.nullable(),
  state: z.enum(["none", "ok", "near", "over"]),
  /** The thread's or a descendant's cost is a list-price estimate. */
  estimated: z.boolean(),
});

export const rpcContract = defineRpcContract({
  usage: {
    input: z.object({
      threadId,
      /** Answer at list price, without Burn's discount settings. */
      listPrice: z.boolean().default(false),
    }),
    output: usageOutput,
  },
  setBudget: {
    input: z.object({
      threadId,
      // null: no budget for this thread even when the setting has one; "default": follow the setting again.
      budget: z.union([z.number().finite().positive().max(BUDGET_MAX), z.null(), z.literal("default")]),
    }),
    output: z.object({ budget: effectiveBudgetSchema.nullable(), policy: policySchema }),
  },
  costs: {
    input: z.object({ threadIds: z.array(threadId).min(1).max(200) }),
    output: z.object({ threads: z.array(costRow) }),
  },
  overBudget: {
    input: z.object({}),
    output: z.object({ threads: z.array(z.object({ threadId: z.string(), cost: amount, budget: z.number().positive(), estimated: z.boolean() })) }),
  },
  ...spendMethods,
});

export type UsageAnswer = z.infer<typeof usageOutput>;
export type Family = z.infer<typeof familySchema>;
export type CostRow = z.infer<typeof costRow>;
export type OverBudgetRow = z.infer<(typeof rpcContract)["overBudget"]["output"]>["threads"][number];
