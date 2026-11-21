# ADR 0030: A committed criteria ledger, rechecked by every verification

- **Status:** Proposed, 2026-11-16. Not implemented; planned for 0.3.0
  ([issue #50](https://github.com/mohamedyangui/DevFlow/issues/50)).
- **Deciders:** Mohamed Yangui

## Context

DevFlow proves a task's acceptance criteria once: an implement run links each criterion to
its tests (an `AC-n` marker in the test title), runs them before and after the change, and
records the result in the run's acceptance matrix (`report.json`: per criterion, the test ids,
gate ids, statuses and red/green evidence). After the run, nothing looks at those criteria
again. A later task can break a criterion that was verified, and DevFlow only reports it as a
failing test, without saying which earlier requirement it broke. An early reader named this
recheck the feature they would use most.

What exists already:

- `devflow verify --baseline` and implement mode compare test results by gate id and test id,
  and count "passed before, failed after" as a confirmed regression
  ([verification spec](../specs/verification-and-evidence.md), sections 4 and 6).
- The acceptance matrix of each finished run names the exact tests behind each criterion.
- Run directories (`.devflow/runs/`) are local: `devflow init` adds them to `.gitignore`. A
  colleague, a CI job or a fresh clone does not have them.
- `AC-n` ids are numbered per task. `AC-1` of one task and `AC-1` of another are unrelated,
  so the marker alone cannot attribute a test to an earlier task.

## Decision

**A criteria ledger in the repository.** `.devflow/criteria/<task-id>.json`, one file per
task, committed with the code. It records, for each criterion that was `verified` with
red/green evidence established: the criterion id and statement, the requirement ids it
covers, and the exact linked tests (gate id, test file, test id), with the run id, the commit
and the date it was verified, the task id, and the SHA-256 of the normalized task. It is a
strict Zod schema in `@devflowai/core` (`CriteriaLedger`, `schemaVersion: 1`), with a
generated JSON Schema, at most 256 KiB per file, read through the path guard like the
configuration. One file per task keeps parallel pull requests from conflicting.

**Written by implement mode, on its branch.** When an implement run completes, the criteria
it verified with established red/green evidence are written to the task's ledger file in the
run's branch commit, so the ledger reaches `main` through the same pull request as the code
and is reviewed with it. A criterion that is `manual`, `unverified`, `failed` or
`not_executed` is never written. Running a task again replaces its file.

**Checked by every verification, without extra test runs.** When ledger files exist,
`devflow verify` matches the test results it has just parsed against every recorded
criterion, by gate id and test id. Each recorded criterion gets one status:

| Status           | When                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `still_verified` | every linked test ran and passed                                                               |
| `regressed`      | at least one linked test failed (in workflows, after the usual single rerun of a failing test) |
| `unverifiable`   | a linked test is no longer reported: deleted, renamed, or its gate no longer exists            |
| `not_executed`   | the gate did not run (denied by the command policy, skipped, or filtered out with `--gate`)    |

A criterion is never `still_verified` without every linked test having passed in this run,
and an unverifiable one is never counted as passed. Text output adds one line
("Earlier criteria: 14 still verified, 1 regressed, 1 unverifiable") followed by the
regressed and unverifiable criteria with task, criterion, statement and test; `--json` adds a
`criteria` object with every status. A regression makes `verify` exit with the failure code.

**Implement mode and review mode report it.** Their reports gain an "Earlier criteria"
section from the after-change (implement) or reviewed-state (review) gate results. A
`regressed` earlier criterion is a deterministic, confirmed finding of severity `high`, with
the failing test as evidence, so the run cannot get the `verified` verdict: deterministic
evidence shows that verified work broke. Criteria of the run's own task are excluded (the run
is re-verifying them anyway). The MCP tool `devflow_verify` returns the same `criteria`
object.

**Retiring a criterion is a person's decision.** A new task may change earlier behaviour on
purpose. `devflow criteria retire <task-id> <AC-n> --reason <text>` removes the criterion
from the ledger and keeps a `retired` entry with the reason and date, so the change is visible
in the pull request diff. DevFlow never retires, relinks or rewrites a criterion on its own,
and a model never edits the ledger.

**Commands.** `devflow criteria list [--json]` shows the ledger. `devflow criteria import
--from-runs` seeds it from the local run history (completed implement runs with established
evidence), for projects that used DevFlow before the ledger existed; the result is an ordinary
uncommitted change for the person to review.

**Configuration.** `verification.criteria: auto | always | never` (default `auto`: check when
ledger files exist; `always` fails when there are none; `never` disables the check), like
`verification.baseline`. `devflow verify --no-criteria` skips it once.

**Security.** The ledger is repository content and is treated as untrusted input, like the
task file. It only names tests to look for in parsed results: it adds no command, no argument
and no path to execute, so the command policy, the adapter catalog and the trust model are
unchanged. File names come from the task id, which is restricted to
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, and are written through the path guard.

**Delivery,** one pull request each: (1) this ADR, the `CriteriaLedger` schema with positive
and negative tests, and `devflow criteria list`; (2) implement mode writes the ledger;
(3) `verify` checks it, text and JSON; (4) the implement and review report sections, the
finding and the verdict rule; (5) the MCP tool, `criteria retire` and `criteria import`.

## Consequences

- Rechecking costs nothing extra in test time: it reuses the results of the gates that run
  anyway. A project whose gates do not run the linked tests sees `not_executed`, not a pass.
- The ledger is a new committed file format with a schema version; changing it later needs a
  migration.
- Pull requests created by implement mode now also change `.devflow/criteria/`. A person who
  does not want the ledger sets `verification.criteria: never` and does not commit the files.
- A renamed test makes its criterion `unverifiable` until the task is run again or the
  criterion is retired. Relinking a test by hand is left for later.
- Rerunning only the linked tests (the adapters' filtered test command, as evidence probes
  do) is a possible later optimisation for large suites; the first version relies on the
  configured gates.
- Matching is by gate id and test id, like the baseline comparison, so it depends on each
  adapter reporting the same test id from one run to the next.
- `devflow verify` does not rerun failing tests, so a flaky linked test can show as
  `regressed` there; the workflows rerun a failure once before reporting it.

## Alternatives rejected

- **Reading the acceptance matrices of old runs.** Simple, but the run history is local and
  ignored by git: it does not exist in CI, for a colleague or after a fresh clone, and a
  criterion disappears silently when a run directory is deleted.
- **Putting the task id into test titles (`ORD-12/AC-1: ...`) and grouping results by
  marker.** No new file, but nothing records which tests should exist: a deleted test would
  stop being checked without any report, which is exactly the false assurance DevFlow's
  reports must not give. It would also change the marker convention of every adapter.
- **One ledger file for the whole repository.** Every implement pull request would edit the
  same file and conflict.
- **Retiring a criterion automatically when a new task's plan says it changes the behaviour.**
  Whether earlier behaviour may change is a human decision; a model's plan is not an approval.
