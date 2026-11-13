import { DevflowError, ErrorCode } from "@devflowai/core";

/** Limits for one run. */
export interface BudgetLimits {
  /** Input tokens across every model call of the run. */
  readonly maxInputTokens: number;
  /** Output tokens across every model call of the run. */
  readonly maxOutputTokens: number;
  /** Model calls within one workflow step, repairs included. */
  readonly maxCallsPerStep: number;
  /**
   * US dollars across every priced model call of the run. Calls to a model without a price
   * cannot be counted, so they are not limited by it.
   */
  readonly maxCostUsd?: number | undefined;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = Object.freeze({
  maxInputTokens: 600_000,
  maxOutputTokens: 80_000,
  maxCallsPerStep: 12,
});

/** What a run has consumed so far. Persisted with the run so a resumed run keeps counting. */
export interface BudgetUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly callsByStep: Readonly<Record<string, number>>;
  /** US dollars of the priced calls. */
  readonly costUsd?: number | undefined;
  /** Calls whose cost is unknown because their model has no price. */
  readonly unpricedCalls?: number | undefined;
}

export const EMPTY_BUDGET_USAGE: BudgetUsage = Object.freeze({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  callsByStep: Object.freeze({}),
});

export type BudgetLimitName = keyof BudgetLimits;

/**
 * Enforces a run's token and call budgets.
 *
 * The gateway calls {@link check} before every model call with an estimate (input text / 4,
 * plus the full output allowance), so a call that could overshoot is refused before any
 * tokens are spent, and {@link record} afterwards with the provider's reported usage.
 * Exceeding a budget raises `BUDGET_EXCEEDED`; the run stays resumable with higher limits.
 */
export class BudgetTracker {
  private limitsValue: BudgetLimits;
  private calls: number;
  private inputTokens: number;
  private outputTokens: number;
  private readonly callsByStep: Map<string, number>;
  private costUsd: number;
  private unpricedCalls: number;

  constructor(
    limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
    usage: BudgetUsage = EMPTY_BUDGET_USAGE,
  ) {
    checkLimits(limits);
    this.limitsValue = { ...limits };
    this.calls = usage.calls;
    this.inputTokens = usage.inputTokens;
    this.outputTokens = usage.outputTokens;
    this.callsByStep = new Map(Object.entries(usage.callsByStep));
    this.costUsd = usage.costUsd ?? 0;
    this.unpricedCalls = usage.unpricedCalls ?? 0;
  }

  get limits(): BudgetLimits {
    return { ...this.limitsValue };
  }

  /** Raises limits for a resumed run (`--max-*` overrides). Usage is kept. */
  setLimits(limits: BudgetLimits): void {
    checkLimits(limits);
    this.limitsValue = { ...limits };
  }

  /** Usage so far. `costUsd` is present once a priced call was made, `unpricedCalls` once an unpriced one was. */
  usage(): BudgetUsage {
    const priced = this.calls - this.unpricedCalls;
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      callsByStep: Object.fromEntries(this.callsByStep),
      ...(priced > 0 ? { costUsd: this.costUsd } : {}),
      ...(this.unpricedCalls > 0 ? { unpricedCalls: this.unpricedCalls } : {}),
    };
  }

  /**
   * Throws `BUDGET_EXCEEDED` when a call with this estimate could exceed a limit. The cost
   * limit is checked only when the estimate has a cost (the model has a price).
   */
  check(
    step: string,
    estimate: { inputTokens: number; outputTokens: number; costUsd?: number | undefined },
  ): void {
    const limits = this.limitsValue;
    const stepCalls = this.callsByStep.get(step) ?? 0;
    if (stepCalls + 1 > limits.maxCallsPerStep) {
      throw exceeded("maxCallsPerStep", step, stepCalls, 1, limits.maxCallsPerStep);
    }
    if (this.inputTokens + estimate.inputTokens > limits.maxInputTokens) {
      throw exceeded(
        "maxInputTokens",
        step,
        this.inputTokens,
        estimate.inputTokens,
        limits.maxInputTokens,
      );
    }
    if (this.outputTokens + estimate.outputTokens > limits.maxOutputTokens) {
      throw exceeded(
        "maxOutputTokens",
        step,
        this.outputTokens,
        estimate.outputTokens,
        limits.maxOutputTokens,
      );
    }
    if (
      limits.maxCostUsd !== undefined &&
      estimate.costUsd !== undefined &&
      this.costUsd + estimate.costUsd > limits.maxCostUsd
    ) {
      throw exceeded("maxCostUsd", step, this.costUsd, estimate.costUsd, limits.maxCostUsd);
    }
  }

  /** Records one completed model call; `costUsd` is undefined when its model has no price. */
  record(
    step: string,
    usage: { inputTokens: number; outputTokens: number },
    costUsd?: number,
  ): void {
    if (costUsd === undefined) this.unpricedCalls += 1;
    else this.costUsd += costUsd;
    this.calls += 1;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.callsByStep.set(step, (this.callsByStep.get(step) ?? 0) + 1);
  }
}

function checkLimits(limits: BudgetLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (name === "maxCostUsd") {
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new RangeError("budget limit maxCostUsd must be a positive number");
      }
    } else if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new RangeError(`budget limit ${name} must be a positive integer`);
    }
  }
}

const LIMIT_LABELS: Readonly<Record<BudgetLimitName, string>> = {
  maxInputTokens: "input-token budget of the run",
  maxOutputTokens: "output-token budget of the run",
  maxCallsPerStep: "model-call budget of the step",
  maxCostUsd: "cost budget (USD) of the run",
};

function exceeded(
  limit: BudgetLimitName,
  step: string,
  used: number,
  requested: number,
  max: number,
): DevflowError {
  const show = (value: number) => (limit === "maxCostUsd" ? `$${value.toFixed(4)}` : String(value));
  return new DevflowError(
    ErrorCode.BudgetExceeded,
    `the ${LIMIT_LABELS[limit]} would be exceeded in step "${step}": ` +
      `${show(used)} used + ${show(requested)} requested > ${show(max)}`,
    { details: { limit, step, used, requested, max } },
  );
}
