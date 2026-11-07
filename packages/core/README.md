# @devflow/core

The foundation every other DevFlow package builds on. It has no dependencies on other
workspace packages.

**Implemented (Phase 1):**

- **Schemas** (Zod 4, with inferred TypeScript types) for every artifact exchanged between
  components: the task file and the normalized Engineering Task Contract, project
  configuration, module profiles, commands and execution records, verification results and
  red/green test evidence, findings, implementation plans and engineering reports. Each one
  enforces invariants. For example, a gate cannot be `passed` without an execution record, and
  an AI finding cannot be `confirmed` without deterministic evidence.
- **Ports**: the interfaces that extensions implement (`LanguageAdapter`, `RepositoryView`,
  `ToolchainProbe`, `LlmProvider`, `IssueSource`).
- **Task loading**: YAML, JSON and Markdown task files are parsed, normalized and linted, and
  every issue carries a path and a line number (`loadTaskFile`, `parseTaskText`).
- **Domain rules**: classification of red/green test evidence (`assessTestEvidence`).
- **JSON Schema** generation for task files and project configuration.

**Implemented (Phase 2, security primitives):**

- **`PathGuard`**: containment, symbolic links, Windows device names and alternate data
  streams, sensitive paths (never sent to a model) and write-protected paths.
- **`SecretRedactor`**: built-in secret detectors, redaction markers with a short hash, deep
  redaction of structured values.
- **`AuditLog`**: append-only, redacted, schema-validated `audit.jsonl`.
- **`createLogger`**: a structured logger that redacts every record.

**Not implemented yet:** the command policy, trust store and executor (Phase 2, next). See
[docs/specs/security-model.md](../../docs/specs/security-model.md).

```ts
import { loadTaskFile } from "@devflow/core";

const result = await loadTaskFile("task.yaml");
if (!result.valid) {
  for (const issue of result.issues) console.error(issue.line, issue.code, issue.message);
}
```
