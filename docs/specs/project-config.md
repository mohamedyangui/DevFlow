# Specification: project configuration (`.devflow/config.yaml`)

- **Status:** Schema implemented in Phase 1 (`ProjectConfig` in
  `packages/core/src/schemas/config.ts`, JSON Schema in
  [`schemas/config.schema.json`](../../schemas/config.schema.json)). Loading the file and the
  `devflow init` and `devflow trust` commands arrive in Phase 2. Nothing in Phase 1 reads this
  file.

## 1. Trust model

`.devflow/config.yaml` is committed to the repository, so it is **untrusted** until the user
trusts it with `devflow trust` ([ADR 0007](../adr/0007-workspace-trust.md)). Trust is stored in
`~/.devflow/trust.json`, keyed by the workspace path and the configuration's hash; editing the
file invalidates trust.

The configuration can describe the project and **restrict** DevFlow. It cannot grant itself
permissions. There are deliberately no fields for API keys, environment variable pass-through,
extra executables, shell commands, or network access, and unknown keys are rejected. Gates
select adapter-provided commands by purpose; they do not contain command lines.

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

| Field                                                                                      | Default     | Notes                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                                                  | required    | must be `1`                                                                                                                                                                        |
| `project.name`                                                                             | —           | display name                                                                                                                                                                       |
| `modules[]`                                                                                | auto-detect | `id` (module id), `path` (repository-relative), `adapter` (adapter id); duplicate ids rejected                                                                                     |
| `ai.provider`                                                                              | —           | `anthropic` or `openai`. API keys come from environment variables only.                                                                                                            |
| `ai.models.default`, `.analysis`, `.planning`, `.testDesign`, `.implementation`, `.review` | —           | model ids per step                                                                                                                                                                 |
| `ai.budgets.maxCostUsdPerRun`                                                              | 5           | positive, at most 1000                                                                                                                                                             |
| `ai.budgets.maxInputTokensPerRun`                                                          | 600 000     |                                                                                                                                                                                    |
| `ai.budgets.maxOutputTokensPerRun`                                                         | 80 000      |                                                                                                                                                                                    |
| `ai.budgets.maxCallsPerStep`                                                               | 12          | at most 100                                                                                                                                                                        |
| `workflow.requirePlanApproval`                                                             | `true`      |                                                                                                                                                                                    |
| `workflow.maxRepairAttempts`                                                               | 2           | 0–5                                                                                                                                                                                |
| `workflow.git.isolation`                                                                   | `branch`    | `branch` or `worktree` ([ADR 0012](../adr/0012-git-isolation.md))                                                                                                                  |
| `workflow.git.branchPrefix`                                                                | `devflow/`  |                                                                                                                                                                                    |
| `workflow.git.commit`                                                                      | `per-phase` | `per-phase` or `none`                                                                                                                                                              |
| `verification.baseline`                                                                    | `auto`      | `auto`, `always`, `never`                                                                                                                                                          |
| `verification.gates[]`                                                                     | `[]`        | `id`, `module`, `use` (a command purpose: `build`, `compile`, `test`, `lint`, `typecheck`, `static-analysis`, `format-check`), `required` (default `true`); duplicate ids rejected |
| `context.include[]`, `context.exclude[]`                                                   | `[]`        | repository-relative globs                                                                                                                                                          |
| `context.maxFileBytes`                                                                     | 524 288     | at most 5 MiB                                                                                                                                                                      |
| `security.additionalProtectedPaths[]`                                                      | `[]`        | paths DevFlow must never modify; can only add restrictions                                                                                                                         |

All paths are repository-relative with forward slashes. Absolute paths, drive letters, `..`
segments, backslashes, Windows-reserved device names and characters invalid on Windows are
rejected, so a configuration is valid on every platform.

## 4. Precedence

Built-in safety policy > the user's invocation (CLI flags, `~/.devflow/config.yaml`) > the
trusted project configuration. See the [context engine spec](context-engine.md) for how
project rules and instruction files rank.
