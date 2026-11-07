import { TaskContract, TaskFile, type TaskSource } from "../schemas/task.js";
import { hasErrors, issuesFromZodError, type ValidationIssue } from "./issues.js";
import { lintTask } from "./lint.js";
import { normalizeTask } from "./normalize.js";

export interface TaskValidationResult {
  /** True when there are no error-level issues. Warnings do not make a task invalid. */
  readonly valid: boolean;
  /** The normalized contract, when the input passed schema validation. */
  readonly contract: TaskContract | undefined;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Validates already-parsed task data (from YAML, JSON, Markdown or another source):
 * schema validation, then normalization, then deterministic lint.
 */
export function validateTaskInput(input: unknown, source: TaskSource): TaskValidationResult {
  const parsed = TaskFile.safeParse(input);
  if (!parsed.success) {
    return { valid: false, contract: undefined, issues: issuesFromZodError(parsed.error) };
  }
  // Normalization output must always satisfy the contract schema. A failure here is a bug in
  // DevFlow, not in the task, so it is thrown rather than reported as a task issue.
  const contract = TaskContract.parse(normalizeTask(parsed.data, source));
  const issues = lintTask(contract);
  return { valid: !hasErrors(issues), contract, issues };
}
