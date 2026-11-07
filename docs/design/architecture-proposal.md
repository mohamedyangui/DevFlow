# DevFlow AI — Architecture & MVP Proposal

> **Status:** Approved 2026-11-06 with decisions D1–D7 as recommended and six refinements
> (Windows invocation, test intent, trusted-only local execution, configurable npm scope,
> Protobuf awareness, one CLI/SDK for Java and JS/TS).
> **Date:** 2026-11-06 · **Phase:** 0 (architecture and MVP planning)
>
> This document is kept as the historical record of the approved proposal and is not updated.
> The maintained documents are the [architecture overview](../architecture/overview.md), the
> [ADRs](../adr/README.md) (0014–0017 record the refinements), the
> [specifications](../specs/), and the [roadmap](../roadmap.md). Where they differ from this
> proposal, they take precedence.

---

## 1. Current state of the repository

| Item                  | Finding                                                                     | Consequence                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `D:\DevFlow`          | Empty, not a git repository                                                 | Greenfield project. Nothing to preserve or migrate.                                                                                     |
| Node.js / npm / pnpm  | v22.12.0 / 11.19.1 / 10.34.1                                                | Baseline is Node 22 LTS with pnpm workspaces.                                                                                           |
| git                   | 2.54                                                                        | File discovery and branch isolation can use git.                                                                                        |
| Java                  | OpenJDK 21.0.12                                                             | The Java adapter can be tested on this machine...                                                                                       |
| Maven / Gradle        | **Not installed**                                                           | ...but builds need wrappers, which download Maven or Gradle on first use, or Docker images (decision D5).                               |
| Docker                | 29.9.2                                                                      | Can supply the Java toolchain now and the container sandbox later.                                                                      |
| yarn, gh, protoc, buf | Not installed                                                               | yarn execution is tested in CI only. GitHub is called through its REST API, so `gh` isn't needed. Proto tooling is deferred to Phase 6. |
| npm names             | `devflow` and `devflow-ai` are taken. No `@devflow/*` package is published. | The npm scope has to be claimed before the first publish (decision D3).                                                                 |

---

## 2. Architecture overview

### 2.1 Guiding principle: the AI proposes, deterministic code decides

DevFlow splits the work into three planes:

| Plane         | Implemented by                            | Responsibilities                                                                     | Trust                                              |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **Reasoning** | LLM                                       | Interpret requirements, propose plans, draft tests and code, suggest review findings | Untrusted. Output is always schema-validated data. |
| **Control**   | Deterministic TypeScript                  | State machine, approvals, security policy, path guard, budgets, scope enforcement    | Trusted                                            |
| **Evidence**  | Deterministic TypeScript and native tools | Run builds, tests and linters; parse results; compute traceability; render reports   | The source of truth for every status               |

This has three structural consequences. They don't depend on prompt wording:

1. **The LLM never produces a shell command that gets executed.** It can only _select_ a command from a catalog the adapters generate, by id. Any parameter it supplies, such as a test filter, is checked against a pattern first.
2. **The LLM never writes files.** It returns an `EditSet`. The control plane checks every path against the workspace boundary, the scope of the approved plan and the protected-path list, and checks the file's current content hash before it applies the edit.
3. **Every reported status comes from the evidence plane.** AI findings are labelled `source: "ai"` and stay `unverified` until deterministic evidence is attached.

### 2.2 Component diagram

```mermaid
flowchart TB
  subgraph IF["Interfaces"]
    CLI["@devflow/cli<br/>devflow command"]
    SDK["Programmatic SDK<br/>(exported by @devflow/workflow)"]
    GHA["GitHub Action<br/>(Phase 5)"]
    IDE["IDE extension<br/>(future)"]
  end

  subgraph WF["@devflow/workflow"]
    ORCH["Orchestrator<br/>typed state machine"]
    STEPS["Steps<br/>Analyze · Plan · TestDesign · Implement · Verify · Review"]
    PROMPTS["Versioned prompt templates"]
    STORE[("Run store<br/>.devflow/runs/&lt;run-id&gt;")]
    REPORT["Report generator<br/>JSON → Markdown"]
  end

  subgraph INT["Intelligence"]
    CTX["@devflow/context<br/>discovery · instructions · ranking · packing"]
    AI["@devflow/ai<br/>LLM gateway · Anthropic · OpenAI · Fake/Replay"]
    AJ["@devflow/adapter-java<br/>Maven · Gradle · JUnit 5"]
    AJS["@devflow/adapter-javascript<br/>npm · pnpm · yarn · Jest · Vitest"]
    CON["@devflow/contracts<br/>OpenAPI · Protobuf (Phase 6)"]
    GH["@devflow/github<br/>issues · PRs · checks (Phase 5)"]
  end

  subgraph CORE["@devflow/core (no internal dependencies)"]
    SCH["Zod schemas<br/>task · plan · results · findings · report"]
    PORTS["Ports<br/>LanguageAdapter · LlmProvider · IssueSource · RunStore"]
    POL["Security policy<br/>PathGuard · CommandPolicy · TrustStore · Redactor"]
    EXE["Executor<br/>no shell · env allowlist · timeouts"]
    AUD["Audit log · structured logger"]
  end

  CLI --> ORCH
  SDK --> ORCH
  GHA --> CLI
  IDE -.-> SDK
  ORCH --> STEPS
  STEPS --> PROMPTS
  ORCH --> STORE
  ORCH --> REPORT
  STEPS --> CTX
  STEPS --> AI
  STEPS --> CON
  CTX --> AJ
  CTX --> AJS
  STEPS --> EXE
  GH --> PORTS
  AJ --> PORTS
  AJS --> PORTS
  AI --> PORTS
  CTX --> POL
  AI --> POL
  EXE --> POL
  EXE --> AUD
  AI --> AUD
```

### 2.3 Lifecycle of `devflow run --task` (implement mode)

```mermaid
sequenceDiagram
  actor Dev as Developer
  participant CLI
  participant WF as Orchestrator
  participant CTX as Context engine
  participant LLM as LLM gateway
  participant AD as Language adapters
  participant EX as Policy and executor

  Dev->>CLI: devflow run --task task.yaml
  CLI->>WF: start(mode = implement)
  WF->>CTX: load(repository, task)
  CTX->>AD: detectModules / analyzeModule
  WF->>LLM: analyze(task, ranked context)  [redacted, budgeted]
  alt blocking ambiguity
    WF-->>Dev: questions (CLARIFICATION_REQUIRED, exit code 3)
  end
  WF->>LLM: plan(...)
  WF-->>Dev: plan.md (AWAITING_PLAN_APPROVAL, exit code 3)
  Dev->>CLI: devflow approve RUN_ID, then devflow resume RUN_ID
  WF->>EX: run baseline gates on the base commit
  WF->>LLM: derive scenarios and generate tests (EditSet)
  WF->>EX: apply edits (PathGuard), run new tests (expect red)
  WF->>LLM: implement (EditSet, read-only tools)
  WF->>EX: apply edits, run gates
  EX->>AD: parseResults
  loop up to N repair attempts while failures are repairable
    WF->>LLM: repair(redacted diagnostics)
    WF->>EX: apply edits, rerun gates
  end
  WF->>LLM: review(diff, requirements, conventions)
  WF-->>Dev: report.md and report.json
```

In an interactive terminal, approvals and clarification questions can be answered inline. Without a terminal (in CI, or with `--non-interactive`), the run is persisted, the process exits with code 3, and the developer continues it later with `devflow resume`.

---

## 3. Repository structure and package boundaries

The prompt proposes 12 or more packages. I propose **7 MVP packages plus 2 later ones**. A new package is created only where the consumers or the dependency footprint really differ:

- adapters are installed and versioned on their own;
- the LLM SDKs are heavy and optional;
- the CLI is a composition root.

The engines (analysis, planning, test design, implementation, verification, review, reporting) share one lifecycle and the same types, so they live together in `@devflow/workflow`.

```
devflow-ai/                         (D:\DevFlow)
├── packages/
│   ├── core/                 @devflow/core              schemas, ports, security policy, executor, audit, errors
│   ├── context/              @devflow/context           discovery, classification, instructions, ranking, packing, git
│   ├── ai/                   @devflow/ai                LLM gateway, Anthropic, OpenAI, Fake and Replay providers
│   ├── adapter-java/         @devflow/adapter-java      Maven, Gradle, Spring Boot, JUnit 5, Mockito, Checkstyle, SpotBugs
│   ├── adapter-javascript/   @devflow/adapter-javascript npm, pnpm, yarn, Express, NestJS, React, Next.js, Jest, Vitest, ESLint, tsc
│   ├── workflow/             @devflow/workflow          orchestrator, steps, prompts, run store, reporting, SDK entry point
│   ├── cli/                  @devflow/cli               `devflow` binary
│   ├── github/               @devflow/github            (Phase 5)
│   └── contracts/            @devflow/contracts         (Phase 6)
├── templates/                rule packs and task templates used by `devflow init`
│   ├── spring-boot/  ├── nestjs/  ├── express/  └── react/
├── examples/
│   ├── java-spring-boot/     Maven wrapper, Spring Boot, JUnit 5, Mockito
│   ├── nodejs-express/       TypeScript, Express, Vitest, ESLint
│   └── fullstack-monorepo/   Spring Boot backend, React (Vite) frontend, openapi.yaml
├── tests/
│   ├── fixtures/repos/       small synthetic repositories for detection tests
│   └── e2e/                  CLI end-to-end tests using the Replay provider
├── docs/
│   ├── architecture/  ├── adr/  ├── specs/  ├── guides/  └── examples/reports/
├── schemas/                  generated JSON Schema for task and config files (editor autocompletion)
├── .github/workflows/ci.yml
├── package.json · pnpm-workspace.yaml · tsconfig.base.json · vitest.workspace.ts · eslint.config.js
└── README.md · CONTRIBUTING.md · SECURITY.md · LICENSE
```

**Dependency rules.** These are enforced with TypeScript project references and an ESLint import-boundary rule.

| Package               | May depend on                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `core`                | external libraries only (`zod`, `yaml`, `cross-spawn`)                                                  |
| `adapter-*`           | `core` only. Adapters receive a read-only `RepositoryView`. They cannot write files or spawn processes. |
| `context`             | `core`, and adapters through the `AdapterRegistry` port                                                 |
| `ai`                  | `core`                                                                                                  |
| `workflow`            | `core`, `context`, `ai` (through ports)                                                                 |
| `github`, `contracts` | `core`                                                                                                  |
| `cli`                 | everything (composition root)                                                                           |

---

## 4. Workflow engine

### 4.1 States and transitions

```mermaid
stateDiagram-v2
  [*] --> TASK_RECEIVED
  TASK_RECEIVED --> CONTEXT_LOADING
  CONTEXT_LOADING --> REQUIREMENTS_ANALYSIS
  CONTEXT_LOADING --> VERIFICATION: review mode without a task
  REQUIREMENTS_ANALYSIS --> CLARIFICATION_REQUIRED: blocking questions
  CLARIFICATION_REQUIRED --> REQUIREMENTS_ANALYSIS: answers provided
  REQUIREMENTS_ANALYSIS --> PLANNING
  REQUIREMENTS_ANALYSIS --> VERIFICATION: review mode
  PLANNING --> AWAITING_PLAN_APPROVAL: approval required
  PLANNING --> TEST_DESIGN: approval not required
  PLANNING --> COMPLETED: assist mode
  AWAITING_PLAN_APPROVAL --> TEST_DESIGN: approved
  AWAITING_PLAN_APPROVAL --> PLANNING: changes requested (with feedback)
  TEST_DESIGN --> IMPLEMENTATION: implement mode
  TEST_DESIGN --> VERIFICATION: test mode
  IMPLEMENTATION --> VERIFICATION
  VERIFICATION --> IMPLEMENTATION: repairable failure, attempts below N
  VERIFICATION --> REVIEW
  REVIEW --> COMPLETED
  COMPLETED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
  note right of FAILED
    Any non-terminal state can move to FAILED
    (error, policy denial, budget) or to CANCELLED.
    A report is written for every terminal state.
  end note
```

- The transition table is a typed constant. Any transition that isn't in the table, or isn't allowed by the active mode profile, throws `INVALID_TRANSITION`.
- **Workflow status is kept separate from the result verdict.** `COMPLETED` means the workflow ran to the end. The report then carries a verdict: `verified`, `partially_verified`, `failed_verification` or `not_verified`. `FAILED` means the workflow itself couldn't continue. A run whose tests still fail after N repairs is `COMPLETED` with the verdict `failed_verification`. It is never reported as a success.

### 4.2 Mode profiles

| Mode        | Path                                                                                         | Modifies code   |
| ----------- | -------------------------------------------------------------------------------------------- | --------------- |
| `assist`    | TASK → CONTEXT → ANALYSIS (→ CLARIFICATION) → PLANNING → COMPLETED                           | No              |
| `test`      | ... → PLANNING → APPROVAL → TEST_DESIGN → VERIFICATION → REVIEW → COMPLETED                  | Test files only |
| `implement` | ... → PLANNING → APPROVAL → TEST_DESIGN → IMPLEMENTATION ⇄ VERIFICATION → REVIEW → COMPLETED | Yes             |
| `review`    | TASK? → CONTEXT → (ANALYSIS) → VERIFICATION → REVIEW → COMPLETED                             | No              |

### 4.3 Step contract

```ts
export interface StepDefinition<I, O> {
  readonly id: StepId; // e.g. "requirements-analysis"
  readonly state: WorkflowState; // the state this step runs in
  readonly input: z.ZodType<I>; // validated before run()
  readonly output: z.ZodType<O>; // validated after run(), then persisted
  readonly capabilities: readonly Capability[]; // e.g. ["llm", "repo:read"] — least privilege
  approval?(output: O, run: RunSnapshot): ApprovalRequirement | undefined;
  run(input: I, ctx: StepContext): Promise<StepOutcome<O>>;
}

export type StepOutcome<O> =
  | { kind: "ok"; output: O }
  | { kind: "needs-clarification"; questions: ClarificationQuestion[] }
  | { kind: "failed"; error: DevflowError; retryable: boolean };
```

`StepContext` gives a step only the capabilities it declares:

- `logger`, `audit`, `budget` and `signal` (`AbortSignal`) are always available;
- `repo` is a read-only `RepositoryView`;
- `llm` is the gateway, already redacted and budgeted;
- `executor` is policy-gated;
- `workspace` is a writer, given only to the TEST_DESIGN and IMPLEMENTATION steps.

So the analysis step can't write files, and the planning step can't run commands. Both rules are enforced by construction.

### 4.4 Persistence, approvals and resume

```
.devflow/
├── config.yaml                 committed. Inert until trusted (see §11).
├── rules/*.md                  committed project rules
└── runs/                       added to .gitignore by `devflow init`
    └── 2026-11-06T10-21-33Z_TASK-142/
        ├── run.json            state, mode, step statuses, base commit, config hash, DevFlow version
        ├── events.jsonl        append-only state transitions
        ├── audit.jsonl         LLM calls, commands, file writes, approvals
        ├── artifacts/          task.contract.json, analysis.json, plan.json/.md, test-design.json,
        │                       traceability.json, changes.jsonl, verification/*.json, review.json
        ├── logs/               raw command output (capped and redacted)
        ├── report.json
        └── report.md
~/.devflow/
├── config.yaml                 user-level defaults (no secrets: API keys come from environment variables only)
└── trust.json                  workspace trust and approved command fingerprints
```

- Every step output is written atomically: the file is written to a temporary name and then renamed. Then the state is advanced.
- `devflow resume <run>` restarts at the first step that isn't complete. Steps are idempotent with respect to persisted artifacts: an implementation step that is resumed rereads `changes.jsonl` and doesn't apply an edit twice.
- `devflow approve <run>`, `devflow reject <run> --feedback "..."` and `devflow answer <run> --file answers.yaml` record the decision in `audit.jsonl` along with who made it (`git config user.email` or the CLI user).

---

## 5. Core schemas and interfaces (sketches)

All of these are Zod schemas in `@devflow/core`. TypeScript types are inferred from them. JSON Schema is generated from them for editor support and for LLM wire formats.

### 5.1 Engineering Task Contract

```ts
export const AcceptanceCriterion = z.object({
  id: z.string().regex(/^AC-\d+$/),
  statement: z.string().min(1),
  given: z.string().optional(),
  when: z.string().optional(),
  then: z.string().optional(),
  covers: z.array(z.string().regex(/^N?FR-\d+$/)).default([]),
  verification: z.enum(["automated", "manual"]).default("automated"),
  testLevel: z.enum(["unit", "integration", "e2e"]).optional(),
});

export const TaskContract = z.object({
  schemaVersion: z.literal(1),
  id: z.string(), // "TASK-142", "gh-142"
  title: z.string().min(1),
  description: z.string(),
  source: z.object({
    kind: z.enum(["file", "cli", "github-issue"]),
    ref: z.string().optional(),
    trust: z.enum(["user", "external"]), // external = untrusted text
  }),
  requirements: z.object({
    functional: z.array(Requirement), // { id: "FR-1", text, priority }
    nonFunctional: z.array(NonFunctionalRequirement), // { id: "NFR-1", category, text }
  }),
  acceptanceCriteria: z.array(AcceptanceCriterion),
  constraints: z.array(z.string()),
  scope: z.object({
    modules: z.array(z.string()),
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }),
  testing: z.object({
    levels: z.array(TestLevel),
    testFirst: z.boolean(),
    notes: z.string().optional(),
  }),
  definitionOfDone: z.array(z.string()),
});
```

The task _file_, which is what people write, is a more forgiving `TaskFile` schema. For example, ACs can be plain strings. A deterministic normalizer turns it into a `TaskContract`: it assigns ids, links coverage and reports precise error paths. Deterministic lint runs before any LLM call and catches:

- no acceptance criteria;
- duplicate ids;
- a `covers` reference to a requirement that doesn't exist;
- a functional requirement that no AC covers;
- an empty Definition of Done.

### 5.2 Implementation plan

```ts
export const ImplementationPlan = z.object({
  taskId: z.string(),
  summary: z.string(),
  relevantFiles: z.array(z.object({ path: RepoPath, reason: z.string() })),
  approach: z.string(),
  changes: z.array(
    z.object({
      id: z.string().regex(/^CH-\d+$/),
      module: z.string(),
      path: RepoPath,
      action: z.enum(["create", "modify", "delete"]),
      description: z.string(),
      satisfies: z.array(z.string()), // AC/FR ids
    }),
  ),
  interfaceChanges: z.array(
    z.object({
      kind: z.enum(["http-api", "public-api", "schema", "proto", "config"]),
      description: z.string(),
      breaking: z.boolean(),
    }),
  ),
  testStrategy: z.array(
    z.object({
      acId: z.string(),
      level: TestLevel,
      approach: z.string(),
      targetFile: RepoPath.optional(),
    }),
  ),
  risks: z.array(Risk),
  regressionWatch: z.array(z.string()),
  openQuestions: z.array(z.object({ question: z.string(), blocking: z.boolean() })),
});
```

Deterministic checks run on every plan:

- every automated AC has a test strategy;
- every planned path is inside the workspace, inside the task scope and not protected;
- a `modify` or `delete` targets a file that exists;
- a change outside the declared modules is flagged.

### 5.3 Execution, verification and evidence

```ts
export type ResultStatus = "passed" | "failed" | "skipped" | "not_executed" | "unverified";

export interface CommandSpec {
  // data only — adapters never execute
  id: string; // "backend:test"
  purpose: "build" | "compile" | "test" | "lint" | "typecheck" | "static-analysis";
  executable: string; // bare tool name or repo-relative wrapper (mvnw, gradlew)
  args: string[]; // argv; "{param}" placeholders become whole argv elements
  cwd: RepoPath;
  env: Record<string, string>; // additions to the scrubbed base environment
  timeoutMs: number;
  network: "none" | "required"; // declared intent; enforced in container mode
  parameters: ParamSpec[]; // e.g. { name: "testFilter", pattern: "^[\\w.$#*]+$" }
  results: { parser: string; reportGlobs: string[] };
  origin: "adapter" | "project-config" | "user";
}

export interface ExecutionRecord {
  commandId: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  truncated: boolean;
  policyDecision: { decision: "allow"; via: "trust-store" | "interactive" | "flag" };
}

export interface GateResult {
  gateId: string;
  status: ResultStatus;
  reason?: string; // required when not_executed or unverified
  execution?: ExecutionRecord; // required when passed or failed (schema invariant)
  tests: TestCaseResult[]; // { id, name, file, status, markers: ["AC-1"], baselineStatus? }
  diagnostics: Diagnostic[]; // compiler, lint and static-analysis issues
  evidence: Evidence[]; // report files with sha256, log excerpts
}
```

### 5.4 Findings

```ts
export const Finding = z
  .object({
    id: z.string(),
    title: z.string(),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    category: z.enum([
      "requirement",
      "regression",
      "test-gap",
      "convention",
      "security",
      "compatibility",
      "scope",
      "quality",
    ]),
    source: z.enum(["deterministic", "ai"]),
    verification: z.enum(["confirmed", "unverified", "refuted"]),
    confidence: z.number().min(0).max(1).optional(), // AI findings only
    evidence: z.array(Evidence),
    location: SourceLocation.optional(),
    recommendation: z.string(),
  })
  .superRefine((f, ctx) => {
    // An AI suspicion can only be "confirmed" when deterministic evidence is attached.
    if (f.source === "ai" && f.verification === "confirmed" && !f.evidence.some(isDeterministic))
      ctx.addIssue({
        code: "custom",
        message: "AI finding cannot be confirmed without deterministic evidence",
      });
  });
```

### 5.5 Ports

```ts
export interface LlmProvider {
  readonly id: string;                                        // "anthropic" | "openai" | "fake" | "replay"
  generate<T>(req: GenerateRequest<T>, signal: AbortSignal): Promise<GenerateResult<T>>;
  countTokens?(req: GenerateRequest<unknown>): Promise<number>;
}
export interface IssueSource { readonly id: string; fetch(ref: string): Promise<TaskFile>; }
export interface RunStore { create(...): Promise<RunHandle>; load(runId: string): Promise<RunSnapshot>; /* ... */ }
export interface Executor { run(spec: ResolvedCommand, signal: AbortSignal): Promise<ExecutionRecord>; }
export interface SourceParser { languages: string[]; outline(file: RepoFile, text: string): Promise<SourceOutline>; }
```

---

## 6. Task configuration specification

Task files can be YAML, JSON or Markdown. JSON Schema is published at `schemas/task.schema.json` for editor autocompletion.

```yaml
# task.yaml
schemaVersion: 1
id: TASK-142
title: Add pagination to GET /api/orders
description: |
  The orders list is unbounded and times out for large customers.
requirements:
  functional:
    - id: FR-1
      text: GET /api/orders accepts optional `page` (0-based) and `size` query parameters.
    - id: FR-2
      text: The response includes the header X-Total-Count.
  nonFunctional:
    - id: NFR-1
      category: compatibility
      text: Clients that send no pagination parameters receive the first 50 orders in the same JSON shape.
acceptanceCriteria:
  - id: AC-1
    given: 25 orders exist
    when: GET /api/orders?page=1&size=10
    then: orders 11–20 are returned and X-Total-Count is 25
    covers: [FR-1, FR-2]
  - id: AC-2
    given: any request
    when: size > 100
    then: the API returns 400 with error code PAGE_SIZE_TOO_LARGE
    covers: [FR-1]
  - "Requests without parameters behave as page=0,size=50" # string shorthand → AC-3
constraints:
  - Do not change the OrderDto JSON shape.
scope:
  modules: [backend]
testing:
  levels: [unit, integration]
  testFirst: true
definitionOfDone:
  - Every acceptance criterion has a passing automated test
  - The backend:test gate passes with no regressions
```

**Markdown tasks.** Use YAML front matter (`id`, `title`) followed by the conventional headings `## Description`, `## Requirements`, `## Acceptance Criteria` and `## Constraints`. They are parsed deterministically: checkbox lists, `AC-n:` prefixes and Given/When/Then lines are recognized. GitHub issues use the same parser.

**CLI tasks.** For example: `devflow analyze --title "..." --ac "..." --ac "..."`.

---

## 7. Project configuration and rules

```yaml
# .devflow/config.yaml — created by `devflow init`, reviewed by a human, then trusted with `devflow trust`
version: 1
modules: # optional; auto-detected when omitted
  - { id: backend, path: services/orders, adapter: java }
  - { id: web, path: apps/web, adapter: javascript }
ai:
  provider: anthropic # anthropic | openai
  models: # per-step routing; defaults are set from current provider docs at implementation time
    default: <model-id>
    implementation: <model-id>
  budgets:
    {
      maxCostUsdPerRun: 5,
      maxInputTokensPerRun: 600000,
      maxOutputTokensPerRun: 80000,
      maxCallsPerStep: 12,
    }
workflow:
  requirePlanApproval: true
  maxRepairAttempts: 2
  git: { isolation: branch, branchPrefix: devflow/, commit: per-phase } # never pushes
verification:
  baseline: auto # auto | always | never
  gates:
    - { id: backend-test, module: backend, use: test, required: true }
    - { id: backend-static, module: backend, use: static-analysis, required: false }
    - { id: web-typecheck, module: web, use: typecheck, required: true }
    - { id: web-lint, module: web, use: lint, required: false }
context:
  exclude: ["**/generated/**"]
  maxFileBytes: 524288
```

**Rules** are Markdown files with front matter in `.devflow/rules/`. A rule is guidance for the LLM and, optionally, a deterministic check:

```markdown
---
id: java-constructor-injection
appliesTo: ["services/**/*.java"]
severity: medium
check: { kind: forbid-pattern, pattern: "@Autowired\\s+(private|protected)" }
---

Use constructor injection. Field injection with @Autowired is not allowed.
```

A violation found by a `check` is a confirmed **deterministic** finding. A violation that only the AI notices for a rule without a `check` is reported as an **AI, unverified** finding.

---

## 8. Language adapter specification

### 8.1 Interface

This revises the conceptual interface from the brief. Detection, analysis, conventions, commands and result parsing are separate methods. Adapters are internally composed of strategies (see §8.2).

```ts
export interface LanguageAdapter {
  readonly id: string; // "java" | "javascript"
  readonly apiVersion: 1; // adapters declare the SDK version they target
  readonly displayName: string;

  /** Find the project roots (modules) this adapter can handle, each with confidence and evidence. Reads only. */
  detectModules(repo: RepositoryView): Promise<ModuleCandidate[]>;

  /** Build tool, languages and versions, frameworks, test frameworks, quality tools, source/test roots, dependencies. */
  analyzeModule(module: ModuleCandidate, repo: RepositoryView): Promise<ModuleProfile>;

  /** Conventions inferred from the code, with evidence, e.g. "37/40 controller tests use @WebMvcTest". */
  inferConventions(profile: ModuleProfile, repo: RepositoryView): Promise<InferredConvention[]>;

  /** The existing tests: files, suites, naming patterns, test levels. */
  discoverTests(profile: ModuleProfile, repo: RepositoryView): Promise<TestInventory>;

  /** Where and how to write a test for a given source file: location, naming, imports, AC marker convention. */
  testAuthoringGuide(profile: ModuleProfile): TestAuthoringGuide;

  /** The command catalog, as data. Resolved against the available toolchain. Never executed by the adapter. */
  commandCatalog(profile: ModuleProfile, toolchain: ToolchainProbe): CommandCatalog;

  /** Turns raw execution artifacts (JUnit XML, JSON reporters, compiler output) into normalized results. */
  parseResults(
    command: CommandSpec,
    execution: ExecutionRecord,
    repo: RepositoryView,
  ): Promise<GateResult>;

  /** Optional: symbol outline and import edges for context ranking (defaults to the shared SourceParser). */
  outline?(file: RepoFile, text: string): Promise<SourceOutline>;
}
```

**How the security boundary is enforced.**

- Adapters get a read-only `RepositoryView` that goes through PathGuard. They return `CommandSpec` data and have no way to execute anything.
- First-party adapters are tested to confirm they never import `node:child_process` or `node:fs` write APIs. A lint rule enforces the same thing.
- Third-party adapters run in the same process and are **trusted code**. They have to be listed explicitly in the config. The policy stops accidental bypasses, not malicious plugins. This is documented plainly.

### 8.2 Composition within an adapter

```ts
interface BuildToolStrategy   { id: string; detect(root, repo): Promise<Evidence | null>; commands(profile, toolchain): CommandSpec[]; }
interface FrameworkDetector   { id: string; detect(profile, repo): Promise<FrameworkDetection | null>; }
interface TestRunnerStrategy  { id: string; detect(profile, repo): Promise<Evidence | null>; command(selection: TestSelection): CommandSpec; parse(exec, repo): Promise<TestCaseResult[]>; }
interface QualityToolStrategy { id: string; detect(profile, repo): Promise<Evidence | null>; command?(...): CommandSpec; parse(exec, repo): Promise<Diagnostic[]>; }
```

`@devflow/core/testing` ships an **adapter conformance kit**: a shared test suite that every adapter must pass, including any future Python, Go or .NET adapter.

### 8.3 Java adapter (MVP)

| Concern    | Behaviour                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Detection  | `pom.xml`, `build.gradle(.kts)`, `settings.gradle(.kts)`; multi-module (Maven `<modules>`, Gradle `include`)                                                                               |
| Frameworks | Spring Boot (parent, BOM or starters), with evidence from the build file                                                                                                                   |
| Tests      | JUnit 5 (`junit-jupiter`), Mockito, AssertJ; `src/test/java`; `*Test` versus `*IT` conventions; Failsafe                                                                                   |
| Quality    | Checkstyle and SpotBugs when they are configured in the build. Their XML reports are parsed.                                                                                               |
| Toolchain  | `mvnw`/`mvnw.cmd`, then `gradlew`/`gradlew.bat`, then `mvn`/`gradle` on PATH. If none is found, the gate is `not_executed` with the reason "toolchain unavailable".                        |
| Commands   | Maven: `-B -ntp test-compile`, `test`, `-Dtest=<filter> -Dsurefire.failIfNoSpecifiedTests=false`, `verify`. Gradle: `compileTestJava`, `test --tests <filter>`, `check`, `--console=plain` |
| Results    | `target/surefire-reports/TEST-*.xml`, `target/failsafe-reports`, `build/test-results/**/*.xml`, `checkstyle-result.xml`, `spotbugsXml.xml`                                                 |
| AC markers | Surefire reports **method names**, not `@DisplayName`, by default. So the marker goes in the method name (`ac1_returnsSecondPage`) and the `@DisplayName` is kept as well.                 |

### 8.4 JavaScript/TypeScript adapter (MVP)

| Concern         | Behaviour                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detection       | `package.json`; workspaces (`pnpm-workspace.yaml`, the `workspaces` field); `tsconfig*.json`                                                                                                                                                              |
| Package manager | The `packageManager` field, then the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`)                                                                                                                                                        |
| Frameworks      | Express, NestJS (`@nestjs/core`), React, Next.js, Vite. Each detection carries dependency evidence.                                                                                                                                                       |
| Tests           | Vitest (`vitest run --reporter=json --outputFile=…`), Jest (`--ci --json --outputFile=…`), Playwright (`--reporter=json`, only when it is configured and the gate is enabled)                                                                             |
| Quality         | ESLint (`-f json -o …`), `tsc --noEmit -p …` (diagnostics parsed)                                                                                                                                                                                         |
| Invocation      | Through the package manager's exec, without installing anything (`pnpm exec`, `npx --no-install`, `yarn`). If `node_modules` is missing, the gate is `not_executed` with the reason "dependencies not installed". DevFlow never runs installs on its own. |
| Scripts         | A gate can point at an npm script. If DevFlow can't attach a machine-readable reporter, results are judged by exit code only and test-level status is `unverified`.                                                                                       |
| AC markers      | `[AC-1]` in the test title. It appears in the Jest and Vitest JSON output.                                                                                                                                                                                |

---

## 9. Engineering context engine

1. **Discover.** Run `git ls-files -co --exclude-standard -z`. If the directory isn't a git repository, walk it with `ignore` rules instead. Always exclude `.git`, `node_modules`, `target`, `build`, `dist`, `.devflow/runs`, binary files (sniffed for NUL bytes) and files larger than `maxFileBytes`.
2. **Classify.** Language, the role of each file (source, test, config, docs, generated) and its module.
3. **Filter sensitive content.** Files on the path denylist are never read for the LLM. Content is scanned for secrets and redacted (see §11.5).
4. **Detect modules.** Each adapter runs `detectModules`, and files are mapped to modules.
5. **Load instructions.** `AGENTS.md` and `CLAUDE.md` from the root and the ancestors of relevant files (the nearest one wins), `.devflow/rules/**`, and `README.md` (truncated). Each instruction is tagged with its source and trust level.
6. **Rank files for the task.** This uses BM25 over path tokens, symbol outlines and content, then applies boosts:
   - identifiers quoted in the task (exact matches);
   - task scope paths;
   - test and source pairing;
   - 1-hop import neighbours of the top results;
   - optionally, recent git churn.

   Ranking is **explainable**: each file carries its reasons, e.g. "matched `OrderController` from AC-1".

7. **Pack.** Each step has a token budget. The top files are included in full, the next tier as outlines (signatures only), and the rest of the module as a list of paths.

The model can fetch more through **read-only tools**: `read_file`, `search_text`, `list_files` and `get_outline`. Every call goes through PathGuard and redaction, counts against the budget, and is capped per step.

### 9.1 Instruction precedence

| Rank | Source                                                                                      | Can shape the code | Can grant permissions      |
| ---- | ------------------------------------------------------------------------------------------- | ------------------ | -------------------------- |
| 1    | DevFlow safety policy (built in)                                                            | n/a                | Cannot be overridden       |
| 2    | The user's invocation: CLI flags, interactive answers, `~/.devflow`                         | Yes                | Yes                        |
| 3    | Task contract (_what_ to build). An external source such as a GitHub issue stays untrusted. | Yes                | No                         |
| 4    | `.devflow/config.yaml` and `.devflow/rules/` (explicit project rules)                       | Yes                | Only after `devflow trust` |
| 5    | `AGENTS.md` / `CLAUDE.md` (nearest file first)                                              | Yes                | No                         |
| 6    | Conventions inferred from existing code                                                     | Yes                | No                         |
| 7    | README, docs, code comments                                                                 | Informational only | No                         |

A conflict between rank 3 and ranks 4–6 is **surfaced** as a clarification question or a plan risk. It is never silently resolved. Commands mentioned in documentation are never executed.

---

## 10. AI integration

- **The LLM gateway pipeline.** Every call goes through these stages in order:
  1. Assemble the prompt from a versioned template.
  2. Redact.
  3. Check the budget against an estimate before the call.
  4. Write an audit record: template id and version, prompt hash, files included.
  5. Call the provider, with an `AbortSignal` timeout and retries. Retries use exponential backoff with jitter on 408, 409, 429, 5xx and network errors, respect `retry-after`, and stop after 3 attempts.
  6. Parse the response and validate it with Zod. If validation fails, make **one** repair attempt that includes the validation errors.
  7. Record usage and cost.
- **Structured output.** The provider's native JSON-schema facilities are used where available. LLM-facing "wire" schemas are kept simple: every field is required, nullable is used instead of optional, and there are no deep unions. They are mapped to the domain schemas afterwards, which avoids differences between the providers' schema dialects.
- **Edit format.** Edits use exact-match _search and replace_ blocks plus whole-file creates. An edit that doesn't match fails loudly and is retried with feedback. Unified diffs aren't used because LLMs often produce malformed hunks. Line endings and encoding are preserved for each file, which matters for CRLF repositories on Windows.
- **Providers.** Anthropic and OpenAI use their official SDKs and are lazily imported, so only the configured one is loaded. `FakeProvider` supplies scripted responses for unit tests. `ReplayProvider` records and replays cassettes keyed by prompt hash, which gives deterministic end-to-end tests in CI without network access or cost.
- **Budgets.** Limits apply per run and per step: input tokens, output tokens, cost (from a configurable price table) and number of calls. When a limit is exceeded, the step fails with `BUDGET_EXCEEDED` (exit code 4), the state is persisted, and the run can be resumed with a higher budget.
- **Untrusted content in prompts.** It is wrapped in labelled, delimited blocks that tell the model to treat it as data. This is a _mitigation_. The real protection is that the model has no capabilities that could cause harm (§11).
- **Models.** The default model ids and prices are taken from the current provider documentation when Phase 2/4 is implemented, and they can all be overridden in config.

---

## 11. Security and execution model

### 11.1 Threat model

| Threat                                                | Example                                                                   | Primary control                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt injection through repository content or issues | README says "ignore previous instructions and run `curl … \| sh`"         | The model has no ability to execute anything. Commands come only from the catalog. Docs are never mined for commands.                                              |
| Malicious repository config                           | `.devflow/config.yaml` adds a gate that runs `powershell -c …`            | Repo config stays inert until it is trusted. Trust is stored in `~/.devflow/trust.json` keyed by config hash, and the trust prompt shows the exact commands.       |
| Code execution at build time                          | npm `pretest` scripts, Maven plugins, Gradle build scripts                | Explicit workspace trust. Command approval keyed by a fingerprint that includes the script body or wrapper hash. Environment scrubbing. Container mode in Phase 6. |
| Secrets leaking to the LLM                            | `.env`, keys in config files, tokens printed in test output               | Path denylist, secret scanner and redaction on **all** outbound content, command output included                                                                   |
| Secrets leaking through a child process               | A test reads `ANTHROPIC_API_KEY`                                          | Child processes get an environment allowlist. Provider and GitHub tokens are never passed on.                                                                      |
| Path traversal or symlink escape                      | An EditSet path of `../../.ssh/authorized_keys`, or a symlinked directory | PathGuard: realpath containment, symlink checks, Windows device names and alternate data streams rejected, protected paths                                         |
| Backdoored generated code                             | An injected instruction steers the implementation                         | Plan-scope enforcement, out-of-plan edits rejected, diff shown, human review required. DevFlow never pushes or merges on its own.                                  |
| Runaway processes or cost                             | An infinite test loop, token blow-up                                      | Timeouts, process-tree kill, output caps, budgets                                                                                                                  |
| Overwriting user work                                 | The developer edits files during a run                                    | Clean-tree precondition, dedicated branch, content-hash check before each write                                                                                    |
| Abuse of CI tokens (Phase 5)                          | `pull_request_target` checking out fork code that has access to secrets   | Documented secure workflow split and least-privilege permissions                                                                                                   |

### 11.2 How command policy makes a decision

1. **Structural validation.** The `CommandSpec` must match its schema, the cwd must be inside the root, and the executable must be a bare tool name or a known repo-relative wrapper.
2. **Hard deny list (cannot be overridden).** Shells used as executables (`sh`, `bash`, `cmd`, `powershell`, `pwsh`), network tools (`curl`, `wget`), `git push`, `git reset --hard`, `npm publish`, `rm`, `sudo` and similar.
3. **Trust store.** If the command fingerprint is already trusted, it is **allowed**. The fingerprint covers the executable, the argument template, the cwd, and the underlying script body or wrapper hash, so if `package.json` changes the `test` script, approval is needed again.
4. **Otherwise.** In a terminal, DevFlow asks for approval interactively and shows the argv, the cwd and the script body. In CI, the command must be pre-approved with an explicit allowlist flag. Without approval the command is denied, and the gate is reported as `not_executed` with the reason "approval required". It is never silently passed.

**DevFlow's own git calls** are fixed internal operations. They run with `-c core.fsmonitor=false`, `--no-ext-diff` and `--no-textconv`. Commits on the DevFlow branch run with hooks disabled by default, because hooks would be unapproved code execution. Verification gates take their place, and this can be changed in config.

### 11.3 Executor

- Uses `cross-spawn` with argv and no shell. It handles Windows `.cmd` shims (`mvnw.cmd`, `npm.cmd`) safely.
- **Environment allowlist:** `PATH`, `HOME`/`USERPROFILE`, `JAVA_HOME`, `TEMP`/`TMP`, `LANG`, `SystemRoot`, `ComSpec`, `PATHEXT`, plus the additions declared in the config. Anything matching `*_TOKEN`, `*_KEY`, `*_SECRET` or `*PASSWORD*` is always stripped.
- Each command has a timeout. On expiry the whole process tree is killed: `taskkill /T /F` on Windows, the process group on POSIX.
- Output is capped (5 MB by default, keeping the tail), streamed to `logs/`, and redacted before it reaches the LLM or a report.
- Commands run one at a time in the MVP. An `ExecutionBackend` seam allows a `container` backend in Phase 6 (`--network none`, CPU and memory limits).

### 11.4 PathGuard

- The root is the realpath of the workspace. Every path is normalized and resolved: the realpath of the file if it exists, otherwise the realpath of its parent. It must stay inside the root.
- These are rejected: absolute paths coming from the LLM, `..` escapes, NUL bytes, Windows device names (`CON`, `NUL`, …), and alternate data streams (`a.txt:s`). Comparisons are case-insensitive on Windows.
- **Write-protected by default:**
  - `.git/**` and `.devflow/config.yaml`, `.devflow/rules/**`;
  - `.github/workflows/**`, lockfiles, and the wrapper files (`mvnw*`, `gradlew*`, `gradle/wrapper/**`);
  - `.env*` and anything on the secret denylist.

  A plan the user has confirmed can unlock a specific protected path.

- **Never read for the LLM:** `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`, `*.jks`, `.npmrc`, `.netrc`, `credentials*`, `*.tfstate`, …

### 11.5 Detecting and redacting secrets

- There is a built-in set of detectors:
  - known token prefixes for cloud providers, GitHub, Slack, Anthropic and OpenAI;
  - private-key headers;
  - JWTs;
  - connection strings that contain passwords;
  - generic `password`/`secret`/`token`/`api_key` assignments that pass an entropy threshold.
- If `gitleaks` is installed, it can be added as an optional extra detector.
- Redacted values are replaced with `«REDACTED:github-pat:3f2a»`, where the suffix is a short hash of the value. Repeated occurrences can then be correlated without disclosing anything.
- Redaction applies to LLM requests, logs, the audit trail, reports and (in Phase 5) PR comments. The audit trail records each redaction's location and type, never the value.

### 11.6 Audit log

`audit.jsonl` records the following, all redacted:

- **Every LLM call:** provider, model, template id and version, prompt hash, files included, tokens and cost.
- **Every command:** argv, cwd, policy decision and who approved it, exit code, duration.
- **Every file write:** path, hashes before and after, plan change id.
- **Every approval, rejection and clarification answer.**

### 11.7 Residual risks (stated honestly)

- **Local mode can't limit the network or memory use of child processes.** Running a project's build _is_ running its code. DevFlow makes that explicit, approved, time-bounded and scrubbed of secrets. It can't make an untrusted build safe. Container mode (Phase 6) narrows this gap.
- **Redaction is heuristic.** Novel secret formats can slip through.
- **Prompt injection can still influence the _content_ of generated code.** That's why diff review by a human is a required control, and why DevFlow never pushes or merges on its own.

---

## 12. The verification, traceability and regression model

**What each status means.** Schema invariants and tests enforce these meanings.

| Status         | Meaning                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`       | Executed, and the result was parsed as a success. **This requires an `ExecutionRecord` and parsed evidence.**                                              |
| `failed`       | Executed, and failures were detected.                                                                                                                      |
| `skipped`      | Executed, and the tool reported a skip (for example `@Disabled`).                                                                                          |
| `not_executed` | Not run: toolchain missing, approval denied, budget exhausted, or an upstream step failed. A reason is required.                                           |
| `unverified`   | Executed but the outcome couldn't be determined (timeout, unparseable output), or there is no executable evidence at all (for example an AC with no test). |

Aggregate statuses are never upgraded. A gate passes only if all of its required parts passed. An AC is `verified` only when it has at least one linked test, and every linked test was **executed in this run** and passed.

**The traceability chain** is: Requirement → AC → test scenario → test case (file and id) → test result → evidence (command, exit code, report-file hash, log excerpt).

- The main link is DevFlow's `traceability.json` manifest, written when DevFlow generates a test.
- A durable link is also kept in the test itself as an adapter-specific marker, so it survives later reruns. See §8.3 and §8.4.

**Red/green evidence.** Every generated test is run against the baseline before implementation, where it should fail ("red"), and again afterwards, where it should pass ("green"). A generated test that already passes on the baseline produces the finding `TEST_PASSES_BEFORE_CHANGE`: the test may not exercise the new behaviour. The exception is ACs explicitly marked as regression or characterization tests. The report never treats a passing generated test as proof of business correctness. Test-fidelity review findings are AI findings, labelled as such.

**Detecting regressions.**

- Baseline gates run on the base commit and cover the affected modules by default.
- A **regression** is a test that passed on the baseline and fails afterwards. It is reported as a _deterministic, confirmed_ finding.
- Tests that were already failing are listed separately and aren't attributed to the change.
- Failing tests are rerun once to guard against flakiness. If the results are inconsistent, the test is marked `flaky` and the finding stays `unverified`.

**The review engine.** Deterministic checks are run first:

- gates and rule `check`s;
- AC coverage;
- source that changed without a matching test change;
- edits outside the plan;
- protected files touched;
- new dependencies added;
- heuristics for public API and contract changes.

AI review then compares the diff against the requirements, conventions and patterns. Its findings carry a confidence score and stay `unverified`.

---

## 13. Contract intelligence (design only; implemented in Phase 6)

```ts
interface ContractAnalyzer {
  id: "openapi" | "protobuf" | string;
  detect(repo: RepositoryView): Promise<ContractFile[]>;
  parse(file: ContractFile, repo: RepositoryView): Promise<ContractModel>;
  diff(base: ContractModel, head: ContractModel, tools: ToolchainProbe): Promise<ContractChange[]>;
  // ContractChange.compatibility: "breaking" | "non-breaking" | "unknown"
  // ContractChange.decidedBy: "tool:oasdiff" | "tool:buf" | "builtin-rules" | "unknown"
  findConsumers(
    change: ContractChange,
    repo: RepositoryView,
    modules: ModuleProfile[],
  ): Promise<ConsumerRef[]>;
}
```

- **OpenAPI.** Parse the spec and resolve `$ref`s. Use `oasdiff` if it is installed. Otherwise fall back to a documented subset of built-in rules: removed operations or fields, a new required request field, type changes. Consumers are found from Spring `@*Mapping` paths, TypeScript client calls (path templates and generated operation ids) and tests.
- **Protobuf.** Use `buf breaking` if it is installed. Otherwise parse with `protobufjs` and apply built-in rules: reused field numbers, type changes, fields removed without `reserved`, removed enum values. Consumers are found from imports of generated code.
- **What the LLM may do:** explain the impact and propose updates for consumers. **It never decides compatibility.**

---

## 14. GitHub integration (design only; implemented in Phase 5)

- **Issues.** `IssueSource` is implemented over the REST API. Issue bodies are parsed with the Markdown task parser (§6) and marked `trust: external`. The command is `devflow run --issue 142`; the repository is inferred from the git remote.
- **Reviewing PRs.** `devflow review --pr 57` reviews the PR diff. Results are published as a PR comment or check-run summary only with an explicit `--publish` flag.
- **Preparing PRs.** `devflow pr create` requires an explicit flag _and_ confirmation. It pushes only the DevFlow branch and opens a **draft** PR with the report. It never merges and never force-pushes.
- **The GitHub Action** is documented with two secure workflows:
  - `pull_request` is safe for forks and has no secrets. It runs deterministic verification and uploads the report as an artifact.
  - AI review runs only for PRs from the same repository, or when a maintainer triggers it (by label or `workflow_dispatch`). It **never** uses `pull_request_target` together with a checkout of the PR head.

  Permissions are `contents: read`, plus `pull-requests: write` and `checks: write` only when publishing.

- **Tokens** are read from the environment, stripped from child processes and redacted everywhere.

---

## 15. Technology decision records (index)

| ADR  | Decision                                                                                        | Alternatives considered                                        | Rationale                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0001 | TypeScript, Node ≥ 22, ESM-only                                                                 | Node 20 (end of life 2026-04), dual CJS/ESM                    | Supported LTS lines; ESM-only keeps tooling simple                                                                     |
| 0002 | pnpm workspaces and `tsc -b` project references                                                 | Nx, Turborepo, Lerna                                           | Seven packages don't need a task-graph tool, and it means fewer dependencies                                           |
| 0003 | 7 MVP packages plus 2 later                                                                     | One package per engine (12+)                                   | Engines share types and lifecycle. Packages are split only where consumers or dependencies differ.                     |
| 0004 | Hand-written typed state machine and a file-based run store                                     | XState, Temporal, SQLite                                       | The transition table is small and explicit, artifacts are human-readable, runs can resume without extra infrastructure |
| 0005 | One tool-using LLM call loop per step, with read-only tools only                                | Multi-agent crews                                              | Fewer failure modes, auditable, cheaper. There is no measured benefit from more agents yet.                            |
| 0006 | LLM output is validated data, commands come only from the catalog, edits are search and replace | Free-form shell commands, unified diffs                        | Security and reliability: edits that don't match fail loudly                                                           |
| 0007 | Workspace trust is stored outside the repository                                                | Trust declared in the repo config                              | Repository content is untrusted, so trust has to belong to the user                                                    |
| 0008 | BM25 plus structural ranking, no embeddings                                                     | A vector DB or embedding API                                   | Local-first, deterministic and explainable. Embeddings can be added later as a plugin.                                 |
| 0009 | `web-tree-sitter` (WASM) behind `SourceParser`, with a regex fallback                           | TypeScript compiler API plus `java-parser`, native tree-sitter | One parsing approach for every language, and no native builds (important on Windows)                                   |
| 0010 | Official Anthropic and OpenAI SDKs, lazily loaded behind `LlmProvider`                          | Raw `fetch`, LangChain, Vercel AI SDK                          | Maintained retries, types and streaming, without lock-in to a framework                                                |
| 0011 | Zod 4 as the single source of truth, with JSON Schema generated from it                         | Hand-written JSON Schema, TypeBox                              | Runtime validation, types and JSON Schema from one definition                                                          |
| 0012 | A dedicated local branch with a commit per phase by default; worktrees are opt-in               | Always use a worktree                                          | A worktree lacks installed dependencies (`node_modules`), which would force an install and network access              |
| 0013 | The JSON report is the source of truth and Markdown is rendered from it                         | Markdown only                                                  | Machine-readable, diffable, reproducible                                                                               |

**Runtime dependency budget for the MVP:**

| Purpose            | Packages                                               |
| ------------------ | ------------------------------------------------------ |
| Schemas and config | `zod`, `yaml`                                          |
| CLI                | `commander`, `picocolors`, `@clack/prompts`            |
| Processes          | `cross-spawn`                                          |
| Files              | `tinyglobby`, `ignore`                                 |
| Reports            | `fast-xml-parser` (JUnit, Checkstyle and SpotBugs XML) |
| LLM providers      | `@anthropic-ai/sdk`, `openai`                          |
| Parsing            | `web-tree-sitter` and grammars                         |
| Later              | `@octokit/rest` (Phase 5)                              |

Development uses `typescript`, `vitest`, `eslint`, `typescript-eslint`, `prettier` and `@types/node`. Exact versions are pinned in Phase 1 from the registry.

---

## 16. MVP scope

**The MVP (v0.1) is Phases 1–4.**

| Area              | Included                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI commands      | `init`, `trust`, `task validate`, `analyze`, `plan`, `approve`/`reject`/`answer`, `resume`, `status`, `verify`, `test`, `implement`, `review` (local diff), `run --task`, `report` |
| Modes             | assist, test, implement, review                                                                                                                                                    |
| Task sources      | YAML, JSON and Markdown files; CLI flags                                                                                                                                           |
| Java              | Maven and Gradle (single and multi-module); detection of Spring Boot, JUnit 5 and Mockito; Checkstyle and SpotBugs results when configured                                         |
| JS/TS             | npm, pnpm and yarn; detection of Express, NestJS, React, Next.js and Vite; Jest, Vitest, ESLint and tsc; Playwright run only if configured                                         |
| Monorepos         | Multi-module and multi-language detection, gates per module, impact at module level                                                                                                |
| AI                | Anthropic, OpenAI, Fake and Replay providers; budgets and cost tracking                                                                                                            |
| Security          | Local execution mode with the full policy stack (§11)                                                                                                                              |
| Reports           | JSON and Markdown, with the AC traceability matrix and red/green evidence                                                                                                          |
| Examples and docs | Three example repositories, architecture docs, ADRs, specs, contributor guide, example reports produced by real runs                                                               |

**Not in the MVP.** These won't be claimed as implemented until they exist:

- GitHub (Phase 5);
- OpenAPI/Protobuf intelligence and cross-language contract impact (Phase 6);
- the container sandbox (Phase 6);
- generating new e2e or Playwright tests;
- Jira and Linear;
- the IDE extension;
- embeddings;
- Python, Go and .NET adapters (only the extension points exist);
- automatic dependency installs;
- auto-merge, which will never be built.

---

## 17. Implementation risks

| #   | Risk                                                                                             | Likelihood / impact | Mitigation                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Generated code varies in quality (doesn't compile, misses the intent)                            | High / High         | Small scoped edits, exact-match edit format, compile-first repair loop with N attempts, plan approval, mandatory review of the diff |
| R2  | Building or testing an unfamiliar repository runs arbitrary code                                 | High / High         | Workspace trust, command fingerprints, environment scrubbing, container backend (Phase 6). Documented plainly as residual risk.     |
| R3  | Prompt injection steers the content of generated code                                            | Medium / High       | Capability restriction, scope enforcement, detection of out-of-plan edits, human review                                             |
| R4  | Windows semantics: `.cmd` shims, killing process trees, CRLF, case-insensitive paths, long paths | High / Medium       | `cross-spawn`; development happens on this Windows machine; a Windows leg in CI; edits that preserve line endings                   |
| R5  | Test outputs differ between tool versions and reporters, and multi-module aggregation varies     | Medium / Medium     | Parser fixtures captured from real tool output; fall back to `unverified` rather than guessing                                      |
| R6  | Java toolchain is missing locally, and wrappers need network access                              | High / Medium       | Decision D5; `setup-java` in CI; precise `not_executed` reasons                                                                     |
| R7  | Context retrieval quality on large repositories without embeddings                               | Medium / Medium     | Explainable ranking, read-only fetch tools for the model, ranking-evaluation fixtures, an embedding plugin later                    |
| R8  | Providers differ in structured output, and their APIs drift                                      | Medium / Medium     | Simple wire schemas, validation after the call, one repair attempt, replay tests, isolated provider modules                         |
| R9  | Cost overruns                                                                                    | Medium / Medium     | Budgets enforced before each call, caps per step, cost shown in the report                                                          |
| R10 | Generated tests that pass trivially or test nothing                                              | Medium / High       | Red/green evidence, the `TEST_PASSES_BEFORE_CHANGE` finding, fidelity review labelled as AI and unverified                          |
| R11 | tree-sitter WASM or grammar ABI mismatches                                                       | Medium / Low        | An early spike in Phase 3, pinned versions, regex fallback                                                                          |
| R12 | Scope creep across 18 deliverables                                                               | High / Medium       | Phase gates, and a "not yet implemented" list kept in the README                                                                    |
| R13 | A task needs new dependencies                                                                    | Medium / Medium     | Adding a dependency is a planned and approved change. DevFlow edits the manifest but never installs without approval.               |

---

## 18. Roadmap and step-by-step plan

Each phase ends with a report covering:

- what was implemented;
- the files created or modified;
- the tests executed;
- which checks passed or failed;
- what remains incomplete;
- the recommended next steps.

### Phase 1: Architecture and foundation

1. `git init`, plus `.gitignore`, `.gitattributes` (LF normalization), `.editorconfig`, LICENSE, SECURITY.md and a README skeleton.
2. Root tooling:
   - a pnpm workspace;
   - `tsconfig.base.json` with `strict`, `NodeNext`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
   - project references;
   - an ESLint flat config (typescript-eslint, strict and type-checked) with import-boundary rules;
   - Prettier and a Vitest workspace;
   - root scripts `build`, `typecheck`, `lint`, `format:check` and `test`.
3. Package skeletons for `core`, `context`, `ai`, `adapter-java`, `adapter-javascript`, `workflow` and `cli`, with tests that check package boundaries.
4. `@devflow/core` schemas: `TaskFile` with its normalizer to `TaskContract`, `ProjectConfig`, `ModuleProfile`, `CommandSpec`, `ExecutionRecord`, `GateResult`, `Finding`, `ImplementationPlan` and `EngineeringReport`. Also the `DevflowError` model with stable codes, and the port interfaces.
5. A task loader for YAML, JSON and Markdown, and deterministic task lint with precise error paths.
6. JSON Schema generated into `schemas/`. CI checks that it doesn't drift from the Zod definitions.
7. A minimal CLI: `devflow --version` and `devflow task validate <file>`.
8. Documentation: architecture overview, ADRs 0001–0013, the task and config specs, a draft adapter spec, the security model.
9. A CI workflow for ubuntu and windows on Node 22 and 24. It is validated locally with the same scripts and only runs on GitHub once the repository is pushed.

**Exit criteria:**

- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` passes locally on Windows;
- every schema has positive and negative tests;
- the example tasks validate;
- `task validate` reports precise errors on invalid files.

### Phase 2: Core workflow (assist mode working end to end)

1. Security primitives: PathGuard, SecretScanner and Redactor, CommandPolicy, TrustStore, Executor, AuditLog and Logger. They come with a security test suite covering:
   - traversal and symlinks;
   - Windows device names and alternate data streams;
   - arguments shaped like injection attempts;
   - a corpus of secrets to redact.
2. Context engine: discovery, classification, filtering of sensitive content, loading instructions in precedence order, ranking and packing.
3. Workflow engine: transition table, mode profiles, step runner, run store, events, approvals and rejection with feedback, clarification answers, resume, cancellation, budget errors.
4. AI: the `LlmProvider` port, the LLM gateway, the Fake and Replay providers, and the **Anthropic provider** (moved earlier than in the brief; see D2).
5. Steps: context loading, requirements analysis (deterministic lint plus the LLM), planning (with deterministic plan checks), and the report generator.
6. CLI: `init` (detects the project and writes the config, rule templates and gitignore entry), `trust`, `analyze`, `plan`, `approve`, `reject`, `answer`, `resume`, `status` and `report`.

**Exit criteria:**

- End-to-end tests with the Replay provider cover the happy path, the clarification loop, rejecting and redoing a plan, an exceeded budget, and resuming after a simulated crash.
- A fixture repository containing prompt injection proves that nothing gets executed.
- One live smoke test runs against Anthropic. It needs an API key and is reported as `not_executed` if the key is missing.

### Phase 3: Language adapters and verification

1. Finalize the adapter SDK: `defineAdapter`, the strategy interfaces, `AdapterRegistry`, and the conformance kit.
2. Java adapter: Maven and Gradle (Groovy and Kotlin DSL, multi-module), wrapper resolution, detection with evidence, test inventory, the command catalog, and XML parsers for Surefire, Failsafe, Gradle, Checkstyle and SpotBugs.
3. JS/TS adapter: detection of the package manager and workspaces, frameworks and tools; the command catalog with JSON reporters; parsers.
4. A `SourceParser` spike using tree-sitter (Java, TS/TSX, JS) for outlines and import edges, with a regex fallback. It feeds into ranking.
5. Verification engine: resolving gates from the config and the catalog, execution gated by policy, baseline snapshots, the status invariants, and the `devflow verify` command.
6. Example repositories: `java-spring-boot`, a Gradle fixture, `nodejs-express`, and `fullstack-monorepo`.
7. Integration tests that run real builds against the examples. When a toolchain is absent, they are skipped and the reason is stated explicitly.

**Exit criteria:**

- the detection fixtures pass;
- `devflow verify` gives correct pass and fail results on every example;
- a deliberately broken test produces `failed` with the correct test ids;
- the `not_executed` paths (missing toolchain, denied approval) are tested.

### Phase 4: AI implementation workflow (completes the MVP)

1. The OpenAI provider, the price table and cost tracking, and per-step model routing.
2. Requirements analysis: edge cases, contradictions, dependencies, and the clarification loop.
3. Test engineering: deriving scenarios from ACs, generating tests from the adapter's authoring guide, markers and the traceability manifest, the red run on the baseline, and fidelity review.
4. Implementation engine: creating the branch, the clean-tree guard, generating EditSets with read-only tools, validation (scope, protected paths, content hash), applying edits, and committing per phase.
5. Verification and the bounded repair loop; regression detection against the baseline; the flakiness guard.
6. Review engine: deterministic checks, rule checks, and AI findings with their verification status. `devflow review` works on any local diff.
7. The `test`, `implement` and `run` commands, with recovery from interruption at every state.
8. Example engineering reports produced by **real** runs against the example repositories, committed to `docs/examples/reports/`.

**Exit criteria:**

- a scripted task runs end to end on each example with the Replay provider, deterministically in CI;
- at least one documented live run exists;
- the report invariants hold: nothing is `passed` without execution evidence.

### Phase 5: GitHub integration

- Issue source and `run --issue`;
- the PR diff source and `review --pr`;
- publishing comments and check runs behind an opt-in flag;
- preparing draft PRs with explicit authorization;
- the GitHub Action, with documented secure workflows;
- tests that use recorded API fixtures.

### Phase 6: Advanced features

- Contract intelligence for OpenAPI and Protobuf, including `oasdiff` and `buf` integration and consumer mapping.
- Change-impact analysis across languages.
- The container execution backend.
- Plugin loading for external adapters and API versioning.
- A Python adapter, built to validate the SDK.
- Observability (optional export compatible with OpenTelemetry).
- Evidence-seeking review: the AI proposes a failing test to confirm a defect it suspects.

---

## 19. Decisions requested

If you approve the design as it stands, the **recommended** option below is used for each decision.

| #   | Decision                                   | Recommended                                                                                                                                                                                                                                                   | Alternative                                                                                                                            |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Package structure                          | 7 MVP packages, plus `github` and `contracts` later (§3)                                                                                                                                                                                                      | The fine-grained 12+ package layout from the brief                                                                                     |
| D2  | Phase order                                | Move the provider abstraction, Anthropic, Fake and Replay into Phase 2 so `analyze` and `plan` work end to end early. OpenAI stays in Phase 4.                                                                                                                | Keep all AI work in Phase 4. Phase 2 planning would then be exercised only with the Fake provider.                                     |
| D3  | npm scope                                  | Use `@devflow/*` in code now and confirm or claim the npm org before the first publish (renaming is mechanical). The CLI binary is `devflow` either way.                                                                                                      | `@devflow-ai/*`                                                                                                                        |
| D4  | License                                    | Apache-2.0, which includes an explicit patent grant and is common for frameworks                                                                                                                                                                              | MIT                                                                                                                                    |
| D5  | Java toolchain for local integration tests | Use the official `maven` and `gradle` Docker images **once** to generate the wrapper scripts for the example repos. The wrappers then download Maven or Gradle and dependencies from Maven Central. This needs network access and roughly 0.5–1 GB of images. | (b) You install Maven and Gradle on the host. (c) Java integration tests run in CI only, and local runs report them as `not_executed`. |
| D6  | Git isolation                              | A dedicated local `devflow/<task>` branch with local commits per phase (tests, then implementation, then repairs). It never pushes. Worktrees are opt-in.                                                                                                     | Worktree by default                                                                                                                    |
| D7  | Minimum Node version                       | `>=22` (Node 20 reached end of life in April 2026)                                                                                                                                                                                                            | `>=20`                                                                                                                                 |
