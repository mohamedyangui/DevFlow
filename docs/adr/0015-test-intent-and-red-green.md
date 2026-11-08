# ADR 0015: Test intent and red/green evidence

- **Status:** Accepted, 2026-11-06. Implements refinement 2 of the architecture review. The
  classification rules exist in `@devflow/core` (`assessTestEvidence`,
  `verification/test-evidence.ts`) with tests. Test mode (`devflow test`, Phase 4) applies
  them to the baseline run; the after-change half arrives with the implementation step.
- **Deciders:** Mohamed Yangui

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

## Test mode (Phase 4)

`devflow test` produces the baseline half of the evidence:

1. The model writes tests for the automated criteria. Deterministic checks keep them to test
   files inside a module's test roots and require the criterion's marker in the new code, so
   that results can be linked to criteria without trusting the model.
2. A person approves the written files. The approval is bound to the hash of every file; a
   file changed after it was written cannot be approved.
3. The test gate of each affected module runs once, through the command policy, against the
   unchanged code.
4. Each result in a designed file that carries a criterion's marker becomes one evidence
   entry. A designed test without a result is never given an outcome it did not have: it is
   `not_executed` (the gate did not run), `timeout`, `compile_error` (an error diagnostic in
   the file), `infrastructure_error` (unreadable results) or `not_found`, all `invalid`.
5. The after-change outcome is `not_executed`, so nothing is `established` and no criterion is
   verified. Deterministic findings report every assessment other than `expected`, and every
   automated criterion without a test.

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
