/**
 * Workflow orchestrator: the typed state machine, the run store, the requirements-analysis and
 * planning steps, the deterministic checks of model answers, and the engineering report.
 *
 * Implemented (Phase 2): assist mode end to end (TASK_RECEIVED to COMPLETED through analysis,
 * clarification, planning and plan approval), resumable runs and reports. The guarded and
 * autonomous modes (test design, implementation, verification, review) arrive in Phase 4;
 * starting a run in those modes fails with WORKFLOW_MODE_NOT_IMPLEMENTED.
 */
export {
  STEP,
  answerQuestions,
  approvePlan,
  cancelRun,
  getRun,
  listRuns,
  rejectPlan,
  resumeRun,
  startRun,
  type ProgressEvent,
  type ResumeOverrides,
  type RunOutcome,
  type RunStatus,
  type RunSummary,
  type StartRunInput,
  type WorkflowServices,
} from "./engine.js";
export { checkAnalysis, checkPlan, taskIds } from "./checks.js";
export {
  ANALYSIS_TEMPLATE,
  PLAN_TEMPLATE,
  analysisPrompt,
  planPrompt,
  type PromptTemplate,
  type RenderedPrompt,
} from "./prompts.js";
export {
  buildReport,
  renderPlanMarkdown,
  renderReportMarkdown,
  type ReportInput,
} from "./report.js";
export { RUNS_DIRECTORY, RunStore, type RunEventInput } from "./run-store.js";
export {
  AnalysisWire,
  BudgetUsageRecord,
  ClarificationRecord,
  Clarifications,
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
} from "./schemas.js";
export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PROVIDER,
  resolveRunSettings,
  type SettingsOverrides,
} from "./settings.js";
export {
  IMPLEMENTED_MODES,
  MODE_TRANSITIONS,
  TRANSITIONS,
  assertModeImplemented,
  assertTransition,
  isTransitionAllowed,
} from "./transitions.js";
