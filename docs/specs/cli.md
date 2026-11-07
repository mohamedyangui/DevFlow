# Specification: command-line interface

- **Status:** Phase 1 implements `devflow --version`, `devflow --help` and
  `devflow task validate`. Every other command listed in section 4 is planned and does **not**
  exist yet.

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
| 70   | Internal error (a bug in DevFlow)                                             |

Planned for later phases: 3 waiting for input (approval or clarification), 4 budget exceeded,
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

## 4. Planned commands

| Command                                                   | Phase | Purpose                                                                                  |
| --------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `devflow init`                                            | 2     | Detect the project, write `.devflow/config.yaml`, rule templates and the gitignore entry |
| `devflow trust`                                           | 2     | Review and trust the workspace configuration and commands                                |
| `devflow analyze --task <file>`                           | 2     | Requirements analysis and clarification questions                                        |
| `devflow plan --task <file>`                              | 2     | Implementation plan                                                                      |
| `devflow approve` / `reject --feedback` / `answer --file` | 2     | Human decisions on a paused run                                                          |
| `devflow resume <run>` / `status` / `report <run>`        | 2     | Run management                                                                           |
| `devflow verify`                                          | 3     | Run the configured gates                                                                 |
| `devflow test --task <file>`                              | 4     | Generate and run tests for the acceptance criteria                                       |
| `devflow implement --task <file>` / `run --task <file>`   | 4     | Full workflow                                                                            |
| `devflow review`                                          | 4     | Review a local diff                                                                      |
| `devflow run --issue <n>`, `review --pr <n>`              | 5     | GitHub sources                                                                           |

Workflow commands will accept `--mode assist|test|implement|review`. The SDK exported by
`@devflow/workflow` (Phase 2) exposes the same operations programmatically.
