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
  /** `.devflow/config.yaml` exists but cannot be used (not a file, too large, not UTF-8). */
  ConfigFileUnreadable: "CONFIG_FILE_UNREADABLE",
  /** The trust store file exists but is not valid; nothing is trusted until it is fixed. */
  TrustStoreInvalid: "TRUST_STORE_INVALID",
  /** The executor was given a command that did not come from the command policy. */
  CommandNotApproved: "COMMAND_NOT_APPROVED",
  /** The executable of a command could not be found or is not allowed to run. */
  ExecutableNotFound: "EXECUTABLE_NOT_FOUND",
  /** An argument cannot be passed safely to a Windows batch file (ADR 0014). */
  CommandArgumentRejected: "COMMAND_ARGUMENT_REJECTED",
  /** The operating system could not start the process. */
  ProcessStartFailed: "PROCESS_START_FAILED",
  /** A repository file cannot be read for analysis (sensitive, binary, too large, missing). */
  RepositoryFileUnreadable: "REPOSITORY_FILE_UNREADABLE",
  /** A model call would exceed the run's token budget or the step's call budget. */
  BudgetExceeded: "BUDGET_EXCEEDED",
  /** The model provider cannot be used: unknown provider, no model, no API key, no SDK. */
  LlmProviderNotConfigured: "LLM_PROVIDER_NOT_CONFIGURED",
  /** A model call failed, after retries when the failure was transient. */
  LlmRequestFailed: "LLM_REQUEST_FAILED",
  /** The model declined the request. */
  LlmRefused: "LLM_REFUSED",
  /** The model stopped at the output token limit before finishing its answer. */
  LlmOutputTruncated: "LLM_OUTPUT_TRUNCATED",
  /** The model's answer did not match the expected schema, even after a repair attempt. */
  LlmOutputInvalid: "LLM_OUTPUT_INVALID",
  /** A replay cassette has no recorded response for a request. */
  ReplayCassetteMiss: "REPLAY_CASSETTE_MISS",
  /** A replay cassette file cannot be read or does not match its schema. */
  ReplayCassetteInvalid: "REPLAY_CASSETTE_INVALID",
  /** The operation was cancelled by the caller (for example Ctrl+C). */
  Cancelled: "CANCELLED",
  /** A state transition is not in the transition table or not allowed in the run's mode. */
  InvalidTransition: "INVALID_TRANSITION",
  /** The workflow mode exists in the design but is not implemented yet. */
  WorkflowModeNotImplemented: "WORKFLOW_MODE_NOT_IMPLEMENTED",
  /** No run with this id exists in the workspace. */
  RunNotFound: "RUN_NOT_FOUND",
  /** Another DevFlow process holds the run's lock. */
  RunLocked: "RUN_LOCKED",
  /** A run's files cannot be read or do not match their schemas. */
  RunCorrupt: "RUN_CORRUPT",
  /** The run is not waiting for this input (for example, approve when no plan awaits approval). */
  RunNotAwaitingInput: "RUN_NOT_AWAITING_INPUT",
  /** A decision's input is unusable: answers to unknown questions, empty answers or feedback. */
  DecisionInputInvalid: "DECISION_INPUT_INVALID",
  /** The task cannot start a run (it is invalid). */
  TaskInvalid: "TASK_INVALID",
  /** The plan still fails the deterministic plan checks after a revision. */
  PlanInvalid: "PLAN_INVALID",
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
