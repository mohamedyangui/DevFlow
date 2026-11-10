# DevFlow AI

[![CI](https://github.com/mohamedyangui/DevFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/mohamedyangui/DevFlow/actions/workflows/ci.yml)

DevFlow AI is an open-source, language-agnostic framework for AI-assisted software engineering
workflows. It turns a development task with requirements and acceptance criteria into a
planned, tested and verified change, and reports what was actually verified, with evidence.

> **Status: early development (Phase 2 of 6 complete).** DevFlow runs its assist workflow:
> it analyses a task against a repository with a model, asks clarification questions, and writes
> an implementation plan that a person approves or rejects. It does not run builds or change code
> yet (Phases 3 and 4), so every report says `not_verified`. The table below lists what exists.
> Nothing is published to npm.

## Principles

- **The AI proposes, deterministic code decides.** Model output is validated data. The model
  never runs commands or writes files directly.
- **Evidence over claims.** A test that was not executed is never reported as passed. An AI
  suspicion is never reported as a confirmed defect.
- **Untrusted by default.** Repository content and issues are data, not instructions. Builds
  run only in workspaces you have explicitly trusted.
- **Humans stay in control.** Plans need approval, changes land on a local branch, and DevFlow
  never pushes or merges on its own.
- **One tool for Java and JavaScript/TypeScript**, including mixed monorepos.

## What exists today

| Capability                                                                                                                | Status      |
| ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Task files in YAML, JSON and Markdown: parsing, normalization, validation with line numbers                               | Implemented |
| `devflow task validate [--json] [--strict]`                                                                               | Implemented |
| Core schemas for tasks, configuration, modules, commands, verification, findings, plans and reports, with invariants      | Implemented |
| JSON Schema for task and configuration files                                                                              | Implemented |
| Security layer: path guard, secret redaction, audit log, command policy, trust store, process executor                    | Implemented |
| `devflow trust [--yes \| --status \| --revoke] [--json]`                                                                  | Implemented |
| Context engine: discovery, classification, OpenAPI and Protobuf discovery, ranking, packing                               | Implemented |
| LLM gateway with redaction, budgets, costs, retries and validated JSON answers; Anthropic, OpenAI, Fake and Replay        | Implemented |
| Assist workflow: `devflow init`, `analyze`, `plan`, `approve`, `reject`, `answer`, `resume`, `cancel`, `status`, `report` | Implemented |
| Java and JS/TS adapters, verification engine, `devflow verify`                                                            | Implemented |
| Source parser: tree-sitter outlines and imports for Java, TypeScript and JavaScript                                       | Implemented |
| Example repositories with real Maven, Gradle and npm builds (`pnpm test:examples`)                                        | Implemented |
| Test generation, implementation, review, `devflow run`                                                                    | Implemented |
| GitHub issues as tasks (`--issue`)                                                                                        | Implemented |
| GitHub pull request review (`review --pr`), opt-in publishing as a comment or check run                                   | Implemented |
| GitHub Action: fork-safe `verify` workflow and gated AI review workflow (not yet run on GitHub)                           | Implemented |
| Draft pull requests from an implement run, with explicit authorization (`pr create --yes`)                                | Implemented |
| Container execution backend (`--backend container`: Docker, no network, resource limits)                                  | Implemented |
| OpenAPI and Protobuf compatibility (built-in rules, oasdiff/buf), in review mode and `devflow contracts diff`             | Implemented |

See the [roadmap](docs/roadmap.md) for details.

## Try it

Requirements: Node.js 22.12 or newer (22.13+ for development), pnpm 10.

```bash
git clone https://github.com/mohamedyangui/DevFlow.git
cd DevFlow
pnpm install
pnpm build
node packages/cli/dist/bin.js task validate examples/tasks/add-pagination.task.md
```

```text
Task file: examples/tasks/add-pagination.task.md (markdown)
Task:      TASK-142 - Add pagination to GET /api/orders
Contents:  2 functional requirements, 1 non-functional requirement, 3 acceptance criteria, 2 definition-of-done items

Result: VALID
```

A task file looks like this (Markdown; YAML and JSON are equivalent):

```markdown
# Add pagination to GET /api/orders

## Requirements

- FR-1: GET /api/orders accepts optional `page` and `size` query parameters.
- NFR-1 [compatibility]: Clients that send no pagination parameters see no change.

## Acceptance Criteria

- [ ] **AC-1**: Second page of results (covers: FR-1) (integration)
  - Given 25 orders exist
  - When a client calls GET /api/orders?page=1&size=10
  - Then orders 11 to 20 are returned
- [ ] AC-2: Existing clients keep working (covers: NFR-1) (regression)
```

More examples are in [`examples/tasks/`](examples/tasks/). Editors that support JSON Schema can
validate YAML task files with [`schemas/task.schema.json`](schemas/task.schema.json).

### Analyse and plan a task (assist mode)

From the root of the repository you want to work on (`devflow` stands for
`node <DevFlow clone>/packages/cli/dist/bin.js`):

```bash
devflow init                                   # .devflow/config.yaml, rules template, .gitignore entry
export ANTHROPIC_API_KEY=...                   # read from the environment only
devflow plan --task tasks/TASK-142.yaml --model <model id>
devflow approve <run id>                       # or: devflow reject <run id> --feedback "..."
devflow report <run id>
```

`plan` exits with code 3 while the plan waits for review; the plan is in
`.devflow/runs/<run id>/artifacts/plan.md`. Assist mode changes no file and runs no command, so
the report's verdict is `not_verified`. Every command is described in the
[CLI specification](docs/specs/cli.md).

### Write tests and record the red baseline (test mode)

```bash
devflow trust                                  # test commands run only in a trusted workspace
devflow test --task tasks/TASK-142.yaml --model <model id>
devflow approve <run id>                       # the plan
devflow approve <run id>                       # the test files, after reviewing them
devflow report <run id>
```

The model writes test files only; they run after you approve them, once, against the current
code. The report shows for each acceptance criterion whether its tests failed as a feature test
should before the change, or passed as a regression test should. Nothing is implemented, so no
criterion is verified yet.

### Implement a task test-first (implement mode)

```bash
devflow trust
devflow implement --task tasks/TASK-142.yaml --model <model id>   # or: devflow run
devflow approve <run id>                       # the plan
devflow approve <run id>                       # the test files; the gates run before the change
devflow approve <run id>                       # the code change, after reviewing the diff
devflow report <run id>
```

The model changes only the files of the approved plan, never the tests. Each change, and each
repair after a failed verification, runs only after you approve it. The report compares the
gates before and after the change: red/green evidence per criterion, regressions, flaky tests,
and a verdict that is `verified` only when every required gate and every criterion's tests
passed. The run needs a clean working tree; it works on its own local branch
(`devflow/TASK-142`) and commits each approved step there. Nothing is pushed or merged.

### Review a local change (review mode)

```bash
devflow review --task tasks/TASK-142.yaml --base main --model <model id>
```

Reviews your working tree against the merge base with `main`: the gates run once on it,
deterministic checks report facts (failed gates, untested criteria, secrets, protected files,
removed public declarations, dependency changes), and the model adds its own findings, which
always stay unverified. No file is changed.

### Use a GitHub issue as the task

```bash
export GITHUB_TOKEN=<token>   # needed for private repositories
devflow plan --issue 142 --model <model id>
```

Every workflow command accepts `--issue` instead of `--task`: a number (the repository comes
from the `origin` remote, or `--repo owner/name`), `owner/name#142` or the issue URL. The
issue body is read as a Markdown task file; its text is treated as untrusted data.

### Review a pull request

```bash
git fetch origin pull/57/head && git checkout --detach FETCH_HEAD
devflow review --task task.yaml --pr 57 --model <model id> --publish
```

DevFlow reads the pull request from the GitHub API but never fetches its code: check out its
head commit first. The review compares it with the pull request's base commit. The code of a
pull request from a fork is not run unless you pass `--run-fork-code`. `--publish` (opt-in,
needs `GITHUB_TOKEN`) posts the summary as a comment, or as a check run with
`--publish check`; it never approves or merges.

### Use in GitHub Actions

`action.yml` builds DevFlow from the commit you pin it to and runs `verify` or
`review --pr`. Two example workflows split the work securely: a fork-safe
[verify workflow](docs/examples/github-actions/devflow-verify.yml) that runs the approved gates
with a read-only token and no secrets, and an
[AI review workflow](docs/examples/github-actions/devflow-review.yml) that holds the model key,
runs no repository code, and starts only for labelled same-repository pull requests or by hand.
See the [GitHub Action specification](docs/specs/github-action.md); the action has not yet
been run on GitHub.

### Open a draft pull request

```bash
devflow pr create <run id>         # prints what it will do, changes nothing
devflow pr create <run id> --yes   # pushes the run's branch and opens a draft
```

For a finished `devflow implement` run: DevFlow pushes only the run's branch to `origin`
(never forced, never the base branch) with your own git credentials, and opens a draft pull
request described from the run's report. `GITHUB_TOKEN` is used only for the API. It never
merges, approves or requests reviews.

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Architecture decision records](docs/adr/README.md)
- Specifications: [task files](docs/specs/task-contract.md),
  [project configuration](docs/specs/project-config.md),
  [CLI](docs/specs/cli.md),
  [language adapters](docs/specs/language-adapter.md),
  [verification and evidence](docs/specs/verification-and-evidence.md),
  [context engine](docs/specs/context-engine.md),
  [security model](docs/specs/security-model.md),
  [GitHub Action](docs/specs/github-action.md)
- [Roadmap](docs/roadmap.md)
- [Original architecture proposal](docs/design/architecture-proposal.md)

## Repository layout

```
packages/
  core/                 @devflow/core                schemas, rules, ports, task loading
  context/              @devflow/context             repository context engine
  ai/                   @devflow/ai                  LLM gateway and model providers
  adapter-java/         @devflow/adapter-java        Maven, Gradle, Spring Boot, JUnit
  adapter-javascript/   @devflow/adapter-javascript  npm, pnpm, Yarn, Vitest, Jest, ESLint
  workflow/             @devflow/workflow            workflow engine, run store, reports
  github/               @devflow/github              GitHub REST client, issues as tasks
  cli/                  @devflow/cli                 the devflow command
examples/tasks/         example task files
schemas/                generated JSON Schema
docs/                   architecture, ADRs, specifications, roadmap
tests/                  repository-level and end-to-end tests
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Author

DevFlow AI is designed and maintained by **Mohamed Yangui**
([@mohamedyangui](https://github.com/mohamedyangui)).

## License

Copyright 2026 Mohamed Yangui. Licensed under the [Apache License 2.0](LICENSE).
