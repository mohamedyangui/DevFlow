# ADR 0015: Test intent and red/green evidence

- **Status:** Accepted, 2026-11-06. Implements refinement 2 of the Phase 1 approval. The
  classification rules exist in `@devflow/core` (`assessTestEvidence`,
  `verification/test-evidence.ts`) with tests. They are applied by the verification engine in
  Phases 3–4.

## Context

The architecture proposal treated a generated test that already passes on the baseline as
suspicious. That is right for tests of new behaviour, and wrong for tests that are meant to
protect existing behaviour. And a "failing" baseline test is only evidence if it actually ran:
a compilation error or a broken test runner proves nothing.

## Decision

Every acceptance criterion, and every test derived from it, has a **test intent**:

| Intent              | Purpose                                        | Expected on the baseline      |
| ------------------- | ---------------------------------------------- | ----------------------------- |
| `feature` (default) | Specifies new or changed behaviour             | Fails on an assertion ("red") |
| `regression`        | Protects behaviour that must not change        | Passes                        |
| `characterization`  | Records current behaviour before a refactoring | Passes                        |

Test outcomes are classified in detail: `passed`, `assertion_failure`, `runtime_error`,
`compile_error`, `infrastructure_error`, `timeout`, `not_found`, `skipped`, `not_executed`.

**Baseline assessment:**

- `compile_error`, `infrastructure_error`, `timeout`, `not_found`, `skipped` and `not_executed`
  are **never** evidence: the assessment is `invalid`. In particular, a test that fails to
  compile because the feature's classes do not exist yet is not valid red evidence.
- Feature tests: `assertion_failure` → `expected`; `passed` → `unexpected_pass`;
  `runtime_error` → `inconclusive` (an unexpected exception may mean a missing feature or a
  broken test; it needs review).
- Regression and characterization tests: `passed` → `expected`; anything else →
  `unexpected_failure`.

A feature test that passes on the baseline is **not automatically invalid**. It is reported as
`unexpected_pass` with a finding that the behaviour may already exist or that the test may not
exercise it, and it needs human review.

**After-change assessment:** `passed` → passed; `assertion_failure`, `runtime_error`,
`compile_error` → failed (a compile error after the change is a defect in the change);
`infrastructure_error`, `timeout`, `not_found`, `skipped`, `not_executed` → not verified.

**Red/green evidence is established** only when the baseline assessment is `expected` _and_
the after-change result is `passed`. The `TestEvidence` schema rejects records whose stored
assessment disagrees with these rules.

In Markdown tasks, intent is written as a trailing tag: `(regression)` or
`(characterization)`. In YAML and JSON it is `testIntent`.

## Consequences

- A test suite that does not compile on the baseline produces no red evidence at all, and the
  report says so instead of claiming test-first development happened.
- Regression ACs ("existing clients keep working") get correct treatment instead of a spurious
  finding.
- Even established red/green evidence shows the test detects the change; it does not prove
  business correctness. Reports say so.

## Alternatives considered

- **Treating every non-pass baseline as red.** Rejected: counts compile errors as evidence.
- **Rejecting every test that passes on the baseline.** Rejected: wrong for regression and
  characterization tests, and hides useful information for feature tests.
