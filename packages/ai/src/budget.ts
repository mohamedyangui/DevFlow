import { DevflowError, ErrorCode } from "@devflow/core";

/** Limits for one run. Cost limits arrive with the price table (Phase 4). */
export interface BudgetLimits {
  /** Input tokens across every model call of the run. */
  readonly maxInputTokens: number;
  /** Output tokens across every model call of the run. */
  readonly maxOutputTokens: number;
  /** Model calls within one workflow step, repairs included. */
  readonly maxCallsPerStep: number;
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
  }

  get limits(): BudgetLimits {
    return { ...this.limitsValue };
  }

  /** Raises limits for a resumed run (`--max-*` overrides). Usage is kept. */
  setLimits(limits: BudgetLimits): void {
    checkLimits(limits);
    this.limitsValue = { ...limits };
  }

  usage(): BudgetUsage {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      callsByStep: Object.fromEntries(this.callsByStep),
    };
  }

  /** Throws `BUDGET_EXCEEDED` when a call with this estimate could exceed a limit. */
  check(step: string, estimate: { inputTokens: number; outputTokens: number }): void {
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
  }

  /** Records one completed model call. */
  record(step: string, usage: { inputTokens: number; outputTokens: number }): void {
    this.calls += 1;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.callsByStep.set(step, (this.callsByStep.get(step) ?? 0) + 1);
  }
}

function checkLimits(limits: BudgetLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new RangeError(`budget limit ${name} must be a positive integer`);
    }
  }
}

const LIMIT_LABELS: Readonly<Record<BudgetLimitName, string>> = {
  maxInputTokens: "input-token budget of the run",
  maxOutputTokens: "output-token budget of the run",
  maxCallsPerStep: "model-call budget of the step",
};

function exceeded(
  limit: BudgetLimitName,
  step: string,
  used: number,
  requested: number,
  max: number,
): DevflowError {
  return new DevflowError(
    ErrorCode.BudgetExceeded,
    `the ${LIMIT_LABELS[limit]} would be exceeded in step "${step}": ` +
      `${used} used + ${requested} requested > ${max}`,
    { details: { limit, step, used, requested, max } },
  );
}
