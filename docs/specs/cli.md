# Specification: command-line interface

- **Status:** Phase 1 implements `devflow --version`, `devflow --help` and
  `devflow task validate`; Phase 2 adds `devflow trust` and the assist workflow (`init`,
  `analyze`, `plan`, `approve`, `reject`, `answer`, `resume`, `cancel`, `status`, `report`);
  Phase 3 adds `devflow verify`; Phase 4 adds `devflow test`, `devflow implement` and
  `devflow run`. The commands listed in section 4 are planned and do **not** exist yet.

The same `devflow` CLI serves Java and JavaScript/TypeScript projects, and mixed monorepos.
Nothing in the CLI is language-specific: languages are handled by adapters.

## 1. Running it

DevFlow is not published to npm yet ([ADR 0016](../adr/0016-npm-scope-and-publication.md)).
From a clone:

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

## 2. Exit codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| 0    | Success                                                                       |
| 1    | The command ran and the result is negative (e.g. the task is invalid)         |
| 2    | Usage error: unknown command or option, missing argument, unusable input file |
| 3    | The run is waiting for a person: plan or test approval, clarification answers |
| 4    | A token or call budget was reached; `devflow resume` with a higher limit      |
| 5    | Denied by policy: a required command was not allowed to run                   |
| 70   | Internal error (a bug in DevFlow)                                             |
| 130  | Interrupted by Ctrl+C; `devflow resume` continues the run                     |

For workflow commands, 1 also means a failed run (for example `PLAN_INVALID`), a run
interrupted by a provider failure (resumable), or a locked or corrupt run. For
`devflow verify`, and for a test-mode run that stops before its tests run
(`COMMAND_NOT_APPROVED`, resumable), 5 means the workspace is not trusted, a command was not
approved or was rejected, or the policy refused it (for example because the project's
dependencies are not installed): nothing negative is known about the code.

## 3. Implemented commands

### `devflow task validate <file> [--json] [--strict]`

Parses, normalizes and lints a task file (YAML, JSON or Markdown). See the
[task contract spec](task-contract.md) for the rules and issue codes.

- Exit 0 when valid, 1 when invalid, 2 when the file cannot be used (not found, not a file,
  larger than 1 MiB, not UTF-8, unsupported extension).
- `--strict` treats warnings as errors.
- `--json` prints a JSON document to stdout instead of the human report:
  `{ file, format, valid, strict, errorCount, warningCount, issues[], task }`, where each issue
  has `severity`, `code`, `message`, `path`, `location` (formatted path) and `line` when
  known, and `task` is the normalized contract or `null`. When the file cannot be used:
  `{ file, valid: false, error: { code, message } }`, exit 2.
- Colour is used only on a TTY and is disabled by `NO_COLOR` or `TERM=dumb`; `FORCE_COLOR`
  enables it.

Example:

```text
$ devflow task validate examples/tasks/add-pagination.task.yaml
Task file: examples/tasks/add-pagination.task.yaml (yaml)
Task:      TASK-142 - Add pagination to GET /api/orders
Contents:  2 functional requirements, 1 non-functional requirement, 3 acceptance criteria, 2 definition-of-done items

Result: VALID
```

```text
$ devflow task validate broken.task.yaml
Task file: broken.task.yaml (yaml)

error    TASK_SCHEMA  line 12  acceptanceCriteria[1].statement
         Invalid input: expected string, received number

Result: INVALID (1 error)
```

### `devflow trust`

```text
devflow trust [directory] [--yes | --status | --revoke] [--json]
```

Reviews the workspace configuration and trusts the workspace, shows its trust status, or
revokes it ([ADR 0007](../adr/0007-workspace-trust.md), [security model](security-model.md)
section 3.1). The workspace is `directory`, or the current directory; run it from the
repository root. Trust is stored outside the repository, in `$DEVFLOW_HOME/trust.json` or
`~/.devflow/trust.json`.

- **Without options** it shows the review: the workspace, the trust store, the configuration
  file and its SHA-256 (or that there is none and the defaults apply), the modules and gates the
  configuration enables, what trusting allows, and the residual risks. On an interactive
  terminal it then asks `Trust this workspace for this configuration? [y/N]`; only `y` or `yes`
  trusts it. Elsewhere (CI, pipes) it trusts nothing and asks for `--yes`. Exit 0 when trusted,
  1 when not.
- `--yes` trusts without asking. Use it after reading the review.
- An invalid configuration is shown with its problems and line numbers and is never trusted
  (exit 1). An already trusted workspace is left unchanged (exit 0).
- Trust is bound to the hash of the configuration bytes that were reviewed. Editing the file
  later, or adding one to a workspace trusted without one, makes the status `config-changed`
  until it is reviewed and trusted again, which also drops the old command approvals.
- `--status` prints the status (`TRUSTED`, `UNTRUSTED` or `CONFIG CHANGED`) and the approved
  commands. Exit 0 when trusted, 1 otherwise.
- `--revoke` removes the workspace and all of its command approvals. Exit 0.
- `--json` prints `{ workspace, trustStore, action, status, config, trustedAt, trustedBy,
commands, residualRisks }`, where `action` is one of `status`, `trusted`, `already-trusted`,
  `confirmation-required`, `invalid-config`, `revoked`, `not-trusted`, and `config` holds
  `path`, `exists`, `sha256`, `valid`, `issues`, `modules`, `gates` and
  `additionalProtectedPaths`. JSON mode never prompts: without `--yes` it reports
  `confirmation-required`.
- Exit 2 for a usage error: conflicting options, a workspace that does not exist, a
  configuration file that cannot be read, or a corrupt trust store (which is left untouched).

Commands are not approved here: each one is approved by fingerprint the first time it is
needed, with its exact arguments, working directory and the script or wrapper it runs.

Example:

```text
$ devflow trust --yes
Workspace:   /home/dev/shop
Trust store: /home/dev/.devflow/trust.json
Config:      .devflow/config.yaml
SHA-256:     4f1c...
Status:      UNTRUSTED

What this configuration enables:
  Modules: auto-detected
  Gates:
    unit: test in module web

Trusting lets DevFlow run build, test, lint and analysis commands in this workspace.
...
Residual risks, even for a trusted workspace:
  - A trusted build runs arbitrary code with your privileges. ...

Trusted. Each command is still approved separately the first time it runs.
```

### `devflow verify`

```text
devflow verify [--gate <id>]... [--allow <fingerprint>]... [--baseline <verification.json>] [--json]
```

Runs the verification gates of the workspace
([verification spec](verification-and-evidence.md), section 4). Run it from the repository
root.

- **Modules** are those declared under `modules` in `.devflow/config.yaml`, otherwise those the
  Java and JavaScript adapters detect.
- **Gates** are those of `verification.gates`. When none are configured, every module with a
  test command gets a required gate `<module>-test`, and a warning says so. `--gate <id>`
  (repeatable) runs only the named gates; an unknown name is a usage error.
- **Every command goes through the command policy** ([security model](security-model.md),
  section 4). The workspace must be trusted (`devflow trust`), and each command approved by
  its fingerprint. On an interactive terminal DevFlow shows the command, its working
  directory, the files it executes with their hashes and the fingerprint, then asks
  `Run it? [o]nce, [a]lways in this workspace, [N]o`. `always` stores the approval in the
  trust store; a changed script or wrapper changes the fingerprint, and DevFlow asks again.
  Without a terminal, and with `--json`, it never asks. The gate is then not executed, and the
  output shows the command and the fingerprint. After reviewing the command, pass the
  fingerprint with `--allow <fingerprint>` (repeatable) to approve it for one invocation.
- **Statuses.** A gate is `passed` only when its command ran, exited 0, and its results were
  read and contain no failure. It is `failed` for a non-zero exit code, failed tests or error
  diagnostics. It is `unverified` for a timeout, results that cannot be read, tests without a
  trustworthy result, or a test command that ran no tests. It is `skipped` when every test was
  skipped. It is `not_executed`, with the reason, when the module, the command or the tool is
  missing, the policy denied the command, or it could not be started. Only reports written by
  this run are read.
- **Saved results.** Each run writes `.devflow/runs/verify/<time>/`: `verification.json` (the
  gate results), `logs/` (the redacted standard output and error of each command) and
  `audit.jsonl` (approvals and executions). `devflow init` adds `.devflow/runs/` to
  `.gitignore`.
- `--baseline <file>` compares the results with the `verification.json` of an earlier run,
  test by test: regressions (passed, now failed), fixed tests, tests still failing, new tests
  and tests no longer reported. A test that did not run in one of the two runs is never
  counted as a regression or a fix. An unreadable or invalid baseline is a usage error,
  reported before anything runs.
- `--json` prints `{ workspace, outcome, verification, modules, warnings, gates, denials,
comparison }`. `outcome` is `passed`, `failed`, `denied` or `interrupted`; `gates` are
  `GateResult`s; each denial has `gateId`, `commandId`, `argv`, `cwd`, `reason`, `message`
  and `fingerprint`.
- **Exit codes.** 0 when every required gate passed (when `--gate` selects only optional
  gates, those count). 5 when the only required gates that did not pass were stopped by the
  command policy. 1 otherwise, including when there is nothing to verify. 2 for a usage
  error. 130 when interrupted with Ctrl+C.
- Commands run one after the other, in local mode: a trusted build runs with your privileges
  ([ADR 0007](../adr/0007-workspace-trust.md)). The Git commit is not recorded in
  `verification.json` yet.

Example, on a project with a failing Vitest test, after `devflow trust --yes`:

```text
$ devflow verify
warning: no gates are configured (verification.gates in .devflow/config.yaml): running the test command of each module
Running gate javascript-test (javascript:test)...
Workspace: /home/dev/shop
Modules:   javascript (javascript, .)

NOT EXECUTED  javascript-test (javascript:test)
              denied by the command policy: approval required: command javascript:test (fingerprint f2b6a130...) has not been approved

Commands need approval. Review each one, then approve it when devflow verify asks on a terminal, or pass its fingerprint:
  javascript:test: node node_modules/vitest/vitest.mjs run --reporter=default --reporter=json --outputFile.json=node_modules/.devflow-javascript-vitest.json --passWithNoTests
    in .
    --allow f2b6a130...

Saved:  .devflow/runs/verify/2026-11-08T00-22-11-023Z/verification.json
Result: DENIED BY POLICY (0 of 1 gate passed; not allowed to run: javascript-test)
$ echo $?
5
$ devflow verify --allow f2b6a130...
...
FAILED        javascript-test (javascript:test, 0.9 s)
              2 tests: 1 passed, 1 failed
              exit code 1: 1 failed test
              - src/sum.test.js#sum > AC-2: subtracts: AssertionError: expected 4 to be 2 // Object.is equality

Saved:  .devflow/runs/verify/2026-11-08T00-22-18-590Z/verification.json
Result: FAILED (0 of 1 gate passed)
```

After a fix, comparing with that run:

```text
$ devflow verify --allow f2b6a130... --baseline .devflow/runs/verify/2026-11-08T00-22-18-590Z/verification.json
...
PASSED        javascript-test (javascript:test, 0.9 s)
              2 tests: 2 passed

Compared with .devflow/runs/verify/2026-11-08T00-22-18-590Z/verification.json: 0 regressions, 1 fixed, 0 still failing, 0 new, 0 no longer reported
  fixed      javascript-test: src/sum.test.js#sum > AC-2: subtracts

Saved:  .devflow/runs/verify/2026-11-08T00-22-27-459Z/verification.json
Result: PASSED (1 of 1 gate passed)
```

Only the workspace path and the fingerprints were changed (real fingerprints have 64
hexadecimal characters).

### Assist and test workflows

```text
devflow init [--json]
devflow analyze --task <file> [model options]
devflow plan    --task <file> [model options]
devflow test    --task <file> [model options] [--allow <fingerprint> ...]
devflow implement --task <file> [model options] [--allow <fingerprint> ...]
devflow run     --task <file> [model options] [--allow <fingerprint> ...]
devflow approve <run> [--plan-sha <sha256> | --tests-sha <sha256> | --changes-sha <sha256>] [--allow <fingerprint> ...] [--json]
devflow reject  <run> (--feedback <text> | --feedback-file <file>) [model options]
devflow answer  <run> (--answer <id>=<text> ... | --file <answers.yaml>) [model options]
devflow resume  <run> [model options] [--allow <fingerprint> ...]
devflow cancel  <run> [--reason <text>] [--json]
devflow status  [run] [--json]
devflow report  <run> [--json]
```

Model options: `--provider <name>`, `--model <id>`, `--cassette <file>`,
`--max-input-tokens <n>`, `--max-output-tokens <n>`, `--max-calls-per-step <n>`, `--json`.

The workspace is the current directory: run the commands from the repository root. Runs are
stored in `.devflow/runs/<run-id>/` ([workflow package](../../packages/workflow/README.md),
[ADR 0004](../adr/0004-state-machine-and-run-store.md)). Assist mode never changes a repository
file and never runs a command, so every report has the verdict `not_verified` and no automated
acceptance criterion is reported as passed.

- **`init`** writes `.devflow/config.yaml` (with comments) and `.devflow/rules/project.md`
  when they do not exist, and adds `.devflow/runs/` to `.gitignore`. Existing files are never
  overwritten. The configuration is untrusted until `devflow trust`.
- **`analyze`** loads the context and analyses the requirements; it completes after the
  analysis. The analysis lists edge cases (with the acceptance criteria that cover them),
  contradictions between requirements, criteria and constraints, and dependencies on other
  requirements, modules, external systems and data. Ids the task does not define are removed.
  Every contradiction is resolved by a person: it is linked to an open blocking question about
  the same ids, or DevFlow adds one, so the run waits for clarification; the report shows each
  contradiction with the answer that resolved it. **`plan`** continues with an implementation plan, checked deterministically (paths,
  scope, protected files, acceptance-criterion coverage), and waits for approval unless the
  trusted configuration sets `workflow.requirePlanApproval: false`. `--mode` accepts `assist`;
  `review` fails with `WORKFLOW_MODE_NOT_IMPLEMENTED` (exit 2). Test and implement mode run
  only through their own commands.
- **`test`** runs test mode ([ADR 0015](../adr/0015-test-intent-and-red-green.md)): analysis
  and plan as above, then the model writes tests for the automated acceptance criteria. The
  tests are checked before anything is written: test files only, inside a module's test roots
  (never production code), writable by the path guard, a new file must not exist, each search
  and replace edit must match exactly once, and every test carries its criterion's marker
  (`AC-1: ...` in the title, or a method named `ac1_...`). A design that fails a check gets one
  revision, then the run fails with `TEST_DESIGN_INVALID`. The files are written, recorded with
  their hashes in `artifacts/test-files.json`, and the run **waits for a person to approve the
  tests** (exit 3, `artifacts/test-design.md`): model-written code runs with the user's
  privileges, so it never runs unreviewed. `approve` then runs the test gate of each affected
  module once, against the current code, through the command policy (trust, then approval on
  the terminal, an earlier "always", or `--allow`). A command that is not allowed stops the run
  (exit 5, resumable with `resume --allow <fingerprint>` or after `devflow trust`). The results
  become red/green evidence per criterion (`artifacts/test-evidence.json`) and deterministic
  findings (a feature test that already passes, a regression test that fails, a test that did
  not run, a criterion without a test). No production code changes, so no criterion is
  verified and the verdict is `not_verified`; the report lists the evidence, the gates, the
  findings and the test files.
- **`implement`** (and **`run`**, the same command) runs implement mode: test mode as above,
  except that the baseline runs **every** gate against the code before the change, so that the
  change can be compared with it. The model then writes the code change, given the plan, the
  approved test files (read only) and the current content of the plan's files. The change is
  checked before anything is written: only files the approved plan lists, never a test file,
  writable by the path guard, `create` for a new file, exact search and replace edits that
  change something, `delete` only where the plan deletes. A change that fails a check gets one
  revision, then the run fails with `IMPLEMENTATION_INVALID`. Each file is written only if it
  still has the content the change was computed from. The run **waits for a person to approve
  the change** (exit 3, `artifacts/implementation.md`), for the same reason as the tests.
  `approve` then runs every gate on the changed code, and the gates that failed a second time:
  a test that fails and then passes is flaky, never a regression. The result is compared with
  the baseline test by test (`artifacts/verification-<n>.json`): regressions (passed before,
  failed after), failures that were already there, and the red/green evidence of each
  criterion. While a required gate fails and repair attempts remain
  (`workflow.maxRepairAttempts`, default 2, from a trusted configuration), the model is asked
  for a repair with the failures (redacted), and the repair waits for approval like the first
  change. The report has a real verdict: `verified` only when every required gate passed,
  every automated criterion's tests passed after the change and no confirmed high or critical
  finding remains; `failed_verification` when a gate, a criterion or such a finding failed.
  The findings are deterministic; there is no model review yet.
- **Git isolation** (test and implement mode, [ADR 0012](../adr/0012-git-isolation.md)). A run
  needs a clean working tree: with uncommitted changes outside `.devflow/` it does not start
  (`GIT_TREE_NOT_CLEAN`, nothing is created). Just before the first file is written (after the
  plan is approved), the tree is checked again and the run creates and checks out its own
  branch, `<workflow.git.branchPrefix><task id>` (default `devflow/TASK-142`; `-2`, `-3`, ...
  when it exists). Each approval commits exactly the approved files on that branch: the tests,
  the change, each repair (`DevFlow TASK-142: add tests`, `... implement the change`,
  `... repair 1`), with your git identity and without hooks; a rejected change is restored, not
  committed. `workflow.git.commit: none` keeps the branch without commits. A commit that fails
  (for example without a git identity) does not stop the run: the report lists the files to
  commit or review. DevFlow writes, runs gates and commits only while the run's branch is
  checked out (`GIT_BRANCH_CHANGED` otherwise; switch back and retry). It never pushes, merges
  or switches back for you. Outside a git repository, without git on PATH, or in a repository
  without a commit, the changes stay uncommitted in the working tree and the report says why.
  `workflow.git.isolation: worktree` is not implemented (`GIT_ISOLATION_UNSUPPORTED`). The
  `workflow.git` settings apply only in a trusted workspace. The outcome and the report name
  the branch, its base commit and its head commit.
- **`approve`** approves whatever the run waits for: the plan (`--plan-sha`), the tests
  (`--tests-sha`, the approval hash in `test-design.md`) or the code change (`--changes-sha`,
  the hash in `implementation.md`); a hash flag for something the run is not waiting for is a
  usage error. A test file changed after DevFlow wrote it cannot be approved
  (`TEST_FILES_CHANGED`), nor a changed production file (`IMPLEMENTATION_FILES_CHANGED`).
  **`reject`** of the tests or of a change restores the files as they were before it (never
  overwriting a file someone changed) and writes them again with the feedback. Cancelling a
  run leaves the files; the report lists the unapproved files to review or remove.
- **Model selection.** There is no default model. The model comes from `--model`, then from
  `ai.models` of a **trusted** configuration, then from `DEVFLOW_MODEL`; the provider from
  `--provider`, the trusted configuration, `DEVFLOW_PROVIDER`, or `anthropic`. The Anthropic
  provider reads `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) from the environment only. The
  `replay` provider answers from a cassette (`--cassette`, or `DEVFLOW_CASSETTE`) and never
  calls a network. A provider that cannot be created is reported before a run starts (exit 2).
- **Untrusted workspace.** The `ai` and `workflow` sections of an untrusted configuration are
  ignored (with a warning); its `context`, `modules` and `security` sections still apply because
  they can only restrict. Project rules in `.devflow/rules/` are given to the model as rules only
  in a trusted workspace. An invalid configuration stops the command (exit 2).
- **Decisions** are recorded in the run's audit log with the user from `DEVFLOW_USER`, `USER`
  or `USERNAME`. `approve --plan-sha` approves only the plan with that hash; a plan file edited
  after it was generated cannot be approved. `reject` plans again with the feedback and the
  previous plan. `answer` records answers; the analysis runs again once no blocking question is
  open. An answers file maps question ids to text: `Q-1: Pages start at 1`.
- **`resume`** continues an interrupted run from its current step. `--max-*` raise the run's
  limits, `--model` and `--provider` replace them. A waiting or finished run is shown unchanged.
- **`status`** lists the runs, oldest first, or shows one run with its state, settings, usage,
  warnings and next step. **`report`** prints `report.md` (or `report.json` with `--json`) of a
  finished run, and exits 1 for a run that has not finished.
- Progress lines are written to stderr; with `--json`, stdout holds one JSON document:
  the outcome `{ runId, mode, state, status, waitingFor?, questions?, error?, runDir,
planPath?, testsPath?, testFiles?, changesPath?, changedFiles?, denials?, reportPath?,
branch?, exitCode }`, or
  `{ error: { code, message } }`.
- Ctrl+C stops the run after saving its state (exit 130); `devflow resume` continues it. A
  second Ctrl+C ends the process at once.

Example:

```text
$ devflow plan --task tasks/TASK-142.yaml --model <model id>
Loading the repository context...
Analysing the requirements...
Planning the implementation...
Run:    2026-11-07T10-21-33Z_TASK-142
State:  AWAITING_PLAN_APPROVAL
Plan:   .devflow/runs/2026-11-07T10-21-33Z_TASK-142/artifacts/plan.md

Review the plan, then approve it or ask for changes:
  devflow approve 2026-11-07T10-21-33Z_TASK-142
  devflow reject 2026-11-07T10-21-33Z_TASK-142 --feedback "what to change"
$ echo $?
3
```

## 4. Planned commands

| Command                                      | Phase | Purpose             |
| -------------------------------------------- | ----- | ------------------- |
| `devflow review`                             | 4     | Review a local diff |
| `devflow run --issue <n>`, `review --pr <n>` | 5     | GitHub sources      |

Module detection by `devflow init` waits for the Phase 3 adapters. `analyze` and `plan`
accept `--mode assist|review`; only `assist` is implemented, and test and implement mode have
their own commands. The functions exported by `@devflow/workflow` (`startRun`, `approvePlan`,
`rejectPlan`, `approveTests`, `rejectTests`, `approveChanges`, `rejectChanges`,
`answerQuestions`, `resumeRun`, `cancelRun`, `getRun`, `listRuns`) expose the same operations
programmatically; test and implement mode need a `testRunner` in the services, which supplies
the modules and runs gates through the command policy.
