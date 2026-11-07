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

## Phase 2: Core workflow (assist mode end to end) — in progress

Implemented and tested so far:

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

Planned:

- Workflow engine: transition table, modes, step runner, run store, approvals, clarification,
  resume, cancellation, budgets.
- Steps: context loading, requirements analysis, planning, report generation.
- CLI: `init`, `analyze`, `plan`, `approve`, `reject`, `answer`, `resume`, `status`,
  `report`.
- Ports defined with their implementations: executor, run store.

## Phase 3: Language adapters and verification

- Adapter SDK helpers, registry and conformance kit.
- Java adapter (Maven, Gradle, wrappers, Spring Boot, JUnit 5, Mockito, Checkstyle, SpotBugs,
  Protobuf/OpenAPI generator detection) and JS/TS adapter (npm, pnpm, yarn, frameworks, Jest,
  Vitest, ESLint, tsc, `ts-proto`/`protoc-gen-es`/`openapi-typescript` detection).
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
