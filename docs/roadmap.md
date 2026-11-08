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
skipped without an API key), and exit code 5 (policy denial) waited for the commands that run
builds; it came with `devflow verify` in Phase 3.

## Phase 3: Language adapters and verification — complete

Implemented and tested:

- Adapter SDK (`defineAdapter`, detection strategies, evidence and path helpers, fresh report
  files), output validation, adapter registry with module discovery, PATH toolchain probe, and
  the conformance kit in `@devflow/core/testing`
  ([spec](specs/language-adapter.md) section 8).
- Java adapter (`@devflow/adapter-java`, [spec](specs/language-adapter.md) section 9): Maven
  and Gradle (Groovy and Kotlin DSL, multi-module, version catalogs, wrappers), Spring Boot,
  JUnit 5/4, TestNG, Mockito, AssertJ, Testcontainers, Checkstyle, SpotBugs, PMD, JaCoCo,
  Spotless, Protobuf/OpenAPI generator detection; test inventory, conventions, authoring guide,
  command catalog, and parsers for JUnit XML, Checkstyle, SpotBugs and compiler output. Tested
  with in-memory fixture repositories and the conformance kit, and against real Maven and
  Gradle builds of the example repositories (below).
- JavaScript/TypeScript adapter (`@devflow/adapter-javascript`,
  [spec](specs/language-adapter.md) section 10): npm, pnpm, Yarn and Bun projects and
  workspaces, TypeScript, Express, Fastify, NestJS, Next.js, React, Vue, Angular, Vite, Vitest,
  Jest, Mocha, Playwright, ESLint, Prettier, `tsc`, Protobuf and OpenAPI generator detection;
  test inventory, conventions, authoring guide, a command catalog that runs installed tools'
  entry scripts with `node`, and parsers for Jest/Vitest JSON, ESLint JSON and `tsc` output.
  Tested with in-memory fixture repositories and the conformance kit. Its commands were also
  run once by hand on a sample project with Vitest 5.1, ESLint 10.14, TypeScript 6.0 and
  Prettier 3.9, and their output parsed as specified; Jest has not been run against it.
- Command policy: a `node` script must be an existing file inside the workspace, and is bound
  into the approval fingerprint by its hash.
- Verification engine (`@devflow/core`, [spec](specs/verification-and-evidence.md) section
  4.1) and `devflow verify` ([CLI spec](specs/cli.md)): the configured gates, or a test gate
  per module; every command through the command policy (interactive approval, or
  `--allow <fingerprint>`); statuses decided from the exit code and the parsed results, never
  upgraded; results saved with redacted logs and an audit log; comparison with a baseline
  run; exit code 5 when the policy stopped a required command. Tested with fake executions,
  with the real policy and executor running a node script, and in the CLI tests with a
  stand-in Vitest package. Also run once by hand with Vitest 5.1 on a sample project: a
  failing test was reported as failed, and after the fix the comparison with the failed run
  reported it as fixed. Maven, Gradle, npm/Vitest and `tsc` runs go through it in the example
  builds (below).
- Source parser ([ADR 0009](adr/0009-tree-sitter.md), spike results in the ADR): the
  `SourceParser` port in `@devflow/core`, and in `@devflow/context` a `web-tree-sitter`
  implementation with pinned grammars for Java, TypeScript, TSX and JavaScript, falling back
  to the regex outline. It provides the outlines of the context pack and the import edges of
  ranking. Tested by parsing real code with the pinned grammars, including invalid code and
  non-ASCII text.

- Example repositories ([examples](../examples/README.md)): `java-spring-boot` (Spring Boot
  4.1, Maven wrapper with its JAR), `java-gradle` (Gradle 9.9, Kotlin DSL, JUnit 6),
  `nodejs-express` (Express 5, Vitest, Supertest) and `fullstack-monorepo` (a Maven backend
  with a script-only wrapper and a TypeScript web module, with modules and gates in
  `.devflow/config.yaml`). **Decision D5**, as carried out: the wrappers were generated with
  Maven 3.9.16 and Gradle 9.9.0 downloaded from their official sites and checked against the
  published checksums (the pinned Docker images could not be pulled on the development
  machine), and `distributionSha256Sum` (plus `wrapperSha256Sum` for the Maven wrapper JAR) is
  set so the wrappers verify their downloads. The wrapper JAR hashes are recorded in the
  examples README; approvals bind the wrapper files by hash.
- Integration tests against real builds (`pnpm test:examples`, `tests/examples`): each example
  is copied to a temporary directory, trusted, approved by fingerprint and verified with
  `devflow verify`; a broken test or type must then fail its gate and show as a regression
  against the green run; the Surefire `test=` selection, the Gradle `--tests` filter and the
  Vitest test name filter run through the command policy and executor and report only the
  selected tests. They need Java 21 or newer, npm and network access, and are skipped in
  `pnpm test` with the reason in the test title. All four passed on Windows 11 with Java 21.0.12
  and Node.js 22.12 on 2026-11-08; they have not been run on Linux or macOS.
- Found by the real builds: a filtered Maven run right after a full run read the full run's
  Surefire reports, because report files up to two seconds older than the start counted as
  fresh. The tolerance now applies only to times on a whole second (coarse file systems).

## Phase 4: AI implementation workflow (completes the MVP)

Implemented and tested so far:

- OpenAI provider (Responses API, strict structured output, `store: false`), cost tracking
  from a configured price table (`ai.prices`; no built-in prices), the cost budget
  `maxCostUsdPerRun` for priced calls, costs in the audit log, `devflow status` and the report,
  and per-step model routing for analysis, planning, test design, implementation and review
  ([ADR 0010](adr/0010-llm-providers.md)). Tested through the real SDK against a local HTTP
  server standing in for the API; no live OpenAI call has been made.
- Requirements analysis with edge cases (marked when no acceptance criterion covers them),
  contradictions and dependencies (`EC-n`, `CT-n`, `DEP-n`). A contradiction always becomes a
  blocking question for a person, so the run waits for clarification; the report gives each
  contradiction with its resolution. Analyses written before this change still load. Tested
  with the fake provider; not yet run against a live model.

Planned:

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
