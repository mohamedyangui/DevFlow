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

| Capability                                                                                                                | Status           |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Task files in YAML, JSON and Markdown: parsing, normalization, validation with line numbers                               | Implemented      |
| `devflow task validate [--json] [--strict]`                                                                               | Implemented      |
| Core schemas for tasks, configuration, modules, commands, verification, findings, plans and reports, with invariants      | Implemented      |
| JSON Schema for task and configuration files                                                                              | Implemented      |
| Security layer: path guard, secret redaction, audit log, command policy, trust store, process executor                    | Implemented      |
| `devflow trust [--yes \| --status \| --revoke] [--json]`                                                                  | Implemented      |
| Context engine: discovery, classification, OpenAPI and Protobuf discovery, ranking, packing                               | Implemented      |
| LLM gateway with redaction, budgets, costs, retries and validated JSON answers; Anthropic, OpenAI, Fake and Replay        | Implemented      |
| Assist workflow: `devflow init`, `analyze`, `plan`, `approve`, `reject`, `answer`, `resume`, `cancel`, `status`, `report` | Implemented      |
| Java and JS/TS adapters, verification engine, `devflow verify`                                                            | Implemented      |
| Source parser: tree-sitter outlines and imports for Java, TypeScript and JavaScript                                       | Implemented      |
| Example repositories with real Maven, Gradle and npm builds (`pnpm test:examples`)                                        | Implemented      |
| Test generation, implementation, review, `devflow run`                                                                    | Planned, Phase 4 |
| GitHub issues and pull requests                                                                                           | Planned, Phase 5 |
| OpenAPI and Protobuf compatibility, container sandbox                                                                     | Planned, Phase 6 |

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

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Architecture decision records](docs/adr/README.md)
- Specifications: [task files](docs/specs/task-contract.md),
  [project configuration](docs/specs/project-config.md),
  [CLI](docs/specs/cli.md),
  [language adapters](docs/specs/language-adapter.md),
  [verification and evidence](docs/specs/verification-and-evidence.md),
  [context engine](docs/specs/context-engine.md),
  [security model](docs/specs/security-model.md)
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
