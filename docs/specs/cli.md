# Specification: command-line interface

- **Status:** Phase 1 implements `devflow --version`, `devflow --help` and
  `devflow task validate`; Phase 2 adds `devflow trust` and the assist workflow (`init`,
  `analyze`, `plan`, `approve`, `reject`, `answer`, `resume`, `cancel`, `status`, `report`).
  The commands listed in section 4 are planned and do **not** exist yet.

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
| 3    | The run is waiting for a person: plan approval or clarification answers       |
| 4    | A token or call budget was reached; `devflow resume` with a higher limit      |
| 70   | Internal error (a bug in DevFlow)                                             |
| 130  | Interrupted by Ctrl+C; `devflow resume` continues the run                     |

For workflow commands, 1 also means a failed run (for example `PLAN_INVALID`), a run
interrupted by a provider failure (resumable), or a locked or corrupt run. Planned for Phase 3:
5 denied by policy.

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

### Assist workflow

```text
devflow init [--json]
devflow analyze --task <file> [model options]
devflow plan    --task <file> [model options]
devflow approve <run> [--plan-sha <sha256>] [--json]
devflow reject  <run> (--feedback <text> | --feedback-file <file>) [model options]
devflow answer  <run> (--answer <id>=<text> ... | --file <answers.yaml>) [model options]
devflow resume  <run> [model options]
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
  analysis. **`plan`** continues with an implementation plan, checked deterministically (paths,
  scope, protected files, acceptance-criterion coverage), and waits for approval unless the
  trusted configuration sets `workflow.requirePlanApproval: false`. `--mode` accepts `assist`
  only for now; other modes fail with `WORKFLOW_MODE_NOT_IMPLEMENTED` (exit 2).
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
  the outcome `{ runId, state, status, waitingFor?, questions?, error?, runDir, planPath?,
reportPath?, exitCode }`, or `{ error: { code, message } }`.
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

| Command                                                 | Phase | Purpose                                            |
| ------------------------------------------------------- | ----- | -------------------------------------------------- |
| `devflow verify`                                        | 3     | Run the configured gates                           |
| `devflow test --task <file>`                            | 4     | Generate and run tests for the acceptance criteria |
| `devflow implement --task <file>` / `run --task <file>` | 4     | Full workflow                                      |
| `devflow review`                                        | 4     | Review a local diff                                |
| `devflow run --issue <n>`, `review --pr <n>`            | 5     | GitHub sources                                     |

Module detection by `devflow init` waits for the Phase 3 adapters. Workflow commands accept
`--mode assist|test|implement|review`; only `assist` is implemented. The functions exported by
`@devflow/workflow` (`startRun`, `approvePlan`, `rejectPlan`, `answerQuestions`, `resumeRun`,
`cancelRun`, `getRun`, `listRuns`) expose the same operations programmatically.
