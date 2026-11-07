/**
 * Process exit codes. Codes reserved for later phases are listed in docs/specs/cli.md and are
 * added here only together with the commands that use them.
 */
export const ExitCode = {
  /** The command succeeded. */
  Success: 0,
  /** The command ran and found a problem (for example an invalid task). */
  Failure: 1,
  /** Usage error: unknown command or option, missing argument, unusable input file. */
  UsageError: 2,
  /** An unexpected internal error (a bug in DevFlow). */
  InternalError: 70,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
