# ADR 0004: Hand-written state machine and file-based run store

- **Status:** Accepted, 2026-11-06. Implemented in Phase 2 for assist mode
  (`@devflowai/workflow`); the other modes' steps arrive in Phase 4.
- **Deciders:** Mohamed Yangui

## Context

A DevFlow run moves through a fixed set of states (task received, context loading, analysis,
clarification, planning, plan approval, test design, implementation, verification, review,
and the terminal states). Runs pause for human input (approval, clarification), can be
interrupted, and must be resumable. Every intermediate artifact must be inspectable by a human
and usable as evidence.

## Decision

- The workflow is a **typed transition table** written by hand in `@devflowai/workflow`. A
  transition not in the table, or not allowed by the active mode (`assist`, `test`,
  `implement`, `review`), fails with `INVALID_TRANSITION`.
- **Workflow status is separate from the result verdict.** `COMPLETED` means the workflow ran
  to the end; the report's verdict (ADR 0013) says whether the result was verified.
- Runs are persisted in a **file-based run store** under `.devflow/runs/<run-id>/`:
  `run.json` (state), `events.jsonl` (append-only transitions), `audit.jsonl`, step artifacts
  as JSON, raw logs, and the report.
- Every artifact is written atomically (temporary file, then rename) **before** the state
  advances. Resume restarts at the first incomplete step.

## Consequences

- No database and no service: a run can be inspected with a text editor and attached to a bug
  report.
- The transition table is small enough to test exhaustively.
- Concurrency between two DevFlow processes on the same run is not supported; the run store
  takes a lock file.

## Alternatives considered

- **XState.** Rejected: the machine is small and linear, and a library adds a DSL contributors
  must learn.
- **Temporal or another workflow engine.** Rejected: a server dependency for a local CLI.
- **SQLite.** Rejected for the MVP: binary files are harder to review and diff than JSON.

## Implementation notes (Phase 2)

- Assist mode ends without changing code, so its table has three edges to `COMPLETED` that the
  other modes do not take: `REQUIREMENTS_ANALYSIS → COMPLETED` (`devflow analyze`),
  `PLANNING → COMPLETED` (plan approval not required) and `AWAITING_PLAN_APPROVAL → COMPLETED`
  (plan approved). The transition table is tested exhaustively for every mode and pair of
  states.
- The lock is `lock.json` (process id, host name, time), created exclusively. A lock whose
  process no longer runs on the same machine is stale and taken over; a lock from another
  machine is never considered stale.
- Steps write their artifacts, then update `run.json`, then append to `events.jsonl`. A crash
  between the two leaves the state at the step, which runs again on resume; a step's results
  are recomputed, never half-applied.
- Failures that retrying cannot fix (`LLM_REFUSED`, `PLAN_INVALID`) move the run to `FAILED`.
  Others (budget, provider failure, invalid output, cancellation) leave the run in its state
  with a resumable `lastError`; `devflow resume` can raise the budgets or change the model.
- Every file of a run is validated against its schema when read; an invalid file is
  `RUN_CORRUPT`. A plan whose hash differs from the one awaiting approval cannot be approved.
