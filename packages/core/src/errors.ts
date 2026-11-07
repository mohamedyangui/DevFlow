/**
 * Stable error codes for failures that prevent an operation from running at all.
 * Problems with the *content* of a task or config are reported as `ValidationIssue`s instead.
 * New codes are added together with the feature that raises them.
 */
export const ErrorCode = {
  TaskFileNotFound: "TASK_FILE_NOT_FOUND",
  TaskFileNotAFile: "TASK_FILE_NOT_A_FILE",
  TaskFileUnreadable: "TASK_FILE_UNREADABLE",
  TaskFileTooLarge: "TASK_FILE_TOO_LARGE",
  TaskUnsupportedFormat: "TASK_UNSUPPORTED_FORMAT",
  /** A path was refused by the path guard (escape, device name, protected or sensitive path). */
  PathRejected: "PATH_REJECTED",
  /** The workspace root does not exist or is not a directory. */
  WorkspaceInvalid: "WORKSPACE_INVALID",
  /** An audit entry did not match its schema; nothing was written. */
  AuditEntryInvalid: "AUDIT_ENTRY_INVALID",
  /** An audit log file could not be parsed. */
  AuditLogCorrupt: "AUDIT_LOG_CORRUPT",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class DevflowError extends Error {
  override readonly name = "DevflowError";
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function isDevflowError(value: unknown): value is DevflowError {
  return value instanceof DevflowError;
}
