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
  ConsumerConfidence,
  ConsumerKind,
  ConsumerMechanism,
  ConsumerRef,
  ContractImpact,
} from "./schemas/impact.js";
export {
  ClarificationQuestion,
  Contradiction,
  Dependency,
  EdgeCase,
  ImplementationPlan,
  PlannedChange,
  Risk,
  TestStrategyEntry,
} from "./schemas/plan.js";
export {
  AcceptanceMatrixRow,
  AcceptanceStatus,
  EngineeringReport,
  EvidenceProbe,
  FileChange,
  UsageSummary,
  Verdict,
} from "./schemas/report.js";
export {
  ContainerImage,
  ContainerSettings,
  ProjectConfig,
  type ProjectConfigInput,
} from "./schemas/config.js";
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
export {
  TrustStore,
  defaultTrustStorePath,
  type ApprovedCommandEntry,
  type TrustStoreOptions,
  type WorkspaceTrustEntry,
  type WorkspaceTrustStatus,
} from "./security/trust-store.js";
export { fingerprintCommand, type CommandBinding } from "./security/fingerprint.js";
export {
  CommandPolicy,
  hardDenyReason,
  isApprovedCommand,
  PYTHON_ALLOWED_MODULES,
  substituteParameters,
  toolName,
  type ApprovalVia,
  type ApprovedCommand,
  type CommandApprovalAnswer,
  type CommandApprovalRequest,
  type CommandApprover,
  type CommandPolicyOptions,
  type CommandRequest,
  type DenialReason,
  type PolicyDecision,
} from "./security/command-policy.js";
export {
  CHILD_ENV_ALLOWLIST,
  childEnvironment,
  isReservedEnvName,
} from "./security/environment.js";
export {
  findOnPath,
  resolveInvocation,
  resolveNodeShim,
  type Invocation,
  type InvocationContext,
} from "./security/invocation.js";
export {
  batchCommandLine,
  checkBatchArgument,
  cmdArguments,
  shimEntryPoint,
} from "./security/windows-invocation.js";
export {
  DEFAULT_MAX_OUTPUT_BYTES,
  Executor,
  decodeTail,
  type ContainerRuntimeOptions,
  type ExecuteOptions,
  type ExecutionResult,
  type ExecutorOptions,
} from "./security/executor.js";
export {
  CONTAINER_ENV_ALLOWLIST,
  CONTAINER_WORKSPACE,
  DOCKER_CLIENT_ENV,
  EXECUTION_BACKENDS,
  LOCAL_EXECUTION,
  containerEnvNames,
  containerName,
  containerWorkdir,
  dockerClientEnvironment,
  dockerImageInspectArgs,
  dockerKillArgs,
  dockerMountSource,
  dockerRunArgs,
  dockerStartFailure,
  executionTarget,
  imageInspectOutcome,
  resolveExecutionSettings,
  type ContainerExecutionSettings,
  type ContainerTarget,
  type DockerRunInput,
  type ExecutionBackendKind,
  type ExecutionSettings,
  type ExecutionTarget,
} from "./security/execution-backend.js";
export type { LaunchOptions, LaunchResult, Launcher } from "./security/executor.js";

// Project configuration
export {
  ConfigIssueCode,
  MAX_CONFIG_FILE_BYTES,
  PROJECT_CONFIG_PATH,
  loadProjectConfig,
  parseConfigText,
  type ConfigIssue,
  type LoadedProjectConfig,
} from "./config/load-config.js";

// Domain rules
export {
  assessAfterChange,
  assessBaseline,
  assessTestEvidence,
  statusForOutcome,
  type TestEvidenceAssessment,
} from "./verification/test-evidence.js";

// Verification engine
export {
  decideGate,
  defaultGates,
  runGate,
  runGates,
  verificationOutcome,
  withExecutionLogs,
  type GateDefinition,
  type GateDenial,
  type GateEvent,
  type GateOutcome,
  type GateSelection,
  type VerificationOptions,
  type VerificationRun,
} from "./verification/engine.js";
export {
  compareSnapshots,
  VerificationSnapshot,
  type SnapshotComparison,
  type TestChange,
} from "./verification/snapshot.js";

// Ports
export type { RepositoryEntry, RepositoryView } from "./ports/repository-view.js";
export type {
  ParsedSource,
  SourceFile,
  SourceImport,
  SourceParser,
  SourceSymbol,
  SourceSymbolKind,
} from "./ports/source-parser.js";
export {
  ADAPTER_API_VERSION,
  type LanguageAdapter,
  type TestToSelect,
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
export type { IssueSource, IssueTaskDocument, TaskDefaults } from "./ports/issue-source.js";

// Adapter SDK
export {
  ADAPTER_ID,
  DEFAULT_MANIFEST_BYTES,
  REPORT_FRESHNESS_TOLERANCE_MS,
  defineAdapter,
  detection,
  evidenceAt,
  fileEvidence,
  findLine,
  findLines,
  freshReportFiles,
  isRecord,
  isWithin,
  joinRepoPath,
  moduleIdFor,
  parseJsonOrUndefined,
  readTextIfPresent,
  relativeTo,
  repoDirname,
  runDetectors,
  unparseable,
  type AdapterDefinition,
  type DetectionStrategy,
  type ReportFile,
  type ResultParser,
  type ResultParserInput,
  type TextMatch,
} from "./adapters/sdk.js";
export { catalogProblems, checkIdentity, validatedAdapter } from "./adapters/validate.js";
export {
  apiVersionProblem,
  checkApiVersion,
  parseApiVersion,
  type ApiVersion,
} from "./adapters/api-version.js";
export {
  PLUGIN_EXPORT_NAME,
  PluginStore,
  addPlugin,
  defaultPluginStorePath,
  devflowHome,
  hashPlugin,
  importPlugin,
  loadInstalledPlugins,
  pluginFileStatus,
  pluginInstallDirectory,
  resolvePlugin,
  type AddPluginResult,
  type InstalledAdapters,
  type InstalledPlugin,
  type LoadedPlugin,
  type PluginFileStatus,
  type PluginHashes,
  type PluginManifest,
  type PluginOptions,
  type ResolvedPlugin,
} from "./adapters/plugins.js";
export {
  AdapterRegistry,
  findModule,
  type DeclaredModule,
  type ModuleDiscovery,
  type WorkspaceModule,
} from "./adapters/registry.js";
export {
  ContainerToolchainProbe,
  PathToolchainProbe,
  StaticToolchainProbe,
} from "./security/toolchain-probe.js";
export {
  GitClient,
  cutPatch,
  statusPaths,
  type GitClientOptions,
  type GitDiff,
  type GitDiffFile,
  type GitInspection,
  type GitWorkspace,
} from "./security/git.js";

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
