# Specification: project configuration (`.devflow/config.yaml`)

- **Status:** Schema implemented in Phase 1 (`ProjectConfig` in
  `packages/core/src/schemas/config.ts`, JSON Schema in
  [`schemas/config.schema.json`](../../schemas/config.schema.json)). Phase 2 adds the
  loader (`loadProjectConfig`: at most 256 KiB, UTF-8, read through the path guard, hashed
  byte for byte, issues with line numbers) and `devflow trust`. `devflow init` is planned for
  Phase 2.

## 1. Trust model

`.devflow/config.yaml` is committed to the repository, so it is **untrusted** until the user
trusts it with `devflow trust` ([ADR 0007](../adr/0007-workspace-trust.md)). Trust is stored in
`~/.devflow/trust.json` (or `$DEVFLOW_HOME/trust.json`), keyed by the workspace's real path and
the SHA-256 of the file's exact bytes; any edit invalidates trust, and so does adding the file
to a workspace that was trusted without one. An invalid file cannot be trusted.

The configuration can describe the project and **restrict** DevFlow. It cannot grant itself
permissions. There are deliberately no fields for API keys, environment variable pass-through,
extra executables, shell commands, or network access, and unknown keys are rejected. Gates
select adapter-provided commands by purpose; they do not contain command lines. There is no
field to load adapter plugins: `modules[].adapter` can name a plugin's id only once the user
has installed it with `devflow plugins add`
([ADR 0023](../adr/0023-external-adapter-plugins.md)).

## 2. Example

```yaml
# yaml-language-server: $schema=../schemas/config.schema.json
version: 1
project:
  name: shop
modules: # optional; detected automatically when omitted
  - { id: backend, path: backend, adapter: java }
  - { id: web, path: web, adapter: javascript }
ai:
  provider: anthropic
  models:
    default: <model id>
  budgets:
    maxCostUsdPerRun: 5
workflow:
  requirePlanApproval: true
  maxRepairAttempts: 2
  git: { isolation: branch, branchPrefix: devflow/, commit: per-phase }
verification:
  baseline: auto
  gates:
    - { id: backend-test, module: backend, use: test }
    - { id: web-lint, module: web, use: lint, required: false }
context:
  exclude: ["**/fixtures/large/**"]
  maxFileBytes: 524288
security:
  additionalProtectedPaths: ["db/migrations/**"]
```

## 3. Fields

| Field                                                                                      | Default       | Notes                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                                                  | required      | must be `1`                                                                                                                                                                                       |
| `project.name`                                                                             | —             | display name                                                                                                                                                                                      |
| `modules[]`                                                                                | auto-detect   | `id` (module id), `path` (repository-relative), `adapter` (adapter id); duplicate ids rejected                                                                                                    |
| `ai.provider`                                                                              | —             | `anthropic` or `openai`. API keys come from environment variables only.                                                                                                                           |
| `ai.models.default`, `.analysis`, `.planning`, `.testDesign`, `.implementation`, `.review` | —             | model ids per step                                                                                                                                                                                |
| `ai.prices.<model>`                                                                        | `{}`          | `inputUsdPerMTok`, `outputUsdPerMTok`, optional `cachedInputUsdPerMTok` and `cacheWriteUsdPerMTok` (US dollars per million tokens). No price is built in; a model without one has an unknown cost |
| `ai.budgets.maxCostUsdPerRun`                                                              | 5             | positive, at most 1000; counts only calls to models listed in `ai.prices`                                                                                                                         |
| `ai.budgets.maxInputTokensPerRun`                                                          | 600 000       |                                                                                                                                                                                                   |
| `ai.budgets.maxOutputTokensPerRun`                                                         | 80 000        |                                                                                                                                                                                                   |
| `ai.budgets.maxCallsPerStep`                                                               | 12            | at most 100                                                                                                                                                                                       |
| `workflow.requirePlanApproval`                                                             | `true`        |                                                                                                                                                                                                   |
| `workflow.maxRepairAttempts`                                                               | 2             | 0–5                                                                                                                                                                                               |
| `workflow.git.isolation`                                                                   | `branch`      | `branch` or `worktree` ([ADR 0012](../adr/0012-git-isolation.md))                                                                                                                                 |
| `workflow.git.branchPrefix`                                                                | `devflow/`    |                                                                                                                                                                                                   |
| `workflow.git.commit`                                                                      | `per-phase`   | `per-phase` or `none`                                                                                                                                                                             |
| `verification.baseline`                                                                    | `auto`        | `auto`, `always`, `never`                                                                                                                                                                         |
| `verification.gates[]`                                                                     | `[]`          | `id`, `module`, `use` (a command purpose: `build`, `compile`, `test`, `lint`, `typecheck`, `static-analysis`, `format-check`), `required` (default `true`); duplicate ids rejected                |
| `context.include[]`, `context.exclude[]`                                                   | `[]`          | repository-relative globs                                                                                                                                                                         |
| `context.maxFileBytes`                                                                     | 524 288       | at most 5 MiB                                                                                                                                                                                     |
| `security.additionalProtectedPaths[]`                                                      | `[]`          | paths DevFlow must never modify; can only add restrictions                                                                                                                                        |
| `execution.backend`                                                                        | `local`       | `local` or `container` ([ADR 0020](../adr/0020-container-execution-backend.md)); `--backend` of the user's invocation takes precedence                                                            |
| `execution.container.image`                                                                | —             | image every command runs in; required for `container`; never pulled; pin it by digest (`@sha256:...`) to bind its content                                                                         |
| `execution.container.moduleImages.<module>`                                                | `{}`          | per-module image overrides                                                                                                                                                                        |
| `execution.container.cpus`, `.memory`, `.pidsLimit`                                        | 2, `4g`, 1024 | `cpus` 0.1–64; `memory` like `512m` or `4g` (swap disabled); `pidsLimit` 16–32 768                                                                                                                |
| `execution.container.network`                                                              | `none`        | only `none`: the configuration cannot give a container a network                                                                                                                                  |
| `execution.container.readOnlyRootFilesystem`                                               | `true`        | `--read-only`; `/tmp` is a writable tmpfs and `HOME` is `/tmp`                                                                                                                                    |

All paths are repository-relative with forward slashes. Absolute paths, drive letters, `..`
segments, backslashes, Windows-reserved device names and characters invalid on Windows are
rejected, so a configuration is valid on every platform.

## 4. Precedence

Built-in safety policy > the user's invocation (CLI flags, `~/.devflow/config.yaml`) > the
trusted project configuration. For the execution backend this means: `--backend` wins in both
directions; without it, the trusted configuration's `execution.backend` applies, else `local`.
A repository cannot override an explicit `--backend container`, and an untrusted
configuration has no effect because nothing runs in an untrusted workspace. A user-level
`~/.devflow/config.yaml` is not implemented yet. See the [context engine spec](context-engine.md) for how
project rules and instruction files rank.
