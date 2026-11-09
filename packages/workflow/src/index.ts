/**
 * Workflow orchestrator: the typed state machine, the run store, the requirements-analysis and
 * planning steps, the deterministic checks of model answers, and the engineering report.
 *
 * Implemented: assist mode end to end (TASK_RECEIVED to COMPLETED through analysis,
 * clarification, planning and plan approval), resumable runs and reports (Phase 2), and test
 * mode (Phase 4): test design, approval of the written tests, the red run against the current
 * code and its deterministic review. Implement and review mode arrive later in Phase 4;
 * starting a run in those modes fails with WORKFLOW_MODE_NOT_IMPLEMENTED.
 */
export {
  STEP,
  answerQuestions,
  approvePlan,
  approveTests,
  cancelRun,
  getRun,
  listRuns,
  rejectPlan,
  rejectTests,
  resumeRun,
  startRun,
  type CommandDenial,
  type ProgressEvent,
  type ResumeOverrides,
  type RunOutcome,
  type RunStatus,
  type RunSummary,
  type StartRunInput,
  type TestRunner,
  type WorkflowServices,
} from "./engine.js";
export { checkAnalysis, checkPlan, taskIds } from "./checks.js";
export {
  ANALYSIS_TEMPLATE,
  PLAN_TEMPLATE,
  TEST_DESIGN_TEMPLATE,
  analysisPrompt,
  planPrompt,
  testDesignPrompt,
  type ExistingTestFile,
  type PromptTemplate,
  type RenderedPrompt,
} from "./prompts.js";
export {
  buildReport,
  renderPlanMarkdown,
  renderReportMarkdown,
  renderTestDesignMarkdown,
  type ReportInput,
} from "./report.js";
export { RUNS_DIRECTORY, RunStore, type RunEventInput } from "./run-store.js";
export {
  AnalysisWire,
  BaselineRun,
  BudgetUsageRecord,
  ClarificationRecord,
  Clarifications,
  DesignedTest,
  EvidenceEntry,
  PendingInput,
  PlanCheck,
  PlanChecks,
  PlanFeedback,
  PlanWire,
  RequirementsAnalysis,
  RunBudgets,
  RunError,
  RunEvent,
  RunGoal,
  RunId,
  RunRecord,
  RunSettings,
  TaskIssueRecord,
  TestApproval,
  TestDesign,
  TestDesignWire,
  TestEvidenceRecord,
  TestFeedback,
  TestFiles,
} from "./schemas.js";
export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PROVIDER,
  DEFAULT_TEST_DESIGN_OUTPUT_TOKENS,
  resolveRunSettings,
  type SettingsOverrides,
} from "./settings.js";
export {
  MAX_TEST_FILE_BYTES,
  applyEdits,
  baselineEvidence,
  baselineFindings,
  checkTestDesign,
  hasMarker,
  isTestPath,
  testFilesRecord,
  testsHash,
  type PlannedTestFile,
  type TestModule,
} from "./test-design.js";
export {
  IMPLEMENTED_MODES,
  MODE_TRANSITIONS,
  TRANSITIONS,
  assertModeImplemented,
  assertTransition,
  isTransitionAllowed,
} from "./transitions.js";
