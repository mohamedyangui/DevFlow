# ADR 0013: JSON report as source of truth, strict status semantics

- **Status:** Accepted, 2026-11-06. The report, gate and acceptance-matrix schemas and their
  invariants exist in `@devflow/core` (Phase 1). Report generation arrives in Phase 2.

## Context

The brief's central rule is that DevFlow must never report something as passed that was not
executed, and never present an unverified AI suspicion as a confirmed defect. Reports are read
by people and by machines (CI, dashboards).

## Decision

- The **JSON report** (`EngineeringReport`) is the source of truth. The Markdown report is
  rendered from it and adds nothing.
- **Workflow state and verdict are separate.** A run that reaches `COMPLETED` with failing
  tests has the verdict `failed_verification`. It is never a success.
- **Status values have fixed meanings** (see the
  [verification spec](../specs/verification-and-evidence.md)): `passed`, `failed`,
  `skipped`, `not_executed`, `unverified`.
- **The invariants are schema refinements**, so an inconsistent report cannot be constructed:
  - a gate that is `passed`, `failed` or `skipped` must have an execution record; a
    `not_executed` gate must not; `not_executed` and `unverified` gates need a reason;
  - a `passed` gate needs exit code 0, no timeout, and only passed or skipped tests;
  - an acceptance criterion is `verified` only with at least one linked test, every linked test
    `passed`;
  - the verdict `verified` requires state `COMPLETED`, at least one gate, every required gate
    passed, every automated acceptance criterion verified, and no confirmed critical or high
    finding;
  - a finding can be `confirmed` only with deterministic evidence; AI findings carry a
    confidence and stay `unverified` until such evidence exists.
- **Statuses are never upgraded** during aggregation: one unverified part makes the aggregate
  at most unverified.

## Consequences

- Code that builds reports cannot accidentally overstate results; the schema rejects it.
- Producers must carry evidence (execution records, parsed results) all the way to the report.

## Alternatives considered

- **Markdown-only reports.** Rejected: not machine-readable, not checkable.
- **Validating invariants in the report generator only.** Rejected: any other producer could
  bypass them.
