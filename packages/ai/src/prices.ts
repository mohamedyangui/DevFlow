import type { LlmTokenUsage } from "@devflow/core";

/**
 * What a model costs, in US dollars per million tokens. Prices come from the project
 * configuration (`ai.prices`): DevFlow has no built-in price list, because prices change and
 * a stale built-in price would make cost budgets and reports wrong without anyone noticing
 * (ADR 0010).
 */
export interface ModelPrice {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /** Input tokens read from the provider's prompt cache. Default: the input price. */
  readonly cachedInputUsdPerMTok?: number | undefined;
  /** Input tokens written to the provider's prompt cache. Default: the input price. */
  readonly cacheWriteUsdPerMTok?: number | undefined;
}

const PER_TOKEN = 1 / 1_000_000;

/** Prices by model id. A model without a price has no known cost. */
export class PriceTable {
  private readonly prices: ReadonlyMap<string, ModelPrice>;

  constructor(prices: Readonly<Record<string, ModelPrice>> = {}) {
    for (const [model, price] of Object.entries(prices)) checkPrice(model, price);
    this.prices = new Map(Object.entries(prices));
  }

  get size(): number {
    return this.prices.size;
  }

  /** The price of the first of `models` that has one (e.g. the served model, then the requested one). */
  priceOf(...models: readonly string[]): ModelPrice | undefined {
    for (const model of models) {
      const price = this.prices.get(model);
      if (price !== undefined) return price;
    }
    return undefined;
  }

  /**
   * The cost of a call in US dollars, or undefined when none of `models` has a price.
   * `usage.inputTokens` includes cached input, which is priced separately.
   */
  cost(usage: LlmTokenUsage, ...models: readonly string[]): number | undefined {
    const price = this.priceOf(...models);
    if (price === undefined) return undefined;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    const uncached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
    return (
      (uncached * price.inputUsdPerMTok +
        cacheRead * (price.cachedInputUsdPerMTok ?? price.inputUsdPerMTok) +
        cacheWrite * (price.cacheWriteUsdPerMTok ?? price.inputUsdPerMTok) +
        usage.outputTokens * price.outputUsdPerMTok) *
      PER_TOKEN
    );
  }
}

function checkPrice(model: string, price: ModelPrice): void {
  for (const [name, value] of Object.entries(price)) {
    if (value === undefined && name !== "inputUsdPerMTok" && name !== "outputUsdPerMTok") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`price ${name} of model ${model} must be a non-negative number`);
    }
  }
}
