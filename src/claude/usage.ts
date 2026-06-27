import { logger } from '../logger.js';

/** USD per 1M tokens, by model. Cache writes bill ~1.25x input, reads ~0.1x input. */
interface Pricing {
  input: number;
  output: number;
}

const PRICING: Record<string, Pricing> = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
};
const DEFAULT_PRICING: Pricing = { input: 5, output: 25 };

/** The token fields we read off an SDK response's `usage`. */
interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageTotals extends NormalizedUsage {
  calls: number;
  costUSD: number;
}

let totals: UsageTotals = {
  calls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUSD: 0,
};

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function costOf(model: string, u: NormalizedUsage): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  const dollars =
    (u.input * p.input +
      u.cacheWrite * p.input * 1.25 +
      u.cacheRead * p.input * 0.1 +
      u.output * p.output) /
    1_000_000;
  return dollars;
}

/** Record one API call's usage, log a per-call line, and accumulate run totals. */
export function recordUsage(model: string, usage: RawUsage, label = 'claude'): void {
  const u: NormalizedUsage = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
  const cost = costOf(model, u);

  totals.calls += 1;
  totals.input += u.input;
  totals.output += u.output;
  totals.cacheRead += u.cacheRead;
  totals.cacheWrite += u.cacheWrite;
  totals.costUSD += cost;

  logger.info(`${label} usage`, { model, ...u, costUSD: round4(cost) });
}

export function usageSummary(): UsageTotals {
  return { ...totals, costUSD: round4(totals.costUSD) };
}

export function resetUsage(): void {
  totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 };
}
