# Roadmap

This page tracks what **exists** and what is **planned**. Nothing is listed as implemented
unless the code exists and its checks pass. The detailed plan for each phase is in section 18
of the [architecture proposal](design/architecture-proposal.md).

## Phase 1: Architecture and foundation — complete

Implemented and tested:

- pnpm workspace, TypeScript project references, ESLint with package-boundary rules,
  Prettier, Vitest, and a CI workflow (Ubuntu and Windows × Node 22, 24, 26).
- Seven packages; `core` and `cli` have content, the other five are empty skeletons.
- `@devflow/core`: Zod schemas for tasks, configuration, modules, commands, verification,
  findings, plans and reports, with their invariants; ports; error model; red/green evidence
  rules.
- Task loading from YAML, JSON and Markdown, normalization, and lint with line numbers.
- CLI: `devflow --version`, `devflow task validate [--json] [--strict]`.
- JSON Schema for task and configuration files, with a drift check.
- npm scope rename script and publication guard (all packages private).
- Architecture overview, ADRs 0001–0017, specifications.

## Phase 2: Core workflow (assist mode end to end) — complete

Implemented and tested:

- Path guard, secret detection and redaction, audit log and redacting logger
  (`@devflow/core`, [security model](specs/security-model.md) sections 6 to 8).
- Project configuration loader, trust store and `devflow trust`
  ([security model](specs/security-model.md) section 3.1).
- Command policy with the hard deny list and approval by fingerprint, and the executor
  (security model sections 4 and 5). The in-house launcher replaces `cross-spawn`
  ([ADR 0018](adr/0018-in-house-process-launcher.md)).
- Executor integration tests that start real processes: argument round trip, environment
  scrubbing, redaction, output cap, timeout with process-tree kill, cancellation. On the
  `windows-latest` CI leg also the Windows strategies of
  [ADR 0014](adr/0014-windows-invocation.md): batch argument round trip, rejection of forbidden
  characters before any process starts, `node-script` shims, `java-launcher` resolution.
  Running a real Gradle or Maven wrapper waits for the Phase 3 example builds.
- Context engine (`@devflow/context`, [spec](specs/context-engine.md)): discovery honouring
  ignore files, classification, **read-only `.proto` and OpenAPI discovery**
  ([ADR 0017](adr/0017-contract-aware-context.md)), sensitive-content filtering, instruction
  loading, explainable BM25 ranking ([ADR 0008](adr/0008-lexical-ranking.md)) and packing to a
  token budget.
- LLM gateway (`@devflow/ai`, [ADR 0010](adr/0010-llm-providers.md)): redaction with audit
  entries, token and call budgets checked before each call, retries with backoff and jitter
  that honour `retry-after`, timeouts, cancellation, JSON answers validated with Zod and one
  repair request, an llm-call audit entry per call. Providers: Anthropic (official SDK, loaded
  lazily, tested against a local HTTP stand-in), Fake (scripted) and Replay (cassettes keyed by
  a request hash, with a record mode). A live API test runs only when `ANTHROPIC_API_KEY` and
  `DEVFLOW_LIVE_MODEL` are set; it is skipped otherwise and has not been run.
- Workflow engine (`@devflow/workflow`, [ADR 0004](adr/0004-state-machine-and-run-store.md)):
  transition table tested exhaustively per mode, run store with atomic writes, schema
  validation on read and a lock file, assist mode end to end (context loading, requirements
  analysis with clarification, planning with deterministic plan checks and one revision, plan
  approval and rejection with feedback), resume after budget, provider, cancellation and crash
  interruptions, cancellation, and `not_verified` reports in JSON and Markdown. Tested with the
  Fake provider; no run against a real model has been made.

- CLI ([spec](specs/cli.md)): `init`, `analyze`, `plan`, `approve`, `reject`, `answer`,
  `resume`, `cancel`, `status`, `report`, with exit codes 3 (waiting for a person), 4 (budget
  exceeded) and 130 (Ctrl+C, resumable).
- End-to-end tests of the CLI: each scenario is recorded with a scripted model into a Replay
  cassette, then replayed in a fresh workspace with `--provider replay`. Scenarios: plan and
  approve, analyze only, rejection with feedback, clarification answers, budget exceeded and
  resume, resume after a crashed process (stale lock), a run locked by a live process,
  cancellation, untrusted configuration, and a prompt-injection fixture showing that nothing is
  executed, written or approved.

Not done in Phase 2: no run against a real model has been made (the live Anthropic test is
skipped without an API key), and exit code 5 (policy denial) waits for the commands that run
builds in Phase 3.

## Phase 3: Language adapters and verification — in progress

Implemented and tested so far:

- Adapter SDK (`defineAdapter`, detection strategies, evidence and path helpers, fresh report
  files), output validation, adapter registry with module discovery, PATH toolchain probe, and
  the conformance kit in `@devflow/core/testing`
  ([spec](specs/language-adapter.md) section 8).
- Java adapter (`@devflow/adapter-java`, [spec](specs/language-adapter.md) section 9): Maven
  and Gradle (Groovy and Kotlin DSL, multi-module, version catalogs, wrappers), Spring Boot,
  JUnit 5/4, TestNG, Mockito, AssertJ, Testcontainers, Checkstyle, SpotBugs, PMD, JaCoCo,
  Spotless, Protobuf/OpenAPI generator detection; test inventory, conventions, authoring guide,
  command catalog, and parsers for JUnit XML, Checkstyle, SpotBugs and compiler output. Tested
  with in-memory fixture repositories and the conformance kit; no real Maven or Gradle build has
  been run against it yet (that comes with the example repositories below).

Planned:

- JS/TS adapter (npm, pnpm, yarn, frameworks, Jest, Vitest, ESLint, tsc,
  `ts-proto`/`protoc-gen-es`/`openapi-typescript` detection).
- `SourceParser` spike with `web-tree-sitter` ([ADR 0009](adr/0009-tree-sitter.md)).
- Verification engine and `devflow verify`.
- Example repositories. **Decision D5:** Maven and Gradle wrappers are generated once with the
  official Docker images at pinned versions, and `distributionSha256Sum` is set so wrappers
  verify their downloads. Wrapper JAR hashes are recorded for command fingerprints.
- Integration tests against real builds; skipped with a stated reason when a toolchain is
  missing.

## Phase 4: AI implementation workflow (completes the MVP)

- OpenAI provider, price table, per-step model routing.
- Test design with red/green evidence ([ADR 0015](adr/0015-test-intent-and-red-green.md)),
  implementation with search/replace edits, bounded repair loop, regression detection,
  review engine.
- `test`, `implement`, `run`, `review` commands.
- Example reports from real runs.

## Phase 5: GitHub integration

Issue source, PR review, opt-in publishing of comments and check runs, draft PR preparation
with explicit authorization, GitHub Action with a documented secure workflow split.

## Phase 6: Advanced features

Protobuf and OpenAPI compatibility verification (`buf`, `oasdiff`, built-in rules), cross-
language change impact, container execution backend, external adapter plugins, Python adapter,
observability export, evidence-seeking review.

## Before the first publication

- Verify ownership of the npm scope, or rename it with `pnpm scope:rename`
  ([ADR 0016](adr/0016-npm-scope-and-publication.md)).
- Release ADR: versioning, changelog, provenance, removing `private`.
