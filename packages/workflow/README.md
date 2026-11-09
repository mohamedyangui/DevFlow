# @devflow/workflow

The workflow orchestrator: the typed state machine, the run store, the requirements-analysis and
planning steps, the deterministic checks of model answers, and the engineering report. The CLI
and future IDE integrations call the same functions.

**Status: assist mode (Phase 2), test mode and implement mode (Phase 4) are implemented.**
The `review` mode arrives with the review engine; starting a run in that mode fails with
`WORKFLOW_MODE_NOT_IMPLEMENTED` and creates nothing.

The package may depend on `@devflow/core`, `@devflow/context` and `@devflow/ai`. It never starts
processes itself: test mode runs gates through the `testRunner` its caller provides, which
goes through the command policy. In assist mode it never changes a repository file: it only
writes its own run directory. In test mode it writes only test files, after deterministic
checks, and restores them on rejection. In implement mode it also writes the production files
of the approved plan, after the same kind of checks, and restores them on rejection.

## Assist mode

```text
TASK_RECEIVED → CONTEXT_LOADING → REQUIREMENTS_ANALYSIS (⇄ CLARIFICATION_REQUIRED)
  → COMPLETED                                   (goal "analyze")
  → PLANNING → AWAITING_PLAN_APPROVAL → COMPLETED (approved)
                                      → PLANNING  (rejected with feedback)
  → PLANNING → COMPLETED                        (plan approval not required)
```

## Test mode

```text
... → PLANNING (→ AWAITING_PLAN_APPROVAL) → TEST_DESIGN (waits for test approval)
  → VERIFICATION (the red run) → REVIEW (deterministic findings) → COMPLETED
```

In `TEST_DESIGN` the model writes tests (`artifacts/test-design.json`), checked by
`checkTestDesign`: test files of a module only, writable paths, exact search and replace edits,
the criterion marker in the new code. The files are written and recorded with their hashes
(`artifacts/test-files.json`); the run waits with `pending.kind` `test-approval`. Approval runs
the test gate of each affected module once against the current code; the results become
red/green evidence (`artifacts/test-evidence.json`, [ADR 0015](../../docs/adr/0015-test-intent-and-red-green.md))
and findings (`artifacts/findings.json`). A command the policy refuses interrupts the run with
`COMMAND_NOT_APPROVED`; `resumeRun` with an approved runner continues it.

## Implement mode

```text
... → TEST_DESIGN (waits for test approval) → VERIFICATION (baseline: every gate)
  → IMPLEMENTATION (waits for change approval) → VERIFICATION (after the change)
      → IMPLEMENTATION (a repair, while attempts remain) → VERIFICATION → ...
      → REVIEW → COMPLETED
```

`checkImplementation` keeps the change to the plan's files, never a test file, with exact
edits; each file is written only if it still has the content the change was computed from
(`artifacts/change-files.json`, `artifacts/changed-files.json`). After an approved change every
gate runs, failed gates a second time (`assessAfterRun`: flaky tests, regressions, failures
already there, and whether to repair), and `afterEvidence` completes the red/green evidence.
The report's verdict follows section 7 of the
[verification spec](../../docs/specs/verification-and-evidence.md).

Any non-terminal state can move to `FAILED` or `CANCELLED`. The transition table and the edges
each mode may take are in `src/transitions.ts`
([ADR 0004](../../docs/adr/0004-state-machine-and-run-store.md)); a transition outside them
fails with `INVALID_TRANSITION`.

| Function             | What it does                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `startRun`           | Lints the task, creates the run and drives it until it finishes or needs a person               |
| `answerQuestions`    | Records answers to clarification questions; analyses again once no blocking question is open    |
| `approvePlan`        | Approves the plan awaiting approval (optionally only if its hash matches the reviewed one)      |
| `rejectPlan`         | Rejects the plan with feedback; plans again with the previous plan and the feedback             |
| `approveTests`       | Test mode: approves the written tests (optionally only if their hash matches), then runs them   |
| `rejectTests`        | Test mode: restores the files and writes the tests again with the feedback                      |
| `approveChanges`     | Implement mode: approves the written change (optionally only if its hash matches), then runs it |
| `rejectChanges`      | Implement mode: restores the files and writes the change again with the feedback                |
| `resumeRun`          | Continues an interrupted run from its current step; budgets, model and provider can be changed  |
| `cancelRun`          | Cancels an unfinished run and writes its report                                                 |
| `getRun`             | Reads a run and its outcome without changing it                                                 |
| `listRuns`           | Lists the runs of a workspace, oldest first                                                     |
| `resolveRunSettings` | Effective settings: command line, then trusted configuration, then environment, then defaults   |

Each call returns a `RunOutcome`: `completed`, `waiting` (for `plan-approval` or
`clarification`, with the open questions), `interrupted` (with the error; `resumeRun`
continues), `failed` or `cancelled`.

### Steps

- **Context loading** builds the context pack with `@devflow/context` and stores it.
- **Requirements analysis** asks the model for a structured analysis. The answer is data: notes
  about unknown requirement ids, files outside the context and repeated questions are dropped,
  and every drop is recorded in the artifact's `checks`. New questions get ids `Q-n` that
  continue across iterations.
- **Planning** asks for a plan and checks it deterministically: paths must be
  repository-relative and writable under the path guard (never `.git`, `.devflow`, secrets or
  protected paths), modified and deleted files must exist, created files must not, and the
  task's `scope.exclude` is enforced. Warnings cover files outside `scope.include`, unknown ids,
  criteria without a test strategy and requirements no change addresses. A plan with errors
  gets one revision; if the revision still fails, the run fails with `PLAN_INVALID`.
- **Report**: when a run reaches a terminal state, `report.json` (validated against
  `EngineeringReport`) and `report.md` are written. Assist mode runs no tests, so the verdict is
  always `not_verified` and every automated acceptance criterion is `not_executed`
  ([ADR 0013](../../docs/adr/0013-report-and-status-semantics.md)).

Prompt templates are versioned (`requirements-analysis` v1, `implementation-plan` v1), and the
template id and version are in every llm-call audit entry. Repository text, instructions from
`AGENTS.md`-like files and tasks from external sources are wrapped in untrusted-content
delimiters; only rules from a trusted configuration are given as rules.

### Failures and resume

| Failure                                                                  | Result                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `LLM_REFUSED`, `PLAN_INVALID`                                            | `FAILED`, with a report                                           |
| Budget exceeded, provider failure, invalid output, cancellation (Ctrl+C) | `interrupted`: the state is kept and `resumeRun` retries the step |
| A programming error                                                      | Recorded as `INTERNAL_ERROR` in `run.json`, then rethrown         |

## Run directory

`.devflow/runs/<run-id>/`, with ids such as `2026-11-07T10-21-33Z_TASK-142`:

| File                             | Content                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| `run.json`                       | State, settings, budget usage, iterations, pending input, last error |
| `events.jsonl`                   | Transitions, steps, decisions and resumes, numbered                  |
| `audit.jsonl`                    | llm-call, redaction and decision entries (redacted)                  |
| `artifacts/task.contract.json`   | The normalized task                                                  |
| `artifacts/context.json`         | The context pack                                                     |
| `artifacts/analysis.json`        | The latest requirements analysis                                     |
| `artifacts/clarifications.json`  | Every question and its answer                                        |
| `artifacts/plan.json`, `plan.md` | The latest plan, and its review view                                 |
| `artifacts/plan-checks.json`     | The deterministic checks of the latest plan                          |
| `artifacts/plan-feedback.json`   | Rejections with feedback                                             |
| `artifacts/plan-approval.json`   | Who approved which plan hash, and when                               |
| `logs/llm/*.json`                | Each model exchange (request and response, already redacted)         |
| `report.json`, `report.md`       | The engineering report, for terminal states                          |
| `lock.json`                      | Present while a process drives the run                               |

Files are written atomically (temporary file, then rename) before the state advances, and
every file is validated against its schema when read back; a hand-edited or truncated file is
reported as `RUN_CORRUPT`. Approving a plan whose `plan.json` was edited after it was generated
is refused. A lock left by a process that no longer runs on the same machine is taken over;
any other lock fails with `RUN_LOCKED`.
