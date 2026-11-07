import {
  DevflowError,
  ErrorCode,
  type WorkflowMode,
  type WorkflowState,
  isTerminalState,
} from "@devflow/core";

/**
 * The transition table (ADR 0004, architecture proposal section 4.1). Every non-terminal state
 * may also move to FAILED or CANCELLED; terminal states have no successors.
 */
export const TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  TASK_RECEIVED: ["CONTEXT_LOADING"],
  CONTEXT_LOADING: ["REQUIREMENTS_ANALYSIS", "VERIFICATION"],
  REQUIREMENTS_ANALYSIS: ["CLARIFICATION_REQUIRED", "PLANNING", "VERIFICATION", "COMPLETED"],
  CLARIFICATION_REQUIRED: ["REQUIREMENTS_ANALYSIS"],
  PLANNING: ["AWAITING_PLAN_APPROVAL", "TEST_DESIGN", "COMPLETED"],
  AWAITING_PLAN_APPROVAL: ["TEST_DESIGN", "PLANNING", "COMPLETED"],
  TEST_DESIGN: ["IMPLEMENTATION", "VERIFICATION"],
  IMPLEMENTATION: ["VERIFICATION"],
  VERIFICATION: ["IMPLEMENTATION", "REVIEW"],
  REVIEW: ["COMPLETED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

type Edge = `${WorkflowState}->${WorkflowState}`;

/**
 * Transitions each mode may take, on top of FAILED and CANCELLED (section 4.2). Assist mode
 * never modifies code: it ends after analysis (`analyze`) or after the plan, approved or not.
 */
export const MODE_TRANSITIONS: Readonly<Record<WorkflowMode, ReadonlySet<Edge>>> = {
  assist: new Set<Edge>([
    "TASK_RECEIVED->CONTEXT_LOADING",
    "CONTEXT_LOADING->REQUIREMENTS_ANALYSIS",
    "REQUIREMENTS_ANALYSIS->CLARIFICATION_REQUIRED",
    "CLARIFICATION_REQUIRED->REQUIREMENTS_ANALYSIS",
    "REQUIREMENTS_ANALYSIS->PLANNING",
    "REQUIREMENTS_ANALYSIS->COMPLETED",
    "PLANNING->AWAITING_PLAN_APPROVAL",
    "PLANNING->COMPLETED",
    "AWAITING_PLAN_APPROVAL->PLANNING",
    "AWAITING_PLAN_APPROVAL->COMPLETED",
  ]),
  test: new Set<Edge>([
    "TASK_RECEIVED->CONTEXT_LOADING",
    "CONTEXT_LOADING->REQUIREMENTS_ANALYSIS",
    "REQUIREMENTS_ANALYSIS->CLARIFICATION_REQUIRED",
    "CLARIFICATION_REQUIRED->REQUIREMENTS_ANALYSIS",
    "REQUIREMENTS_ANALYSIS->PLANNING",
    "PLANNING->AWAITING_PLAN_APPROVAL",
    "PLANNING->TEST_DESIGN",
    "AWAITING_PLAN_APPROVAL->PLANNING",
    "AWAITING_PLAN_APPROVAL->TEST_DESIGN",
    "TEST_DESIGN->VERIFICATION",
    "VERIFICATION->REVIEW",
    "REVIEW->COMPLETED",
  ]),
  implement: new Set<Edge>([
    "TASK_RECEIVED->CONTEXT_LOADING",
    "CONTEXT_LOADING->REQUIREMENTS_ANALYSIS",
    "REQUIREMENTS_ANALYSIS->CLARIFICATION_REQUIRED",
    "CLARIFICATION_REQUIRED->REQUIREMENTS_ANALYSIS",
    "REQUIREMENTS_ANALYSIS->PLANNING",
    "PLANNING->AWAITING_PLAN_APPROVAL",
    "PLANNING->TEST_DESIGN",
    "AWAITING_PLAN_APPROVAL->PLANNING",
    "AWAITING_PLAN_APPROVAL->TEST_DESIGN",
    "TEST_DESIGN->IMPLEMENTATION",
    "IMPLEMENTATION->VERIFICATION",
    "VERIFICATION->IMPLEMENTATION",
    "VERIFICATION->REVIEW",
    "REVIEW->COMPLETED",
  ]),
  review: new Set<Edge>([
    "TASK_RECEIVED->CONTEXT_LOADING",
    "CONTEXT_LOADING->REQUIREMENTS_ANALYSIS",
    "CONTEXT_LOADING->VERIFICATION",
    "REQUIREMENTS_ANALYSIS->CLARIFICATION_REQUIRED",
    "CLARIFICATION_REQUIRED->REQUIREMENTS_ANALYSIS",
    "REQUIREMENTS_ANALYSIS->VERIFICATION",
    "VERIFICATION->REVIEW",
    "REVIEW->COMPLETED",
  ]),
};

/** Modes whose steps exist. The others arrive in Phases 3 and 4. */
export const IMPLEMENTED_MODES: readonly WorkflowMode[] = ["assist"];

export function isTransitionAllowed(
  mode: WorkflowMode,
  from: WorkflowState,
  to: WorkflowState,
): boolean {
  if (isTerminalState(from)) return false;
  if (to === "FAILED" || to === "CANCELLED") return true;
  return TRANSITIONS[from].includes(to) && MODE_TRANSITIONS[mode].has(`${from}->${to}`);
}

/** Throws `INVALID_TRANSITION` unless the transition is in the table and allowed by the mode. */
export function assertTransition(mode: WorkflowMode, from: WorkflowState, to: WorkflowState): void {
  if (!isTransitionAllowed(mode, from, to)) {
    throw new DevflowError(
      ErrorCode.InvalidTransition,
      `the transition ${from} -> ${to} is not allowed in ${mode} mode`,
      { details: { mode, from, to } },
    );
  }
}

/** Throws `WORKFLOW_MODE_NOT_IMPLEMENTED` for modes whose steps do not exist yet. */
export function assertModeImplemented(mode: WorkflowMode): void {
  if (!IMPLEMENTED_MODES.includes(mode)) {
    throw new DevflowError(
      ErrorCode.WorkflowModeNotImplemented,
      `${mode} mode is not implemented yet: assist mode is available, and the test, ` +
        "implement and review modes arrive in Phase 4",
      { details: { mode } },
    );
  }
}
