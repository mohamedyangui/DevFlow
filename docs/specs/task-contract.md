# Specification: task files and the Engineering Task Contract

- **Status:** Implemented in Phase 1 (`@devflow-ai/core`, `devflow task validate`).
- **Schemas:** `TaskFile` and `TaskContract` in `packages/core/src/schemas/task.ts`.
  Generated JSON Schema: [`schemas/task.schema.json`](../../schemas/task.schema.json).

A task describes _what_ to build. DevFlow reads it from a file (YAML, JSON or Markdown), or in
later phases from CLI flags or a GitHub issue, and turns it into a normalized
**Engineering Task Contract** that every later step uses.

## 1. Two schemas

| Schema         | Written by        | Properties                                                                                                                        |
| -------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `TaskFile`     | People            | Forgiving: ids optional, requirements and acceptance criteria may be plain strings, defaults implicit. Strict about unknown keys. |
| `TaskContract` | `normalizeTask()` | Every item has an id, every default is explicit, plus the task's `source` and trust level.                                        |

## 2. File formats

The format is chosen by extension: `.yaml`/`.yml`, `.json`, `.md`/`.markdown`. Files must be
UTF-8 and at most 1 MiB. YAML duplicate keys are errors; aliases are limited to 50 expansions.

### 2.1 YAML / JSON

```yaml
# yaml-language-server: $schema=../../schemas/task.schema.json
id: TASK-142
title: Add pagination to GET /api/orders
description: |
  The orders endpoint returns every order at once.
requirements:
  functional:
    - id: FR-1
      text: GET /api/orders accepts optional page and size query parameters.
    - The response includes an X-Total-Count header. # id assigned: FR-2
  nonFunctional:
    - id: NFR-1
      text: Clients that send no pagination parameters see no change.
      category: compatibility
acceptanceCriteria:
  - id: AC-1
    given: 25 orders exist
    when: a client calls GET /api/orders?page=1&size=10
    then: orders 11 to 20 are returned and X-Total-Count is 25
    covers: [FR-1, FR-2]
    testLevel: integration
  - id: AC-3
    statement: A request without pagination parameters returns the existing response format.
    covers: [NFR-1]
    testIntent: regression
constraints:
  - Do not change the OrderDto JSON shape.
scope:
  modules: [backend]
  include: ["backend/src/**"]
testing:
  levels: [unit, integration]
definitionOfDone:
  - Every acceptance criterion has a passing automated test.
```

| Field                                | Type                               | Notes                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                 | string, required                   | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`                                                                                                                                   |
| `title`                              | string, required                   | 1–200 characters                                                                                                                                                      |
| `description`                        | string                             | up to 20 000 characters                                                                                                                                               |
| `schemaVersion`                      | `1`                                | optional, defaults to 1                                                                                                                                               |
| `requirements.functional[]`          | string or `{id?, text, priority?}` | id `FR-<n>`; priority `must` (default), `should`, `could`                                                                                                             |
| `requirements.nonFunctional[]`       | string or `{id?, text, category?}` | id `NFR-<n>`; category `performance`, `security`, `reliability`, `compatibility`, `usability`, `accessibility`, `maintainability`, `observability`, `other` (default) |
| `acceptanceCriteria[]`               | string or object                   | see below                                                                                                                                                             |
| `constraints[]`                      | string                             |                                                                                                                                                                       |
| `scope.modules[]`                    | module id                          |                                                                                                                                                                       |
| `scope.include[]`, `scope.exclude[]` | repository-relative glob           | no `..`, no absolute paths, no `!` negation                                                                                                                           |
| `testing.levels[]`                   | `unit`, `integration`, `e2e`       |                                                                                                                                                                       |
| `testing.testFirst`                  | boolean                            | default `true`                                                                                                                                                        |
| `testing.notes`                      | string                             |                                                                                                                                                                       |
| `definitionOfDone[]`                 | string                             |                                                                                                                                                                       |
| `metadata`                           | string → string map                | free-form, not interpreted                                                                                                                                            |

**Acceptance criterion object:**

| Field                   | Notes                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`                    | `AC-<n>`, optional                                                                                               |
| `statement`             | free text; required unless `then` is given                                                                       |
| `given`, `when`, `then` | Given/When/Then clauses; when `statement` is absent it is composed as "Given …, when …, then …"                  |
| `covers[]`              | requirement ids (`FR-n`, `NFR-n`) this criterion verifies                                                        |
| `verification`          | `automated` (default) or `manual`                                                                                |
| `testLevel`             | `unit`, `integration`, `e2e`                                                                                     |
| `testIntent`            | `feature` (default), `regression`, `characterization` — see [ADR 0015](../adr/0015-test-intent-and-red-green.md) |

### 2.2 Markdown

Markdown tasks are meant to be readable as ordinary documents and to work for GitHub issues
(Phase 5). The parser recognizes a small set of conventions and **never guesses**: text it
cannot place produces a warning with a line number.

```markdown
---
id: TASK-142
scope:
  modules: [backend]
---

# Add pagination to GET /api/orders

Free text before the first section becomes the description.

## Requirements

- FR-1: GET /api/orders accepts optional `page` and `size` query parameters.
- NFR-1 [compatibility]: Clients that send no pagination parameters see no change.

## Acceptance Criteria

- [ ] **AC-1**: Second page of results (covers: FR-1) (integration)
  - Given 25 orders exist
  - When a client calls GET /api/orders?page=1&size=10
  - Then orders 11 to 20 are returned
- [ ] AC-2: Existing clients keep working (covers: NFR-1) (regression)

## Constraints

- Do not change the OrderDto JSON shape.

## Definition of Done

- Every acceptance criterion has a passing automated test.
```

Rules:

- **Front matter** (optional) is YAML between `---` lines at the top. It may contain any
  `TaskFile` field. A field defined both in front matter and in the body is an error.
- **Title:** the first `#` heading. **Description:** text before the first `##` section, plus
  sections named _Description_ or _Overview_, plus unknown sections (kept with their heading).
- **Sections** (case-insensitive): _Requirements_ (items prefixed `NFR-` are non-functional,
  all others functional), _Functional Requirements_, _Non-Functional Requirements_,
  _Acceptance Criteria_, _Constraints_, _Definition of Done_.
- **List items:** `-`, `*`, `+` or `1.` bullets; continuation lines are joined; checkboxes are
  ignored. Item heads may start with an id: `AC-1:`, `**AC-1**:`, `**AC-1:**`, `AC-1 -`, and
  for non-functional requirements an optional category: `NFR-1 [performance]:`.
- **Trailing groups** in parentheses at the end of an acceptance criterion:
  `(covers: FR-1, FR-2)` and the tags `manual`, `automated`, `feature`, `regression`,
  `characterization`, `unit`, `integration`, `e2e`. Several groups may follow each other.
- **Child bullets** of an acceptance criterion starting with _Given_, _When_, _Then_ or _And_
  fill the corresponding clause (_And_ continues the previous clause).
- Fenced code blocks are ignored. CRLF line endings are accepted.

## 3. Normalization

`normalizeTask()` produces the contract:

- Items without an id get the **lowest free** `<prefix>-<n>`; explicit ids are never changed.
- Strings expand to objects with defaults: priority `must`, category `other`,
  verification `automated`, testIntent `feature`, `testFirst` true.
- Array order is preserved, so issue paths point at the right place in the source file.
- `source` records where the task came from (`file`, `cli`, `github-issue`), a reference (the
  file path relative to the working directory, or `owner/name#142` for an issue), and a
  **trust level**: `user` for files and flags, `external` for issues. External text defines
  the task but never changes DevFlow's policies.
- A GitHub issue's body is parsed as a Markdown task. When the body does not define them, the
  id is `GH-<number>` and the title is the issue title; values in the body always win.

## 4. Validation and lint

Validation happens in three stages; each issue has a severity, a stable code, a message, a
path (e.g. `acceptanceCriteria[1].covers[0]`) and, when known, a 1-based line number.

| Code                              | Severity | Meaning                                                      |
| --------------------------------- | -------- | ------------------------------------------------------------ |
| `TASK_PARSE_ERROR`                | error    | YAML/JSON syntax error, duplicate YAML key, alias limit      |
| `TASK_MARKDOWN_FRONT_MATTER`      | error    | unclosed front matter, or front matter that is not a mapping |
| `TASK_MARKDOWN_CONFLICT`          | error    | a field is defined in front matter and in the body           |
| `TASK_MARKDOWN_UNPARSED_TEXT`     | warning  | Markdown text that fits no section or list item              |
| `TASK_SCHEMA`                     | error    | the content does not match `TaskFile`                        |
| `TASK_DUPLICATE_ID`               | error    | two items share an id                                        |
| `TASK_UNKNOWN_REQUIREMENT_REF`    | error    | `covers` names a requirement that does not exist             |
| `TASK_INCOMPLETE_GIVEN_WHEN_THEN` | warning  | a criterion uses some but not all of Given/When/Then         |
| `TASK_NO_ACCEPTANCE_CRITERIA`     | warning  | the task has no acceptance criteria                          |
| `TASK_NO_TRACEABILITY`            | warning  | requirements exist but no criterion covers any               |
| `TASK_UNCOVERED_REQUIREMENT`      | warning  | a functional requirement is covered by no criterion          |
| `TASK_EMPTY_DEFINITION_OF_DONE`   | warning  | no definition of done                                        |

A task is **valid** when it has no errors. `devflow task validate --strict` also fails on
warnings. Problems that make the file unusable (not found, not a file, larger than 1 MiB, not
UTF-8, unsupported extension) are not issues; they raise a `DevflowError` and the CLI exits
with code 2.

## 5. Public API

```ts
import {
  loadTaskFile,
  parseTaskText,
  validateTaskInput,
  normalizeTask,
  lintTask,
} from "@devflow-ai/core";

const task = await loadTaskFile("tasks/add-pagination.task.yaml");
task.valid; // boolean
task.contract; // TaskContract | undefined
task.issues; // readonly ValidationIssue[]
```
