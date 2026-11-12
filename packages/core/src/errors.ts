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
  /** The container backend cannot run: Docker is not on PATH or its daemon does not answer. */
  ContainerRuntimeUnavailable: "CONTAINER_RUNTIME_UNAVAILABLE",
  /** The container backend has no image configured, or the image is not present locally. */
  ContainerImageUnavailable: "CONTAINER_IMAGE_UNAVAILABLE",
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
  /**
   * Agent mode (ADR 0027): the run needs the coding agent's answer to a model request. The run
   * stays resumable; the agent answers with `devflow agent answer` and the run continues.
   */
  AgentInputRequired: "AGENT_INPUT_REQUIRED",
  /** Agent mode: the answer does not belong to the request the run waits for. */
  AgentAnswerInvalid: "AGENT_ANSWER_INVALID",
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
  /** `git push` of a run's branch failed (rejected, no access, no network). */
  GitPushFailed: "GIT_PUSH_FAILED",
  /** The working tree has uncommitted changes, so DevFlow does not start changing files. */
  GitTreeNotClean: "GIT_TREE_NOT_CLEAN",
  /** The run's branch is no longer checked out, so DevFlow does not write or commit. */
  GitBranchChanged: "GIT_BRANCH_CHANGED",
  /** A review found no change since its base to review. */
  ReviewNoChanges: "REVIEW_NO_CHANGES",
  /** The configured git isolation is not implemented (`workflow.git.isolation: worktree`). */
  GitIsolationUnsupported: "GIT_ISOLATION_UNSUPPORTED",
  /**
   * A trace export cannot be used: an unknown `--trace` or `DEVFLOW_TRACE_EXPORT` value, or an
   * OTLP endpoint or header that DevFlow refuses (not https outside localhost, credentials in
   * the URL). Nothing was sent.
   */
  TraceExportRefused: "TRACE_EXPORT_REFUSED",
  /** A trace could not be written or sent (I/O error, timeout, HTTP status, size cap). */
  TraceExportFailed: "TRACE_EXPORT_FAILED",
  /** Command line options that cannot be used together, or not without another one. */
  OptionsInvalid: "OPTIONS_INVALID",
  /** Neither or both of a task file and an issue were given. */
  TaskSourceInvalid: "TASK_SOURCE_INVALID",
  /** A GitHub API request failed: network, HTTP status or an answer DevFlow cannot use. */
  GitHubRequestFailed: "GITHUB_REQUEST_FAILED",
  /** The GitHub repository is not a valid `owner/name` or cannot be found from the git remote. */
  GitHubRepositoryUnknown: "GITHUB_REPOSITORY_UNKNOWN",
  /** A GitHub issue cannot be a task: a bad reference, a pull request, or a body too long. */
  GitHubIssueInvalid: "GITHUB_ISSUE_INVALID",
  /** A pull request reference cannot be used (not a number, owner/name#number or URL). */
  GitHubPullRequestInvalid: "GITHUB_PULL_REQUEST_INVALID",
  /**
   * A run cannot become a pull request: not a finished implement-mode run, or no DevFlow
   * branch with commits, or the branch no longer contains the run's commits.
   */
  PullRequestRunInvalid: "PULL_REQUEST_RUN_INVALID",
  /**
   * The pull request target is refused: the branch is the base or the default branch, or the
   * `origin` remote is not the target repository.
   */
  PullRequestTargetInvalid: "PULL_REQUEST_TARGET_INVALID",
  /** The checked-out commit is not the head of the pull request to review. */
  ReviewPullRequestNotCheckedOut: "REVIEW_PULL_REQUEST_NOT_CHECKED_OUT",
  /** A language adapter cannot be registered (bad id, no display name, duplicate). */
  AdapterInvalid: "ADAPTER_INVALID",
  /** A language adapter targets an adapter API version this DevFlow cannot run (ADR 0023). */
  AdapterApiIncompatible: "ADAPTER_API_INCOMPATIBLE",
  /** An adapter plugin cannot be added or loaded: not found, no valid export, bad manifest. */
  PluginInvalid: "PLUGIN_INVALID",
  /** An installed adapter plugin's files changed since it was added; it is not loaded. */
  PluginChanged: "PLUGIN_CHANGED",
  /** No installed adapter plugin has this id. */
  PluginNotFound: "PLUGIN_NOT_FOUND",
  /** The plugin list (`plugins.json`) exists but is not valid; no plugin is loaded. */
  PluginStoreInvalid: "PLUGIN_STORE_INVALID",
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
  /** A contract file given to `devflow contracts diff` is missing, unreadable or not a contract. */
  ContractFileInvalid: "CONTRACT_FILE_INVALID",
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
