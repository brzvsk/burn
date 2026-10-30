import { ANTHROPIC_PRICES, OPENAI_CODEX_PRICES, type PriceTable } from "../../src/prices.js";

/** How Burn reads one bb provider's threads. */
export interface Harness {
  /** "pi-log": the host entry reads pi's session logs; "opencode-db": opencode's own database; "events": the usage bb records. */
  reader: "pi-log" | "opencode-db" | "claude-log" | "events";
  /** The list prices for tokens of a session that records no cost; null to show tokens. */
  prices: PriceTable | null;
  /** Whether inputTokens includes cached and cache-write tokens; null when unknown. */
  cacheInInput: boolean | null;
  // Each usage event is one model call, so price tiers and the stop apply.
  perCall: boolean;
  /** The bridge reuses the parent provider id for native child usage counters. */
  separateChildCounters?: boolean;
}

const HARNESSES: Readonly<Record<string, Harness>> = {
  pi: { reader: "pi-log", prices: null, cacheInInput: false, perCall: true },
  "acp-opencode": { reader: "opencode-db", prices: null, cacheInInput: false, perCall: true },
  codex: { reader: "events", prices: OPENAI_CODEX_PRICES, cacheInInput: true, perCall: true, separateChildCounters: true },
  "claude-code": { reader: "claude-log", prices: ANTHROPIC_PRICES, cacheInInput: false, perCall: false },
};

const OTHER: Harness = { reader: "events", prices: null, cacheInInput: null, perCall: false };

const NAMES: Readonly<Record<string, string>> = { pi: "pi", "acp-opencode": "OpenCode", codex: "Codex", "claude-code": "Claude Code" };

/** A bb provider's name for people; one Burn does not know reads as its id. */
export const harnessName = (providerId: string): string => (Object.hasOwn(NAMES, providerId) ? (NAMES[providerId] as string) : providerId);

export const harnessOf = (providerId: string): Harness => (Object.hasOwn(HARNESSES, providerId) ? (HARNESSES[providerId] as Harness) : OTHER);
