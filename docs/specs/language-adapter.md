# Specification: language adapters (draft)

- **Status:** Draft. The `LanguageAdapter` port (API version 1), `RepositoryView`,
  `ToolchainProbe` and the data schemas (`ModuleCandidate`, `ModuleProfile`,
  `ContractRelation`, `InferredConvention`, `TestInventory`, `TestAuthoringGuide`,
  `CommandSpec`, `ParsedCommandResults`) exist in `@devflow/core` (Phase 1). The adapter SDK,
  output validation, registry, toolchain probe and conformance kit exist (Phase 3, section 8).
  The Java adapter (section 9) and the JavaScript/TypeScript adapter (section 10) exist
  (Phase 3). The interface may still change before Phase 3 completes.

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
  the wrapper path, or for JavaScript tools `node` and the tool's entry script, resolved from
  the `bin` field of its installed package (section 10).

## 6. Traceability markers

`testAuthoringGuide()` states where a new test goes, its file name pattern, and the
acceptance-criterion marker style that survives into machine-readable reports:

- `method-name-prefix`, e.g. JUnit `void ac1_returnsSecondPage()` with `@DisplayName("AC-1: …")`;
- `title-prefix`, e.g. Vitest/Jest `it("AC-1: returns the second page", …)`.

## 7. Built-in adapters (Phase 3)

Both built-in adapters exist: Java (section 9) and JavaScript/TypeScript (section 10).

| Adapter      | Detects                                                                                                                                                                  | Commands                                                               | Result parsing                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `java`       | Maven and Gradle (Groovy and Kotlin DSL, single and multi-module), wrappers, Spring Boot, JUnit 5, Mockito, Checkstyle, SpotBugs, Protobuf and OpenAPI generator plugins | compile, test (with filter), build, checkstyle, spotbugs, format-check | Surefire/Failsafe and Gradle JUnit XML, Checkstyle and SpotBugs XML |
| `javascript` | npm, pnpm, Yarn and Bun, workspaces, TypeScript, Express, NestJS, React, Next.js, Vite, Vitest, Jest, ESLint, Prettier, `ts-proto`/`protoc-gen-es`/`openapi-typescript`  | test (with filter), lint, typecheck, format-check                      | JSON reports of Jest and Vitest, ESLint JSON, `tsc` diagnostics     |

Example Java projects for integration tests get Maven and Gradle wrappers generated with the
official Docker images, pinned to exact versions, with `distributionSha256Sum` set so the
wrapper verifies the downloaded distribution (decision D5).

## 8. SDK, validation and registry

These exist in `@devflow/core`:

- **`defineAdapter(definition)`** fills in the API version and a default `inferConventions`
  (no conventions). Adapters are composed of `DetectionStrategy` objects (build tool,
  framework, test runner, quality tool), run in order by `runDetectors`, and `ResultParser`
  objects. Helpers build evidence that points at a file and line (`evidenceAt`), join and
  compare repository paths, and derive module ids from module roots (`moduleIdFor`).
- **Validation.** `validatedAdapter(adapter)` checks every value an adapter returns against
  the core schemas, and also that: candidates and profiles name the adapter itself; a module
  root is reported once; source roots, test roots, wrappers, test files and command working
  directories stay inside the module root; command ids are unique; commands have origin
  `adapter`; no command is on the hard deny list of the command policy; and each purpose has
  at most one command without parameters, which is the command a gate with that purpose runs
  (commands with parameters, such as a test filter, are for targeted runs). Invalid output is
  `ADAPTER_OUTPUT_INVALID`; an exception thrown by an adapter is `ADAPTER_FAILED`, naming the
  adapter and the operation.
- **Registry.** `AdapterRegistry` registers adapters (id `^[a-z][a-z0-9-]{0,31}$`, API
  version 1, no duplicates: otherwise `ADAPTER_INVALID`) and discovers modules: from the
  `modules` of the project configuration when it declares any, otherwise from every adapter's
  `detectModules`. A failing adapter or module becomes a warning instead of hiding the other
  modules. Detected module ids are derived from the module root; when two adapters claim the
  same root, the second id gets the adapter id appended.
- **Toolchain.** `PathToolchainProbe` answers whether a tool is on PATH by looking at the
  absolute PATH entries only, so a repository cannot make a tool appear by shipping a file with
  its name. It never starts a process, so it does not report versions.
- **Fresh reports.** Build tools leave old reports behind (`target/surefire-reports` keeps
  files from earlier runs). `freshReportFiles` lists report files whose modification time is
  at most two seconds before the execution started (`RepositoryEntry.modifiedMs`); older files
  are ignored, so a build that failed before running its tests cannot be read as a pass from a
  previous run's reports.
- **Conformance kit.** `checkAdapterConformance(adapter, fixtures)` from
  `@devflow/core/testing` runs the shared checks: identity, valid and deterministic output of
  every operation, the expected module roots, evidence and test files that exist, catalogs
  that are valid with every tool available and with none, and `parseResults` that never
  reports a passed test when no report file was written. `MemoryRepository` and
  `StaticToolchainProbe` make fixtures easy to write. Every adapter's tests run the kit.

- **Command output.** `parseResults` may read `execution.stdoutPath` and `execution.stderrPath`
  through the repository view, for example to find compiler errors. Those logs live under
  `.devflow/runs`, which the workspace repository view does not serve; the verification engine
  (planned) is to give `parseResults` a view in which that execution's two logs are readable. A
  parser that cannot read them treats the run as having no output; it never guesses.

## 9. The Java adapter

`@devflow/adapter-java` ([README](../../packages/adapter-java/README.md)) implements this
interface for Maven and Gradle.

- **Modules.** A module is one build: a POM that no other POM aggregates (its `<modules>` and
  Maven 4 `<subprojects>`, also in profiles, belong to it), the outermost directory with a
  Gradle settings file, or a Gradle build file outside every settings directory. Build files
  inside source sets (`src/test/resources/…`) are fixtures and are ignored. A directory with
  both a POM and Gradle files is read as Maven, unless only Gradle has a wrapper there.
- **Reading builds.** POMs are parsed as XML (entity declarations refused); `${…}` properties
  are resolved within the reactor. Gradle settings, build scripts, `buildSrc`/`build-logic`
  scripts and `gradle/libs.versions.toml` are read as text, never evaluated. Every detection
  points at the build file and, when found, the declaring line.
- **Profile.** Build tool with version (from the wrapper properties) and wrapper; Java (with
  the configured release) and Kotlin; Spring Boot; JUnit 5, JUnit 4, TestNG, Mockito, AssertJ,
  Testcontainers; Checkstyle, SpotBugs, PMD, JaCoCo, Spotless; source and test roots that exist
  (Gradle test source sets such as `src/integrationTest/java` included); contracts: `.proto`
  and OpenAPI files inside the module (`defines`) and the ones the Protobuf and OpenAPI
  generator plugins read (`generates-code-from`).
- **Tests.** Maven lists classes that match the Surefire and Failsafe default includes; Gradle
  lists every class of its test source sets; either way the file must contain a test
  annotation. The level is `integration` for Failsafe names, integration source sets and
  `@SpringBootTest`/`@Testcontainers` classes, otherwise `unit`. Conventions are reported only
  when they hold for at least 60% of at least two files.
- **Markers.** `method-name-prefix`: `void ac1_returnsSecondPage()` (several criteria:
  `ac1_ac2_…`), with `@DisplayName("AC-1: …")` on JUnit 5. Parsers accept both forms.
- **Commands.** `compile`, `test`, `test-filter` (parameter), `build`, and `checkstyle`,
  `spotbugs`, `format-check` when the build applies those plugins; the wrapper when there is
  one, otherwise `mvn`/`gradle`. Gradle commands clean the outputs of the tasks whose reports
  they read (`cleanTest test`), so an up-to-date task cannot leave only an old report.
- **Results.** `junit-xml` (Surefire, Failsafe, Gradle), `checkstyle-xml`, `spotbugs-xml`,
  `javac` (compiler output; the result is the exit code) and `exit-code`. Only reports written
  by the execution are read; a missing, truncated or invalid report makes the result
  `unparseable`. A test reported twice keeps its worst outcome.

## 10. The JavaScript adapter

`@devflow/adapter-javascript` ([README](../../packages/adapter-javascript/README.md))
implements this interface for npm, pnpm, Yarn and Bun projects.

- **Modules.** One module per `package.json` that describes a project; a manifest that only
  sets `"type"` for a directory is not one. A workspace root (`pnpm-workspace.yaml` or
  `workspaces`) and each of its packages are separate modules, and files of a nested package
  belong to that package. Manifests in fixture, mock and snapshot directories are ignored.
- **Reading projects.** Manifests are parsed as JSON and `tsconfig.json` as JSON with
  comments; configuration files are only checked for existence (Playwright's `testDir` is read
  as text). Nothing is evaluated. Versions are those of the installed packages, looked up in
  `node_modules` as Node.js resolves them; a declared range appears in the evidence, never as
  the version.
- **Profile.** Package manager from the `packageManager` field, the nearest lockfile or
  `pnpm-workspace.yaml`; TypeScript and JavaScript; Express, Fastify, NestJS, Next.js, React,
  Vue, Angular, Vite; Vitest, Jest, Mocha, Playwright; ESLint, Prettier, `tsc`. A tool counts
  when the module declares it (0.95), configures it (0.9) or lists it only as a peer or
  optional dependency (0.7). Contracts: `.proto` and OpenAPI files in the module (`defines`),
  files named by generator commands in package scripts, and the module's own contracts when it
  declares a generator such as `ts-proto`, `@bufbuild/protoc-gen-es` or `openapi-typescript`,
  or has `buf.gen.yaml` (`generates-code-from`).
- **Tests.** `*.test.*`, `*.spec.*`, files in `__tests__` and, with Mocha, `test/`; a readable
  file must declare a test or a suite. Levels: `e2e` for Playwright and `e2e/`, `integration`
  for `integration/`, `*.int.test.*` and files using supertest or Testcontainers, otherwise
  `unit`. Conventions follow the 60%-of-at-least-two-files rule.
- **Markers.** `title-prefix`: `it("AC-1: returns the second page", …)`. `AC-n` in an
  enclosing describe title applies to every test inside it.
- **Commands.** `node` with the entry script of the installed tool, never a package script
  (a shell command line the policy cannot inspect): `test` and `test-filter` with Vitest or
  Jest, `lint` with ESLint, `typecheck` with `tsc --noEmit` (not for solution-style
  configurations), `format-check` with Prettier, each only for a tool the module declares or
  configures. Reports are written to the `node_modules` directory the tool is installed in,
  under a name unique to the module and the tool. For a tool that is not installed, the
  command names the script installing would create; the command policy refuses a script that
  does not exist ([security model](security-model.md), section 4), so the gate is not
  executed.
- **Results.** `jest-json` (Jest `--json` and Vitest's `json` reporter): failed expectations
  and assertion errors are `assertion_failure`, other errors `runtime_error`, timeouts
  `timeout`; a test file that fails to load is one `compile_error` result, or
  `infrastructure_error` when the reason is not clear; an unknown status is never a pass.
  `eslint-json`, `tsc` (compiler output; a failure that names no error is `unparseable`) and
  `exit-code`. Only reports written by the execution are read; a missing, truncated or invalid
  report makes the result `unparseable`.
