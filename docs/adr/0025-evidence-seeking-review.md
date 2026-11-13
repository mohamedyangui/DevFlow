# ADR 0025: Evidence-seeking review: model-written probe tests run in a git worktree

- **Status:** Accepted, 2026-11-11. Implemented in Phase 6 in `@devflowai/workflow`
  (`src/probes.ts`, the `evidence-probes` step of review mode), `@devflowai/core`
  (`GitClient.addWorktree`/`removeWorktree`, filtered gates in `runGate`) and the CLI
  (`devflow review --seek-evidence [--max-probes N]`).
- **Deciders:** Mohamed Yangui

## Context

Review mode asks a model to review a diff. Its findings stay `unverified`: a model's
suspicion is never a confirmed defect ([verification spec](../specs/verification-and-evidence.md),
section 6). Many suspicions are cheap to settle with a test: "the loop drops the last value"
is either shown by one assertion or it is not. A reviewer that can turn some suspicions into
deterministic evidence is more useful, provided that the model still never runs anything,
never decides the outcome, and never touches the person's working tree.

## Decision

**Opt-in.** `devflow review ... --seek-evidence [--max-probes N]` (default 3, at most 10;
`--max-probes` alone is refused). The probes run after the model review, as their own step
(`evidence-probes`), on the AI findings that are still `unverified`, of severity `medium` or
higher, with a location: the most severe first, then the most confident. Eligible findings
beyond the limit are listed as not probed. No probe runs when the gates are skipped (a pull
request from a fork without `--run-fork-code`), when the workspace is not trusted, without
git worktrees or without a test runner that can run a single test; the report says why.

**The model proposes data, never a command.** Per selected finding, one validated-JSON call
(`ProbeWire`: `feasible`, `path`, `testName`, `content`, `explanation`) asks for one new
test file with one test that fails on an assertion if the defect is real and passes if it
is not. The finding is shown to the model as untrusted data. The answer is checked before
anything is written: the path guard allows it for a model write; the file exists neither in
the working tree nor in the reviewed change (a probe only adds a file); it is inside the
finding's module and is a test path of that module per the adapter's authoring guide; it is
non-empty text of at most 64 KiB without anything the secret detector matches; the test name
matches `^[A-Za-z0-9][A-Za-z0-9 _:,-]{0,119}$` and occurs in the file. A failed check is a
`refused` probe; `feasible: false` is a `declined` one. Neither changes the finding.

**Isolation in a git worktree.** The probe never touches the working tree. `GitClient`
adds a detached worktree of HEAD at `.devflow/probes/worktree` (through the process
launcher, like every git call; the directory must be inside the workspace's `.devflow/`),
copies the reviewed change into it (changed and untracked files copied, deleted ones
removed) and writes the probe there with an exclusive create. The worktree is removed with
`git worktree remove --force` and `git worktree prune` afterwards, on every path, including
a failure or a cancellation; a worktree that could not be removed is reported with the
command to remove it. The path is fixed so that the probe command keeps one fingerprint a
person can approve once; an existing worktree (a concurrent or interrupted review) makes the
probe inconclusive rather than reusing it. Before the first probe, HEAD and the changed files
must still be those of the review's snapshot.

**Commands come from the adapter catalog.** The probe runs the module's test command that
takes one parameter (the adapter's filter, such as Vitest and Jest `--testNamePattern` or
pytest `-k`) with the test name as its value, or the value the adapter's optional
`testSelection` derives from the probe file and the test name (adapter API 1.1.0; the Java
adapter gives Surefire's `test=Class#method` and Gradle's `package.Class.method`), in the
worktree copy of
the module, through the same command policy (anchored parameter pattern, fingerprints,
approvals, `--allow`), executor and execution backend as the gates. A command that is not
approved makes the probe inconclusive and the report gives its fingerprint.

**Classification by rules, from the parsed test report alone.**

| Result of the targeted test (the probe file's test with the probe's name)      | Probe            | Finding                    |
| ------------------------------------------------------------------------------ | ---------------- | -------------------------- |
| Failed with an assertion failure                                               | `confirmed`      | `confirmed`, with evidence |
| Passed                                                                         | `not_reproduced` | `unverified`, with a note  |
| Runtime error, timeout, compile or collection error, no such test ran, not run | `inconclusive`   | `unverified`, with a note  |

A confirmed finding gets three deterministic evidence entries: the probe file (path and the
SHA-256 of its content as it ran), the command (argv, exit code, run in a worktree of the
reviewed state) and the failing test (id and redacted message). A probe that passed does not
refute the finding; it reads "probe passed: not reproduced". The report schema rejects a
confirmed probe whose finding is not confirmed and the reverse.

**Artifacts, never commits.** Each probe is kept in the run directory at
`artifacts/probes/F-n/<path>` and recorded with its outcome in `artifacts/probes.json`.
The report has an "Evidence probes" section, and a manual check asks a person to read the
tests that confirmed a finding: the assertion is the model's idea of the correct behaviour.

## Consequences

- A confirmed AI finding counts like any other confirmed finding: a confirmed `high` or
  `critical` one prevents a `verified` verdict.
- Each probe is one model call and one test run; `--max-probes` bounds both. The calls use
  the test-design model and output budget, and count against the run's budgets.
- The worktree shares the repository's object store but not its ignored files: tools are
  found by walking up from the worktree (it lives inside the workspace), so a module whose
  tests need generated or ignored files in the module itself may make the probe
  inconclusive.
- One review probes at a time per workspace.
- Only the JavaScript path (Vitest and Jest name filters) is tested end to end. The Java
  selection (Maven and Gradle) is unit-tested against the parameter patterns but has never
  run with a real build; the class is taken from the file name and the method must be a Java
  identifier, so a test named with spaces (a Kotlin backtick name) cannot be probed. The
  pytest filter has not been run with a probe.

## Alternatives rejected

- **Writing the probe into the working tree and deleting it afterwards.** A crash or a
  cancellation would leave a model-written file among the person's files, and the run could
  race with an editor.
- **Copying the workspace to a temporary directory.** Large, slow, and outside the guarded
  workspace; a worktree is what git offers for exactly this.
- **Letting the model name the command or the test runner arguments.** Model output is data
  ([ADR 0006](0006-llm-output-is-data.md)); the filter value goes through the parameter's
  anchored pattern like any other parameter.
- **Asking the model whether the probe confirmed the finding.** The outcome is decided by the
  parsed test report only.
