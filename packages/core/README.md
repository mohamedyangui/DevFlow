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
- **`loadProjectConfig`**: reads `.devflow/config.yaml` through the path guard, hashes its
  exact bytes and validates it, with line numbers.
- **`TrustStore`**: workspace trust and command approvals, outside the repository.
- **`CommandPolicy`**: schema and parameter checks, the hard deny list, wrapper binding,
  workspace trust and approval by fingerprint. Its allowed decisions are the only input the
  executor accepts.
- **`Executor`**: runs approved commands without a shell, with the Windows invocation
  strategies of ADR 0014, an allowlisted environment, timeouts with process-tree kill, output
  caps, redaction, logs and audit entries. It is the only code that starts processes
  (ADR 0018).

**Implemented (Phase 3, adapter SDK):**

- **`defineAdapter`** and the strategy interfaces adapters are composed of
  (`DetectionStrategy`, `ResultParser`), with helpers for evidence (`fileEvidence`,
  `evidenceAt`, `findLine`), repository paths (`joinRepoPath`, `isWithin`, `moduleIdFor`) and
  fresh test reports (`freshReportFiles`: report files older than the execution are ignored).
- **`validatedAdapter`**: checks everything an adapter returns against the core schemas and
  the rules they cannot express (module roots, adapter ids, unique command ids, no command on
  the hard deny list). Adapter exceptions become `ADAPTER_FAILED`.
- **`AdapterRegistry`**: registration, module discovery across adapters (or from the
  `modules` of the project configuration), unique module ids, failures reported as warnings.
- **`PathToolchainProbe`**: tells adapters whether a tool is on PATH without running it.
- **`@devflow/core/testing`**: the adapter conformance kit (`checkAdapterConformance`), an
  in-memory `RepositoryView` and a fixed toolchain probe, for adapter tests.

See [docs/specs/language-adapter.md](../../docs/specs/language-adapter.md).

```ts
import { loadTaskFile } from "@devflow/core";

const result = await loadTaskFile("task.yaml");
if (!result.valid) {
  for (const issue of result.issues) console.error(issue.line, issue.code, issue.message);
}
```
