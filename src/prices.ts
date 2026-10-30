import type { CostParts, TokenParts } from "./report.js";

/** Dollars per million tokens. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PriceRow extends Rates {
  tiers?: readonly (Rates & { inputTokensAbove: number })[];
}

export type PriceTable = Readonly<Record<string, PriceRow>>;

// Copied from pi-ai 1.3.0's ANTHROPIC_MODELS and OPENAI_CODEX_MODELS; test/prices.test.ts fails when pi's prices change.
export const ANTHROPIC_PRICES: PriceTable = {
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
  },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5-20251101": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

export const OPENAI_CODEX_PRICES: PriceTable = {
  "gpt-5.3-codex-spark": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.5": {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 0,
    tiers: [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }],
  },
  "gpt-5.6-luna": {
    input: 0.2,
    output: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    tiers: [{ inputTokensAbove: 272000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }],
  },
  "gpt-5.6-sol": {
    input: 4,
    output: 20,
    cacheRead: 0.4,
    cacheWrite: 5,
    tiers: [{ inputTokensAbove: 272000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
  },
  "gpt-5.6-terra": {
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }],
  },
  "gpt-6-astra": {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
  },
  "gpt-6-luna": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
  },
  "gpt-6-sol": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
  },
  "gpt-6.1-sol": {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
  },
};

/** Per-model rates from Burn's settings, laid over the built-in table. */
export type PriceOverrides = Readonly<Record<string, PriceRow>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const rate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000;

/**
 * The JSON in the Price overrides setting: model id to dollars per million tokens.
 * Input and output are required; cache reads and writes default to 0. Empty text is no overrides; null is invalid.
 */
export function parsePriceOverrides(text: string): PriceOverrides | null {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const out: Record<string, PriceRow> = {};
  for (const [id, row] of Object.entries(value)) {
    if (id === "" || id.length > 200 || !isRecord(row)) return null;
    const { input, output, cacheRead = 0, cacheWrite = 0 } = row;
    if (!rate(input) || !rate(output) || !rate(cacheRead) || !rate(cacheWrite)) return null;
    out[id] = { input, output, cacheRead, cacheWrite };
  }
  return out;
}

/** `table` with the settings' rates in place of its own, for the models they name. */
export function withPrices(table: PriceTable, overrides: PriceOverrides): PriceTable {
  return Object.keys(overrides).length === 0 ? table : { ...table, ...overrides };
}

/** A model's prices: by its id, else by its id without a trailing bracket such as "claude-opus-5-5[1m]". */
export function priceOf(table: PriceTable, model: string): PriceRow | null {
  for (const id of [model, model.replace(/\[[^\]]*\]$/, "")]) if (Object.hasOwn(table, id)) return table[id] as PriceRow;
  return null;
}

/**
 * What pi-ai's calculateCost charges, without its one-hour cache-write surcharge:
 * with tiers, the tier with the highest threshold below the prompt's tokens
 * replaces the base rates.
 */
export function listCost(row: PriceRow, tokens: TokenParts, opts: { tiers: boolean }): CostParts {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  let rates: Rates = row;
  let above = -1;
  if (opts.tiers) {
    for (const tier of row.tiers ?? []) {
      if (prompt > tier.inputTokensAbove && tier.inputTokensAbove > above) {
        rates = tier;
        above = tier.inputTokensAbove;
      }
    }
  }
  const input = (rates.input * tokens.input) / 1_000_000;
  const output = (rates.output * tokens.output) / 1_000_000;
  const cacheRead = (rates.cacheRead * tokens.cacheRead) / 1_000_000;
  const cacheWrite = (rates.cacheWrite * tokens.cacheWrite) / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
