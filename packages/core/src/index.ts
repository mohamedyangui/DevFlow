/**
 * Public API of the DevFlow AI core package.
 *
 * - Schemas (Zod) and their inferred types for every artifact exchanged between components.
 * - Ports: the interfaces implemented by language adapters, LLM providers and issue sources.
 * - Task loading: parsing, normalization and deterministic validation of task documents.
 * - Verification rules that are part of the domain model (red/green evidence).
 */

// Errors
export { DevflowError, ErrorCode, isDevflowError } from "./errors.js";

// Schemas
export {
  AcceptanceCriterionId,
  Confidence,
  Evidence,
  FunctionalRequirementId,
  GitCommit,
  IsoDateTime,
  ModuleId,
  NonFunctionalRequirementId,
  RepoGlob,
  RepoPath,
  RequirementId,
  Sha256,
  SourceLocation,
  TaskId,
  checkRepoRelativePath,
} from "./schemas/primitives.js";
export {
  AcceptanceCriterion,
  AcceptanceCriterionInput,
  AcceptanceVerification,
  FunctionalRequirement,
  FunctionalRequirementInput,
  NonFunctionalCategory,
  NonFunctionalRequirement,
  NonFunctionalRequirementInput,
  Priority,
  TaskContract,
  TaskFile,
  TaskSource,
  TaskSourceKind,
  TrustLevel,
} from "./schemas/task.js";
export {
  CommandArgument,
  CommandExecutable,
  CommandPurpose,
  CommandSpec,
  ExecutionRecord,
  InvocationStrategy,
  ParamSpec,
} from "./schemas/command.js";
export {
  AfterAssessment,
  BaselineAssessment,
  Diagnostic,
  GateResult,
  ParsedCommandResults,
  ResultStatus,
  TestCaseResult,
  TestEvidence,
  TestIntent,
  TestLevel,
  TestOutcome,
} from "./schemas/verification.js";
export {
  ContractKind,
  ContractRelation,
  Detection,
  InferredConvention,
  ModuleCandidate,
  ModuleProfile,
  TestAuthoringGuide,
  TestInventory,
} from "./schemas/module.js";
export { Finding, Severity } from "./schemas/findings.js";
export {
  ClarificationQuestion,
  ImplementationPlan,
  PlannedChange,
  Risk,
  TestStrategyEntry,
} from "./schemas/plan.js";
export {
  AcceptanceMatrixRow,
  AcceptanceStatus,
  EngineeringReport,
  FileChange,
  UsageSummary,
  Verdict,
} from "./schemas/report.js";
export { ProjectConfig, type ProjectConfigInput } from "./schemas/config.js";
export {
  TERMINAL_STATES,
  WorkflowMode,
  WorkflowState,
  isTerminalState,
} from "./schemas/workflow.js";
export {
  AuditEntry,
  CommandAuditEntry,
  DecisionAuditEntry,
  FileWriteAuditEntry,
  LlmCallAuditEntry,
  RedactionAuditEntry,
} from "./schemas/audit.js";

// Security primitives
export {
  DEFAULT_PROTECTED_PATH_PATTERNS,
  HARD_PROTECTED_PATH_PATTERNS,
  SENSITIVE_PATH_PATTERNS,
  caseInsensitiveFileSystem,
  createPathMatcher,
  type PathMatcher,
} from "./security/path-patterns.js";
export {
  PathGuard,
  type GuardedPath,
  type PathAccess,
  type PathCheckRequest,
  type PathGuardOptions,
  type PathOrigin,
  type PathRejectionReason,
} from "./security/path-guard.js";
export {
  BUILT_IN_SECRET_DETECTORS,
  CREDENTIAL_ENV_NAME,
  SecretRedactor,
  credentialValuesFromEnv,
  redactionMarker,
  shannonEntropy,
  type Redaction,
  type RedactionResult,
  type SecretDetector,
  type SecretMatch,
  type SecretRedactorOptions,
} from "./security/secrets.js";
export {
  AuditLog,
  readAuditLog,
  type AuditEntryInput,
  type AuditLogOptions,
} from "./security/audit-log.js";
export {
  createLogger,
  silentLogger,
  type LogLevel,
  type LogRecord,
  type Logger,
  type LoggerOptions,
} from "./security/logger.js";

// Domain rules
export {
  assessAfterChange,
  assessBaseline,
  assessTestEvidence,
  statusForOutcome,
  type TestEvidenceAssessment,
} from "./verification/test-evidence.js";

// Ports
export type { RepositoryEntry, RepositoryView } from "./ports/repository-view.js";
export {
  LANGUAGE_ADAPTER_API_VERSION,
  type LanguageAdapter,
  type ToolAvailability,
  type ToolchainProbe,
} from "./ports/language-adapter.js";
export type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmTokenUsage,
} from "./ports/llm-provider.js";
export type { IssueSource, IssueTaskDocument } from "./ports/issue-source.js";

// Task loading and validation
export {
  MAX_TASK_FILE_BYTES,
  detectTaskFormat,
  loadTaskFile,
  parseTaskText,
  type LoadedTask,
  type TaskFormat,
  type TaskParseResult,
} from "./task/load.js";
export { parseMarkdownTask, type MarkdownTaskParseResult } from "./task/markdown.js";
export { normalizeTask } from "./task/normalize.js";
export { lintTask } from "./task/lint.js";
export { validateTaskInput, type TaskValidationResult } from "./task/validate.js";
export {
  TaskIssueCode,
  formatIssuePath,
  hasErrors,
  type IssuePath,
  type IssueSeverity,
  type ValidationIssue,
} from "./task/issues.js";

// JSON Schema generation
export { projectConfigJsonSchema, taskFileJsonSchema } from "./json-schema.js";
