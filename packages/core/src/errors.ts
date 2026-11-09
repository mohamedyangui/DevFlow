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
  /** The test design still fails the deterministic test checks after a revision. */
  TestDesignInvalid: "TEST_DESIGN_INVALID",
  /** Test files written by a run were changed after they were written or approved. */
  TestFilesChanged: "TEST_FILES_CHANGED",
  /** The caller did not provide what is needed to run tests (modules, command policy). */
  TestRunnerUnavailable: "TEST_RUNNER_UNAVAILABLE",
  /** The implementation still fails the deterministic change checks after a revision. */
  ImplementationInvalid: "IMPLEMENTATION_INVALID",
  /** Files changed by a run's implementation were changed after they were written or approved. */
  ImplementationFilesChanged: "IMPLEMENTATION_FILES_CHANGED",
  /** A git operation of DevFlow's own failed (ADR 0012). */
  GitFailed: "GIT_FAILED",
  /** The working tree has uncommitted changes, so DevFlow does not start changing files. */
  GitTreeNotClean: "GIT_TREE_NOT_CLEAN",
  /** The run's branch is no longer checked out, so DevFlow does not write or commit. */
  GitBranchChanged: "GIT_BRANCH_CHANGED",
  /** The configured git isolation is not implemented (`workflow.git.isolation: worktree`). */
  GitIsolationUnsupported: "GIT_ISOLATION_UNSUPPORTED",
  /** A language adapter cannot be registered (bad id, unsupported API version, duplicate). */
  AdapterInvalid: "ADAPTER_INVALID",
  /** A language adapter returned data that does not match the core schemas. */
  AdapterOutputInvalid: "ADAPTER_OUTPUT_INVALID",
  /** A language adapter threw while analysing the repository or parsing results. */
  AdapterFailed: "ADAPTER_FAILED",
  /** No module matches a module id, or no adapter is registered for it. */
  ModuleNotFound: "MODULE_NOT_FOUND",
  /** A gate named on the command line is not one of the workspace's gates. */
  GateNotFound: "GATE_NOT_FOUND",
  /** A baseline given to `devflow verify` cannot be read or is not a saved verification. */
  VerificationBaselineInvalid: "VERIFICATION_BASELINE_INVALID",
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
