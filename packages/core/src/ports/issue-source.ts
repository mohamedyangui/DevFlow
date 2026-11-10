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
  /**
   * Fields the issue itself supplies outside its text (its number as the id, its title). They
   * are used only when the text does not define the field.
   */
  readonly defaults?: TaskDefaults;
  /** Facts about the issue a person should know (for example that it is closed). */
  readonly warnings?: readonly string[];
}

export interface TaskDefaults {
  readonly id?: string;
  readonly title?: string;
}
