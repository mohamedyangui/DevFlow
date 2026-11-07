# ADR 0004: Hand-written state machine and file-based run store

- **Status:** Accepted, 2026-11-06. Implementation in Phase 2. Phase 1 defines only the
  `WorkflowState` and `WorkflowMode` schemas in `@devflow/core`.

## Context

A DevFlow run moves through a fixed set of states (task received, context loading, analysis,
clarification, planning, plan approval, test design, implementation, verification, review,
and the terminal states). Runs pause for human input (approval, clarification), can be
interrupted, and must be resumable. Every intermediate artifact must be inspectable by a human
and usable as evidence.

## Decision

- The workflow is a **typed transition table** written by hand in `@devflow/workflow`. A
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
  will take a lock file.

## Alternatives considered

- **XState.** Rejected: the machine is small and linear, and a library adds a DSL contributors
  must learn.
- **Temporal or another workflow engine.** Rejected: a server dependency for a local CLI.
- **SQLite.** Rejected for the MVP: binary files are harder to review and diff than JSON.
