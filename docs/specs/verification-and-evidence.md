# Specification: verification, evidence and statuses

- **Status:** The schemas and rules below exist in `@devflow/core` with tests (Phase 1):
  `TestOutcome`, `ResultStatus`, `assessTestEvidence` and `statusForOutcome`
  (`verification/test-evidence.ts`), `TestEvidence`, `TestCaseResult`, `GateResult`,
  `ParsedCommandResults` (`schemas/verification.ts`), `Finding` (`schemas/findings.ts`),
  `AcceptanceMatrixRow` and `EngineeringReport` (`schemas/report.ts`). Nothing executes
  verification yet: the executor arrives in Phase 2, adapters and `devflow verify` in Phase 3,
  the red/green workflow in Phase 4.

## 1. Statuses

| Status         | Meaning                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`       | Executed, and the result was parsed as a success. Requires an execution record and parsed evidence.                                                                                                   |
| `failed`       | Executed, and failures were detected.                                                                                                                                                                 |
| `skipped`      | Executed, and the tool reported a skip.                                                                                                                                                               |
| `not_executed` | Not run: toolchain missing, workspace not trusted, approval denied, budget exhausted, upstream failure, or (for a single test) it failed to compile or was not found. A reason is required for gates. |
| `unverified`   | Executed but no trustworthy outcome (timeout, infrastructure error, unparseable output), or no executable evidence exists. A reason is required for gates.                                            |

Statuses are never upgraded during aggregation.

## 2. Test outcomes

| Outcome                | Report status                       |
| ---------------------- | ----------------------------------- |
| `passed`               | `passed`                            |
| `assertion_failure`    | `failed`                            |
| `runtime_error`        | `failed`                            |
| `skipped`              | `skipped`                           |
| `compile_error`        | `not_executed` (the test never ran) |
| `not_found`            | `not_executed`                      |
| `not_executed`         | `not_executed`                      |
| `infrastructure_error` | `unverified`                        |
| `timeout`              | `unverified`                        |

`TestCaseResult` rejects a status that disagrees with this table.

## 3. Test intent and red/green evidence

See [ADR 0015](../adr/0015-test-intent-and-red-green.md) for the rationale.

| Intent                           | Baseline outcome                                                                           | Baseline assessment                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| any                              | `compile_error`, `infrastructure_error`, `timeout`, `not_found`, `skipped`, `not_executed` | `invalid` (never evidence)                                   |
| `feature`                        | `assertion_failure`                                                                        | `expected` (valid red)                                       |
| `feature`                        | `passed`                                                                                   | `unexpected_pass` (review needed; not automatically invalid) |
| `feature`                        | `runtime_error`                                                                            | `inconclusive`                                               |
| `regression`, `characterization` | `passed`                                                                                   | `expected`                                                   |
| `regression`, `characterization` | anything else that ran                                                                     | `unexpected_failure`                                         |

After the change: `passed` → `passed`; `assertion_failure`, `runtime_error`, `compile_error` →
`failed`; everything else → `not_verified`.

Evidence is **established** only when the baseline assessment is `expected` and the after
assessment is `passed`. Established evidence shows the test detects the change. It does not
prove business correctness, and reports say so.

## 4. Gates

A gate runs one catalog command for one module (for example `backend-test`). `GateResult`
invariants:

- `passed`, `failed`, `skipped` → an execution record is required;
- `not_executed` → no execution record, and a reason;
- `unverified` → a reason;
- `passed` → exit code 0, no timeout, and every parsed test `passed` or `skipped`.

## 5. Acceptance criteria

The acceptance matrix links each criterion to its tests:

- `verified` — at least one linked test, and every linked test `passed` **in this run**;
- `failed` — at least one linked test `failed`;
- `manual` — exactly the criteria with `verification: manual`;
- `unverified`, `not_executed` — otherwise.

Traceability chain: requirement → acceptance criterion → test (file and id, with an AC marker
in the test name) → test result → evidence (command, exit code, report file hash, log excerpt).

## 6. Findings

- `source`: `deterministic` or `ai`. AI findings must carry a confidence.
- `verification`: `confirmed`, `unverified` or `refuted`. A finding can be `confirmed`
  **only with deterministic evidence**. An AI suspicion without such evidence stays
  `unverified`; it is never presented as a confirmed defect.
- A test that passed on the baseline and fails after the change is a **regression**, a
  deterministic confirmed finding. Tests already failing on the baseline are listed separately
  and not attributed to the change. A failing test is rerun once; inconsistent results mark it
  flaky and the finding stays unverified.

## 7. Report verdict

`EngineeringReport` exists only for terminal workflow states. Its verdict is one of
`verified`, `partially_verified`, `failed_verification`, `not_verified`. `verified` requires:

- state `COMPLETED`;
- at least one gate, and every required gate `passed`;
- every automated acceptance criterion `verified`;
- no confirmed finding of severity `critical` or `high`.

The schema rejects any report that claims `verified` without meeting these conditions.
