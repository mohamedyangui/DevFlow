# Specification: command-line interface

- **Status:** Phase 1 implements `devflow --version`, `devflow --help` and
  `devflow task validate`; Phase 2 adds `devflow trust` and the assist workflow (`init`,
  `analyze`, `plan`, `approve`, `reject`, `answer`, `resume`, `cancel`, `status`, `report`);
  Phase 3 adds `devflow verify`; Phase 4 adds `devflow test`, `devflow implement`,
  `devflow run` and `devflow review`; Phase 5 adds `--issue`, `review --pr` and
  `--publish`; Phase 6 adds `devflow contracts diff` and `devflow mcp`. The commands listed in
  section 4 are planned and do **not** exist yet.

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
devflow verify [--gate <id>]... [--allow <fingerprint>]... [--baseline <verification.json>]
               [--backend local|container] [--json]
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
- **`--backend local|container`** chooses where the commands run
  ([ADR 0020](../adr/0020-container-execution-backend.md)); it takes precedence over
  `execution.backend` of the configuration, whose default is `local`. `container` runs each
  command with `docker run --network none` and the limits of `execution.container`, in the
  configured image, which must already be present locally (DevFlow never pulls). Without an
  image it is a usage error (`CONTAINER_IMAGE_UNAVAILABLE`); without Docker, or with an image
  that is missing, the gates are `not_executed` with the reason. There is never a fallback to
  the host. A container command has its own fingerprint (it includes the image), so a local
  approval does not cover it. The same flag exists on `test`, `implement`, `run`, `review`,
  `approve` and `resume`; it applies to that invocation only.
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
devflow analyze <task source> [model options]
devflow plan    <task source> [model options]
devflow test    <task source> [model options] [--allow <fingerprint> ...] [--backend local|container]
devflow implement <task source> [model options] [--allow <fingerprint> ...] [--backend local|container]
devflow run     <task source> [model options] [--allow <fingerprint> ...] [--backend local|container]
devflow review  <task source> [--base <ref> | --pr <ref> [--publish [comment|check]]
                [--run-fork-code]] [--seek-evidence [--max-probes <n>]]
                [model options] [--allow <fingerprint> ...] [--backend local|container]
devflow approve <run> [--plan-sha <sha256> | --tests-sha <sha256> | --changes-sha <sha256>] [--allow <fingerprint> ...] [--backend local|container] [--json]
devflow reject  <run> (--feedback <text> | --feedback-file <file>) [model options]
devflow answer  <run> (--answer <id>=<text> ... | --file <answers.yaml>) [model options]
devflow resume  <run> [model options] [--allow <fingerprint> ...] [--backend local|container]
devflow cancel  <run> [--reason <text>] [--trace <targets>] [--json]
devflow status  [run] [--json]
devflow report  <run> [--json] [--publish [comment|check]]
devflow pr create <run> [--repo <owner/name>] [--base <branch>] [--title <text>] [--yes] [--json]
```

Model options: `--provider <name>`, `--model <id>`, `--cassette <file>`,
`--max-input-tokens <n>`, `--max-output-tokens <n>`, `--max-calls-per-step <n>`,
`--trace <targets>`, `--json`. `approve` and `cancel` accept `--trace` too (see
`devflow trace` below).

Task source: exactly one of `--task <file>` and `--issue <ref>` (otherwise
`TASK_SOURCE_INVALID`, exit 2).

- `--task <file>`: a YAML, JSON or Markdown task file.
- `--issue <ref>` (Phase 5): a GitHub issue as the task: `142`, `#142`, `owner/name#142` or
  the issue URL. A bare number needs the repository: `--repo owner/name`, or else the
  `origin` remote when it is on github.com (HTTPS or SSH). The body is parsed by the Markdown
  task parser exactly like a task file; the issue number and title are the defaults for the
  id (`GH-142`) and the title. The task is `external`: prompts show it as untrusted data, and
  it never changes DevFlow's policies. Pull requests are refused as tasks
  (`GITHUB_ISSUE_INVALID`), comments are not read, and a closed issue gives a warning. The
  token comes from `GITHUB_TOKEN` or `GH_TOKEN` (needed for private repositories and for a
  higher rate limit); it goes only to `https://api.github.com`, never to a model, a run file
  or a child process. A request GitHub refuses or that fails is `GITHUB_REQUEST_FAILED`
  (exit 1); a repository that cannot be determined is `GITHUB_REPOSITORY_UNKNOWN` (exit 2).
  Nothing is created before the task is valid. See
  [ADR 0019](../adr/0019-github-rest-client.md).

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
- **`review`** runs review mode on the local change: the working tree (staged, unstaged and
  untracked files, outside `.devflow/`) against the merge base of `--base` and HEAD (default
  `HEAD`, the uncommitted change). It needs a git repository and a change; otherwise it stops
  before creating a run (`GIT_FAILED`, `REVIEW_NO_CHANGES`, exit 2). The requirements are
  analysed as in assist mode; then the diff is taken (`artifacts/review-diff.json`, the
  redacted patch in `review-diff.patch`) and every gate runs once on the changed code through
  the command policy. Deterministic checks come first, as findings with deterministic
  evidence: a failed or skipped gate, a criterion whose tests fail or that no test that ran
  is linked to (by its marker), an added line the secret detector matches, a changed
  protected file or CI workflow, source changed without any test change, a removed or changed
  public declaration (JavaScript, TypeScript, Java), a changed dependency manifest. Then one
  model call reviews the diff against the task: its findings carry the model's confidence and
  stay `unverified` (at most 20) unless a probe confirms them (`--seek-evidence`, below). Sensitive files (`.env`, keys, ...) are never shown
  to the model, and the patch is redacted before it is stored or sent. A criterion is
  verified when its tests pass on the change; there is no run before the change, so failures
  that were already there are not told apart and no red/green evidence exists. Review mode
  changes no file and commits nothing.
- **Contracts in a review** (Phase 6, [ADR 0021](../adr/0021-contract-compatibility.md)):
  every changed OpenAPI or Protobuf file is compared at the base commit and in the working
  tree (`artifacts/review-contracts.json`). `oasdiff` or `buf` decide when they are on PATH
  and the command policy lets them run (approved like a gate, `--allow` works; never when
  the gates are skipped, and `oasdiff` never on documents with external references); the
  built-in rules decide otherwise. Each file with breaking changes is a `confirmed`, `high`
  `compatibility` finding whose evidence names each rule and who decided it; changes the
  rules cannot decide (`unknown`) and files that could not be compared are manual checks.
- **`--seek-evidence [--max-probes <n>]`** (Phase 6,
  [ADR 0025](../adr/0025-evidence-seeking-review.md)) probes the AI findings after the model
  review: for each unverified AI finding of severity `medium` or higher with a location (at
  most `n`, default 3, at most 10, most severe first), one model call proposes a single new
  test file that should fail if the defect is real. DevFlow checks it (a new test file of the
  finding's module, path-guarded, at most 64 KiB, a filter-safe test name), writes it only
  into a temporary git worktree of the reviewed state at `.devflow/probes/worktree`, runs only
  that test with the module's filtered test command through the command policy (approved
  like a gate; `--allow` works) and removes the worktree. The targeted test failing on an
  assertion makes the finding `confirmed` with deterministic evidence (probe hash, command,
  failing test); a pass leaves it `unverified` ("probe passed: not reproduced"); a compile
  error, a runtime error, a timeout or no such test is inconclusive and leaves it
  `unverified`. Probes are kept in the run directory (`artifacts/probes/F-n/...`,
  `artifacts/probes.json`), never in the working tree and never committed; the report lists
  them under "Evidence probes". No probe runs when the gates are skipped (a fork pull request)
  or the workspace is not trusted. `--max-probes` without `--seek-evidence`, or above 10, is
  `OPTIONS_INVALID` (exit 2).
- **`review --pr <ref>`** (Phase 5) reviews a pull request: `57`, `#57`, `owner/name#57` or
  the pull request URL (the repository as for `--issue`). DevFlow reads the pull request from
  the GitHub API but never fetches or checks out its code: check out its head commit first
  (`git fetch origin pull/57/head` then `git checkout --detach FETCH_HEAD`). HEAD must be that
  commit and the working tree must be clean (`REVIEW_PULL_REQUEST_NOT_CHECKED_OUT`,
  `GIT_TREE_NOT_CLEAN`, exit 2, nothing created); the base is the pull request's base commit,
  which must be in the local repository. A task is still needed (`--task` or `--issue`): the
  pull request description is not used as a task. A closed, merged or draft pull request gives
  a warning. The code of a pull request from a fork (or a deleted fork) is **not run**: no
  gate runs, a confirmed finding and a manual check say so, and the verdict cannot be
  `verified`; `--run-fork-code` runs the gates on it, only after you have read the change.
  `--base` cannot be combined with `--pr`, and `--publish` and `--run-fork-code` need `--pr`
  (`OPTIONS_INVALID`, exit 2).
- **`--publish [comment|check]`** (default `comment`) sends the finished review to the pull
  request: a comment, or a completed check run named `DevFlow review` on the head commit
  (`success` for `verified`, `failure` for `failed_verification`, otherwise `neutral`). It
  needs `GITHUB_TOKEN` or `GH_TOKEN` (checked before a run is created, `OPTIONS_INVALID`) with
  `pull-requests: write` or `checks: write`. The body is built from `report.json`: the verdict,
  criteria, gates and findings (at most 50), AI findings labelled unverified suggestions
  (those a probe test confirmed are listed apart); text
  from the model is cut to 300 characters and neutralised (Markdown, HTML and table syntax
  escaped, no `@` mention, no link), and every known secret is redacted. Publishing never
  approves, requests changes or merges. A run that is waiting is not published (a note says
  how to publish it later); a failed publication is reported and exits 1, the run is kept.
  `devflow report <run> --publish` publishes a finished `review --pr` run again.
- **`pr create <run>`** (Phase 5) turns a finished implement-mode run (`implement` or `run`,
  completed or failed) into a draft pull request. **Without `--yes` it only prints what it
  would do** (repository, branch and commit to push, base, title) and exits 2; nothing is
  pushed or created. With `--yes` it pushes the run's DevFlow branch to `origin` and opens a
  draft pull request. Refused, before anything is pushed (exit 2): another mode, a run that
  has not finished or was cancelled, no DevFlow branch or no commit on it, a branch that no
  longer contains the run's last commit (`PULL_REQUEST_RUN_INVALID`); no `origin`, an
  `origin` whose push URLs (with `pushurl` and `insteadOf` applied) are not the target
  repository on github.com, or a branch that is the base or the repository's default branch
  (`PULL_REQUEST_TARGET_INVALID`); no `GITHUB_TOKEN`/`GH_TOKEN` (`OPTIONS_INVALID`). The
  repository is `--repo`, or else the `origin` remote. The base is `--base`, or else the
  branch the run started from, or else the default branch; the title is `--title`, or else
  `DevFlow <task id>: <task title>` (one line, at most 200 characters). The push is exactly
  `refs/heads/<branch>:refs/heads/<branch>`: never forced, no tags, no other branch, no hook,
  no upstream written; it uses your own git credentials, and the token is used only for the
  API. A rejected push is `GIT_PUSH_FAILED` (exit 1). The description is built from
  `report.json` like a published review (verdict, commits, files changed, criteria, gates,
  findings, neutralised and redacted) and says that a person must review the change. A
  failed API request after the push is `GITHUB_REQUEST_FAILED` (exit 1) and says that the
  branch was pushed. DevFlow never marks the pull request ready, requests reviewers, approves
  or merges it. With `--json`: `{ runId, plan, done, message?, pullRequest? }`, where
  `pullRequest` is `{ number, url, draft }`.
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
  or switches back for you (only `devflow pr create --yes` pushes the branch). Outside a git repository, without git on PATH, or in a repository
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
  finished run, and exits 1 for a run that has not finished; `--publish` sends it to its pull
  request (see `review --pr`).
- Progress lines are written to stderr; with `--json`, stdout holds one JSON document:
  the outcome `{ runId, mode, state, status, waitingFor?, questions?, error?, runDir,
planPath?, testsPath?, testFiles?, changesPath?, changedFiles?, denials?, reportPath?,
branch?, published?, note?, exitCode }`, or
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

### `devflow contracts diff`

```text
devflow contracts diff <base-file> <head-file> [--kind openapi|protobuf] [--json]
devflow contracts diff --base <ref> <file>... [--kind openapi|protobuf] [--json]
```

Compares two versions of an OpenAPI 3.x (YAML or JSON) or Protobuf contract with the built-in
rules ([ADR 0021](../adr/0021-contract-compatibility.md)) and prints every change with its
compatibility (`breaking`, `non-breaking`, `unknown`), rule, message and line.

- With two files, the first is the base version and the second the head version.
- With `--base <ref>`, each file (relative to the current directory, inside it) is compared in
  the working tree against its version at the merge base of `<ref>` and HEAD, read through
  git, as `devflow review --base <ref>` does. A file missing on one side is an added or
  removed contract.
- The kind comes from the file (`.proto`; YAML or JSON named `openapi.*`/`swagger.*` or with
  a top-level `openapi:` key); `--kind` sets it otherwise.
- Only the built-in rules run here; `oasdiff` and `buf` run in review mode, through the
  command policy.
- `--json` prints `{ "breaking": boolean, "contracts": ContractDiff[] }`.
- Exit code 1 when a change is breaking, 0 otherwise (unknown changes are printed for a
  person to check), 2 for unusable input (`CONTRACT_FILE_INVALID`, `OPTIONS_INVALID`,
  `PATH_REJECTED`, `GIT_FAILED`).

### `devflow plugins`

```text
devflow plugins add <package|path> [--json]
devflow plugins list [--json]
devflow plugins remove <id> [--json]
```

Manages external language adapters ([ADR 0023](../adr/0023-external-adapter-plugins.md),
[language adapters](language-adapter.md), section 12). The plugin list is the user's own
`$DEVFLOW_HOME/plugins.json` (`~/.devflow/plugins.json` by default); a repository cannot add
to it.

- `add` resolves a package name only in `$DEVFLOW_HOME/plugins/node_modules` (install it
  there with `npm install --prefix "$DEVFLOW_HOME/plugins" <package>`), never in the current
  directory; anything else is a path to a package directory or an ES module file. It imports
  the plugin (running its top-level code), checks its `devflowAdapter` (or default) export and
  its API version, and records the real path of the entry file with the SHA-256 of the entry
  file and of `package.json`. Adding an installed plugin again accepts its current files. A
  built-in adapter's id, or an id installed from another location, is refused.
- `list` shows the adapter API version, the built-in adapters and each plugin with its
  status (`ok`, `changed`, `missing`, `shadowed` by a built-in adapter, `incompatible`). It
  hashes files and imports nothing.
- `remove` deletes an entry from the list (the package files stay where they are).
- `devflow verify` and the workflow commands load every installed plugin. A plugin whose files
  changed (`PLUGIN_CHANGED`), that no longer loads (`PLUGIN_INVALID`) or whose API version is
  not supported (`ADAPTER_API_INCOMPATIBLE`) stops the command with exit code 2.
- Exit codes: 0 on success; 1 for `remove` of an unknown id (`PLUGIN_NOT_FOUND`); 2 for
  `PLUGIN_INVALID`, `ADAPTER_API_INCOMPATIBLE` and `PLUGIN_STORE_INVALID`.

### `devflow contracts impact`

```text
devflow contracts impact <file>... [--base <ref>] [--kind openapi|protobuf] [--json]
```

Compares each working-tree contract file with its version at the merge base of `<ref>` (HEAD
by default) and HEAD, like `devflow contracts diff --base`, then lists the consumers of each
breaking change found in the working tree by the deterministic heuristics of
[ADR 0022](../adr/0022-cross-language-change-impact.md): Spring mappings, TypeScript,
JavaScript, Java and Python HTTP calls, operation-id calls, and imports of the code generated
from a `.proto` file.

- Files are discovered like context discovery: ignore files, sensitive files and the
  `context.include`/`context.exclude` globs of `.devflow/config.yaml` apply; generated code is
  skipped.
- Every consumer is printed with its path, line, kind (`test (<mechanism>)` for a test file)
  and confidence: `exact`, or `pattern`, which may be a false positive. None found does not
  prove there is none.
- `--json` prints `{ "breaking", "contracts", "impact", "notes" }`: `contracts` as for
  `devflow contracts diff`, `impact` a `ContractImpact[]`, `notes` what limited the search.
- Nothing is executed and no model is called. Exit codes as for `devflow contracts diff`: 1
  when a change is breaking, 0 otherwise, 2 for unusable input.

### `devflow trace <run> [--output <file>] [--otlp] [--json]`

Exports the trace of a run as OpenTelemetry OTLP/JSON (an `ExportTraceServiceRequest`;
[ADR 0024](../adr/0024-observability-export.md)): a root span for the run, a span per workflow
step, and a span per model call and per command or gate under the step that was running.

- Without options, writes `trace.otlp.json` in the run directory. `--output <file>` writes it
  there instead (relative to the current directory).
- `--otlp` POSTs it to the OTLP/HTTP traces endpoint: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` as
  given, else `OTEL_EXPORTER_OTLP_ENDPOINT` followed by `/v1/traces`. Headers come from
  `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` (`key=value,...`,
  URL-encoded values), the timeout from `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` or
  `OTEL_EXPORTER_OTLP_TIMEOUT` in milliseconds (default 10000, at most 120000). The endpoint
  must use `https`, except `http` for `localhost`, `127.0.0.1` and `[::1]`; credentials in the
  URL are refused; redirects are not followed; a body over 4 MiB is not sent. With `--otlp`
  alone, no file is written; add `--output` for both.
- The trace holds metadata only: ids, names of steps, providers, models, prompt templates and
  executables, token counts, cost, attempts, durations, exit codes, statuses, backends and
  error codes. Never a prompt, an answer, a task text, a file path or content, a command
  argument beyond the executable's file name, a command output or an error message. Every
  value goes through the redactor.
- A run that has not finished is exported as far as it has run, with a note.
- `--json` prints `{ runId, state, finished, file?, sent?, spans, warnings }`.
- Exit code 0 when everything was written and sent, 1 when the write or the send failed
  (`TRACE_EXPORT_FAILED`: I/O error, timeout, HTTP status, size cap), 2 for an unknown run or a
  refused endpoint (`TRACE_EXPORT_REFUSED`).

**After a run.** `--trace <targets>` on a workflow command (or `DEVFLOW_TRACE_EXPORT` when
the flag is absent) exports the trace when the run finishes: `file`, `otlp`, `file,otlp`, or
`off`. Only the user turns it on; the repository's configuration cannot. The target and the
endpoint are checked before the run starts (`TRACE_EXPORT_REFUSED`, exit 2). A run waiting for
a person is exported by the command that finishes it (with `--trace` or the variable again).
An export failure is a warning in the output (`trace.warnings` with `--json`) and never
changes the run or its exit code.

### `devflow agent`

```text
devflow agent show <run> [--json]
devflow agent answer <run> --request <id> (--file <file> | --text <answer>) [--json]
```

Agent mode ([ADR 0027](../adr/0027-agent-mode.md)): with `--provider agent` (or
`ai.provider: agent`), DevFlow needs no API key and no model id. When the run needs the
model, it saves the request under `.devflow/agent`, stops with `AGENT_INPUT_REQUIRED` (exit
code 3) and the output names the next commands.

- `show` prints the request the run waits for: instructions, system prompt, messages and the
  JSON schema of a structured answer. With `--json`: `runId`, `state`, `requestId`,
  `instructions`, `system`, `messages`, `format` and `jsonSchema`.
- `answer` saves the answer to that request and resumes the run, which continues until it
  needs another answer, waits for a person or finishes. It refuses (`AGENT_ANSWER_INVALID`,
  exit 2) another request id, both or neither of `--file` and `--text`, an empty answer, an
  answer over 2,000,000 characters, and text that is not JSON when the request has a schema.
  A file is read up to 1 MiB.
- A run that does not wait for the agent is refused with `RUN_NOT_AWAITING_INPUT`.

### `devflow mcp`

```text
devflow mcp [--provider <name>]
```

Serves the DevFlow tools to an MCP client over stdio ([MCP specification](mcp.md),
[ADR 0026](../adr/0026-mcp-server.md)). MCP clients start it as
`node <DevFlow>/packages/cli/dist/bin.js mcp` in the project's root.

- stdout carries newline-delimited JSON-RPC messages only; diagnostics go to stderr.
- Each tool runs one of the commands above in-process with `--json` and without a terminal:
  nothing is approved interactively, and `trust`, `approve`, `reject`, `resume`, `cancel`,
  `pr create`, `--publish`, `--allow` and `--run-fork-code` are not available as tools.
- Decisions made through it are recorded as `<user> (via MCP)`.
- `--provider` (default `agent`): the provider of the workflow tools when a call names none;
  `config` leaves it to the configuration. In agent mode the tool results include the model
  request a run waits for, and `devflow_agent_respond` answers it.
- It exits with 0 when stdin closes.

## 4. Planned commands

No command is planned at the moment: the remaining Phase 5 work, the GitHub Action, is not a
command.

Module detection by `devflow init` waits for the Phase 3 adapters. `analyze` and `plan`
accept `--mode assist`; test, implement and review mode have their own commands. The functions exported by `@devflow/workflow` (`startRun`, `approvePlan`,
`rejectPlan`, `approveTests`, `rejectTests`, `approveChanges`, `rejectChanges`,
`answerQuestions`, `resumeRun`, `cancelRun`, `getRun`, `listRuns`) expose the same operations
programmatically; test, implement and review mode need a `testRunner` in the services, which
supplies the modules and runs gates through the command policy, and review mode needs `git`.
