import type { TaskSource } from "../schemas/task.js";
import type { TaskFormat } from "../task/load.js";

/**
 * A source of task documents outside the local filesystem, e.g. GitHub issues (Phase 5),
 * and later Jira or Linear.
 *
 * Sources return raw text and never interpret it: the core task parser turns the text into a
 * task contract, so every source gets the same validation. Text from these sources is
 * `external` and is never treated as instructions that change DevFlow's policies.
 */
export interface IssueSource {
  /** e.g. `github`. */
  readonly id: string;
  fetch(reference: string, signal: AbortSignal): Promise<IssueTaskDocument>;
}

export interface IssueTaskDocument {
  readonly text: string;
  readonly format: TaskFormat;
  readonly source: TaskSource & { readonly trust: "external" };
}
