# ADR 0003: Seven MVP packages with enforced boundaries

- **Status:** Accepted, 2026-11-06
- **Deciders:** Mohamed Yangui
- **Related:** decision D1 in the [architecture proposal](../design/architecture-proposal.md)

## Context

The original brief suggested twelve or more packages, roughly one per engine. Many of those
engines (analysis, planning, test design, implementation, verification, review, reporting)
share one lifecycle and the same types. Splitting them would create packages that always
change and ship together.

## Decision

Seven packages for the MVP. `github` and `contracts` are added in Phases 5 and 6.

| Package                       | Responsibility                                                                           | May depend on (internal) |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| `@devflow/core`               | Schemas, domain rules, ports, errors, task loading. Later: security policy and executor. | none                     |
| `@devflow/context`            | Repository discovery, classification, instructions, ranking, packing                     | `core`                   |
| `@devflow/ai`                 | Model gateway and providers                                                              | `core`                   |
| `@devflow/adapter-java`       | Maven, Gradle, JUnit, Spring Boot                                                        | `core`                   |
| `@devflow/adapter-javascript` | npm, pnpm, yarn, Jest, Vitest, ESLint, tsc                                               | `core`                   |
| `@devflow/workflow`           | State machine, steps, run store, reports, SDK entry point                                | `core`, `context`, `ai`  |
| `@devflow/cli`                | The `devflow` binary (composition root)                                                  | any                      |

The table lives in **one place**: the `devflow.packageBoundaries` field of the root
`package.json`. Three mechanisms enforce it:

1. **ESLint** (`no-restricted-imports`, built from that field) rejects imports of other
   workspace packages that are not in the allowed list.
2. **Repository tests** (`tests/repo/packages.test.ts`) check that each package's
   `dependencies` and `tsconfig.build.json` references match the table.
3. **TypeScript project references** make an undeclared dependency fail the build.

Two further restrictions apply to package sources:

- No package may import `node:child_process`. Only the Phase 2 executor in `core` will be
  allowed to, through a single reviewed exception.
- Adapters may not import `node:fs` or network modules. They read files only through the
  `RepositoryView` port, which keeps them side-effect free and testable with in-memory
  repositories.

## Consequences

- Adapters cannot depend on each other or on `workflow`. A mixed Java + TypeScript monorepo is
  handled by the workflow running several adapters side by side, not by adapters knowing about
  each other.
- Adding a package means editing the boundaries table, which a reviewer sees.
- Packages that are skeletons in Phase 1 export nothing. They exist so the boundaries,
  build graph and CI are in place before code arrives.

## Alternatives considered

- **One package per engine (12+).** Rejected: high coordination cost, no independent consumers.
- **A single package.** Rejected: provider SDKs and adapters have different dependency
  footprints and release cadences, and third-party adapters need a small, stable `core`.
- **dependency-cruiser or Nx module boundaries.** Rejected: extra tooling for a rule ESLint
  already expresses.
