# @devflow-ai/adapter-javascript

The JavaScript and TypeScript language adapter: it recognizes npm, pnpm, Yarn and Bun projects
and workspaces, describes what they use with evidence, lists their tests, provides the
commands that test, lint, type-check and format-check them, and reads the reports those
commands write. It implements the `LanguageAdapter` port of `@devflow-ai/core`
([docs/specs/language-adapter.md](../../docs/specs/language-adapter.md), section 10).

The adapter only reads files through `RepositoryView` and returns data. It never runs a package
script or a configuration file to learn about a project: manifests are parsed as JSON,
`tsconfig.json` as JSON with comments, and configuration files are only checked for existence.
ESLint forbids it from importing `node:child_process`, `node:fs` or network modules (ADR 0003,
ADR 0006). Its only dependency is `@devflow-ai/core`.

```ts
import { javascriptAdapter } from "@devflow-ai/adapter-javascript";
registry.register(javascriptAdapter);
```

## What it detects

| Concern         | Detected from                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module          | every `package.json` that describes a project; a workspace root (`pnpm-workspace.yaml`, `workspaces`) and each of its packages are separate modules                                           |
| Package manager | the `packageManager` field (with its version), else the nearest lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `bun.lock`), else `pnpm-workspace.yaml`                         |
| Languages       | TypeScript (`tsconfig.json`, the `typescript` dependency, `.ts` sources) and JavaScript sources                                                                                               |
| Frameworks      | Express, Fastify, NestJS, Next.js, React, Vue, Angular, Vite                                                                                                                                  |
| Test frameworks | Vitest, Jest, Mocha, Playwright Test                                                                                                                                                          |
| Quality tools   | ESLint, Prettier, `tsc`                                                                                                                                                                       |
| Contracts       | `.proto` and OpenAPI files in the module; files named by generator commands in package scripts; the module's own contracts when it declares a generator (`ts-proto`, `openapi-typescript`, …) |

A tool counts when the module declares it in `dependencies` or `devDependencies` (confidence
0.95), configures it with a file in its directory or a key in its `package.json` (0.9), or only
lists it as a peer or optional dependency (0.7). Every detection points at the declaring line
or the configuration file. The version is that of the installed package, looked up in
`node_modules` the way Node.js resolves it; a declared range such as `^2.1.0` is shown in the
evidence, never reported as the version. Files of a nested package belong to that package,
not to the workspace root. Manifests in fixture, mock and snapshot directories, and manifests
that only set `"type"` for a directory, are not modules.

## Tests and conventions

- **Inventory.** `*.test.*`, `*.spec.*` and files in `__tests__` (and `test/` when Mocha is
  used). A readable file must declare a test or a suite, so helpers are not listed. The runner
  comes from the file's imports (`vitest`, `@jest/globals`, `@playwright/test`, `node:test`),
  otherwise the module's main runner; files under Playwright's `testDir` are Playwright tests.
  Levels: `e2e` for Playwright and `e2e/`, `integration` for `integration/`, `*.int.test.*` and
  files using supertest or Testcontainers, otherwise `unit`.
- **Conventions**, each reported only when at least 60% of at least two files follow it, with
  the files as evidence: the `.test` or `.spec` suffix (end-to-end files not counted), tests
  next to the code or in a test directory, `it` or `test`, explicit imports or the runner's
  globals, and `AC-n` title markers.
- **Authoring guide.** The acceptance criterion marker is a title prefix,
  `it("AC-1: returns the second page", …)`; a describe block titled `AC-2` marks every test in
  it. Titles reach the JSON report, which is how DevFlow links results to criteria.

## Commands

Every command runs `node` with the entry script of a tool installed in `node_modules`, resolved
from the `bin` field of the tool's package. Package scripts (`npm test`) are never used: they
are shell command lines the command policy cannot inspect. The command policy binds the script
into the approval fingerprint by its hash, and refuses a script that does not exist.

| Command        | Tool           | Arguments                                                                             | Parser        |
| -------------- | -------------- | ------------------------------------------------------------------------------------- | ------------- |
| `test`         | Vitest         | `run --reporter=default --reporter=json --outputFile.json=<report> --passWithNoTests` | `jest-json`   |
| `test`         | Jest           | `--ci --json --outputFile=<report> --passWithNoTests`                                 | `jest-json`   |
| `test-filter`  | Vitest or Jest | the same, plus `--testNamePattern {testNamePattern}` (e.g. `AC-1:`)                   | `jest-json`   |
| `lint`         | ESLint         | `. --format json --output-file <report>`                                              | `eslint-json` |
| `typecheck`    | `tsc`          | `--noEmit --pretty false --project tsconfig.json`                                     | `tsc`         |
| `format-check` | Prettier       | `--check .`                                                                           | `exit-code`   |

- A module gets a command only for a tool it declares or configures itself. When both Vitest
  and Jest are found, the one with the higher confidence runs (Vitest on a tie).
- Reports go to the `node_modules` directory the tool is installed in, named
  `.devflow-<module>-<tool>.json`, so the working tree stays clean.
- Commands run in the module root with `NO_COLOR=1` and `FORCE_COLOR=0`, and need no network.
- When a tool is declared but not installed, the command names the script that installing the
  dependencies would create. The policy refuses it because the script does not exist, and the
  gate is reported as not executed, with the reason.

## Reading results

- `jest-json` reads Jest's `--json` report and Vitest's `json` reporter (the same format), and
  only a report written by this execution. Failed expectations and assertion errors are
  `assertion_failure`, other thrown errors `runtime_error`, timeouts `timeout`, skipped and todo
  tests `skipped`. A test file that fails to load (syntax error, missing module) is one
  `compile_error` result, or `infrastructure_error` when the reason is not clear. A status the
  parser does not know is never taken as a pass. A missing, truncated or invalid report is
  `unparseable`.
- `eslint-json` turns ESLint messages into diagnostics with repository-relative locations.
- `tsc` reads `file(line,col): error TSxxxx: …` lines and global errors from the compiler
  output; the result is the exit code. A failed run whose output names no error is
  `unparseable`.
- `exit-code` is for tools whose only result is their exit code (Prettier).

## Limits

- No command for Mocha, Playwright, Node's built-in test runner or build scripts; their tests
  are listed but not run by a verification gate.
- `typecheck` is skipped for a solution-style `tsconfig.json` (`"files": []` with
  `references`), which needs `tsc --build`.
- A tool linked from outside the workspace (a global virtual store, `npm link`) is refused by
  the path guard: it is treated as not installed, and its command is denied.
- Only the tool's entry script is bound into the approval fingerprint, not the rest of its
  package: an update of the installed package is not detected by the fingerprint.
- Jest's report format is covered by fixture reports only; Jest itself has not been run
  against the adapter.
