import { z } from "zod";

/**
 * Workflow states and modes. The transition table and orchestrator are implemented in
 * @devflow/workflow (Phase 2); the vocabulary lives here because reports and run records
 * reference it.
 */
export const WorkflowState = z.enum([
  "TASK_RECEIVED",
  "CONTEXT_LOADING",
  "REQUIREMENTS_ANALYSIS",
  "CLARIFICATION_REQUIRED",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "TEST_DESIGN",
  "IMPLEMENTATION",
  "VERIFICATION",
  "REVIEW",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type WorkflowState = z.infer<typeof WorkflowState>;

export const TERMINAL_STATES: readonly WorkflowState[] = ["COMPLETED", "FAILED", "CANCELLED"];

export function isTerminalState(state: WorkflowState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * - assist: analyze and plan; never modifies code.
 * - test: derive and generate tests, then verify.
 * - implement: plan, approve, test design, implement, verify, review.
 * - review: verify and review existing changes; never modifies code.
 */
export const WorkflowMode = z.enum(["assist", "test", "implement", "review"]);
export type WorkflowMode = z.infer<typeof WorkflowMode>;
