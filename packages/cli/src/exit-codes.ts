/**
 * Process exit codes. Codes reserved for later phases are listed in docs/specs/cli.md and are
 * added here only together with the commands that use them.
 */
export const ExitCode = {
  /** The command succeeded. */
  Success: 0,
  /**
   * The command ran and the result is negative: an invalid task, a failed run, a run that was
   * interrupted by a provider failure, a locked or corrupt run.
   */
  Failure: 1,
  /** Usage error: unknown command or option, missing argument, unusable input file. */
  UsageError: 2,
  /** The run is waiting for a person: plan approval or answers to clarification questions. */
  WaitingForInput: 3,
  /** A token or call budget was reached; `devflow resume` with a higher limit continues. */
  BudgetExceeded: 4,
  /**
   * The command policy did not let a required command run: the workspace is not trusted, or
   * the command was not approved or was rejected. Nothing negative is known about the code.
   */
  PolicyDenied: 5,
  /** An unexpected internal error (a bug in DevFlow). */
  InternalError: 70,
  /** Interrupted by Ctrl+C; `devflow resume` continues. */
  Interrupted: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
