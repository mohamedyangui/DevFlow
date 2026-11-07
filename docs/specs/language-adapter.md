# Specification: language adapters (draft)

- **Status:** Draft. The `LanguageAdapter` port (API version 1), `RepositoryView`,
  `ToolchainProbe` and the data schemas (`ModuleCandidate`, `ModuleProfile`,
  `ContractRelation`, `InferredConvention`, `TestInventory`, `TestAuthoringGuide`,
  `CommandSpec`, `ParsedCommandResults`) exist in `@devflow/core` (Phase 1). The adapter SDK
  helpers, registry, conformance kit, and the Java and JavaScript/TypeScript adapters arrive
  in Phase 3. The interface may still change before Phase 3 completes.

## 1. Role

An adapter teaches DevFlow about one language ecosystem: how to recognize a project, which
build and test tools it uses, where tests live and how to write a new one, which commands
build and test it, and how to read the results. The workflow is language-agnostic; it only
talks to adapters through this interface. The same CLI and SDK serve Java and
JavaScript/TypeScript projects, and a mixed monorepo simply has modules from several adapters.

## 2. Rules every adapter follows

1. **No side effects.** Adapters read files only through `RepositoryView` and never write
   files, start processes or access the network. ESLint enforces this for the built-in adapters
   (no `node:fs`, `node:child_process` or network imports).
2. **Commands are data.** `commandCatalog()` returns `CommandSpec` objects; only the
   policy-gated executor runs them ([ADR 0006](../adr/0006-llm-output-is-data.md)).
3. **Evidence for every claim.** Every detection carries evidence (a file, a line, an excerpt)
   so a person can check why DevFlow believes a project uses Spring Boot or Vitest.
4. **Never guess results.** `parseResults()` returns `parse: "unparseable"` when it cannot read
   the output, which leads to an `unverified` status rather than a pass.
5. **Validated output.** Everything an adapter returns is validated against the core schemas
   before use.

## 3. Interface

```ts
interface LanguageAdapter {
  readonly id: string; // "java", "javascript"
  readonly displayName: string;
  readonly apiVersion: 1;
  detectModules(repo): Promise<ModuleCandidate[]>;
  analyzeModule(candidate, repo): Promise<ModuleProfile>;
  inferConventions(profile, repo): Promise<InferredConvention[]>;
  discoverTests(profile, repo): Promise<TestInventory>;
  testAuthoringGuide(profile): TestAuthoringGuide;
  commandCatalog(profile, toolchain: ToolchainProbe, repo): Promise<CommandSpec[]>;
  parseResults(command, execution: ExecutionRecord, repo): Promise<ParsedCommandResults>;
}
```

`RepositoryView` offers `exists`, `readText` (with a byte limit), `list` and `glob`, all
relative to the repository root. `ToolchainProbe.probe(tool)` reports whether a tool is
available and its version, without letting the adapter run anything.

## 4. `ModuleProfile`

| Field                                                               | Content                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moduleId`, `adapterId`, `root`                                     | identity and location                                                                                                                                                                     |
| `languages[]`, `frameworks[]`, `testFrameworks[]`, `qualityTools[]` | `Detection` objects: id, optional version, confidence 0–1, evidence                                                                                                                       |
| `buildTool`                                                         | a `Detection`, plus the wrapper path when one exists (`mvnw`, `gradlew`)                                                                                                                  |
| `sourceRoots[]`, `testRoots[]`                                      | repository-relative paths                                                                                                                                                                 |
| `contracts[]`                                                       | `ContractRelation` objects: Protobuf or OpenAPI file, role (`defines`, `generates-code-from`, `consumes-generated-code`) and evidence ([ADR 0017](../adr/0017-contract-aware-context.md)) |

## 5. Commands

`CommandSpec` fields: `id`, `purpose` (`build`, `compile`, `test`, `lint`, `typecheck`,
`static-analysis`, `format-check`), `executable` (a bare tool name or `./wrapper`), `args`,
`cwd`, `env`, `timeoutMs`, `network` (`none` or `required`), `parameters`, `results`
(`parser`, `reportGlobs`), `origin`.

- A parameter placeholder (`{testFilter}`) must be a whole argument and must be declared with
  an anchored regular expression and a maximum length.
- `env` may not add variables whose names look like credentials (`*TOKEN*`, `*SECRET*`,
  `*PASSWORD*`, `*API_KEY*`, `*CREDENTIAL*`, `*AUTH*`, …).
- How the command is launched on Windows (direct, via Node, via the Java wrapper launcher, or
  the restricted batch path) is decided by the executor and recorded in the execution record
  ([ADR 0014](../adr/0014-windows-invocation.md)). Adapters provide the information needed:
  the wrapper path, and for JS tools the package whose `bin` entry should be resolved.

## 6. Traceability markers

`testAuthoringGuide()` states where a new test goes, its file name pattern, and the
acceptance-criterion marker style that survives into machine-readable reports:

- `method-name-prefix`, e.g. JUnit `void ac1_returnsSecondPage()` with `@DisplayName("AC-1: …")`;
- `title-prefix`, e.g. Vitest/Jest `it("AC-1: returns the second page", …)`.

## 7. Planned built-in adapters (Phase 3)

| Adapter      | Detects                                                                                                                                                                  | Commands                                          | Result parsing                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------- |
| `java`       | Maven and Gradle (Groovy and Kotlin DSL, single and multi-module), wrappers, Spring Boot, JUnit 5, Mockito, Checkstyle, SpotBugs, Protobuf and OpenAPI generator plugins | compile, test (with filter), checkstyle, spotbugs | Surefire/Failsafe and Gradle JUnit XML, Checkstyle and SpotBugs XML |
| `javascript` | npm, pnpm and yarn, workspaces, TypeScript, Express, NestJS, React, Next.js, Vite, Jest, Vitest, ESLint, `ts-proto`/`protoc-gen-es`/`openapi-typescript`                 | test (with filter), lint, typecheck               | JSON reporters for Jest and Vitest, ESLint JSON, `tsc` diagnostics  |

Example Java projects for integration tests get Maven and Gradle wrappers generated with the
official Docker images, pinned to exact versions, with `distributionSha256Sum` set so the
wrapper verifies the downloaded distribution (decision D5).
