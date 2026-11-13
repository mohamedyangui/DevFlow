# Contributing to DevFlow AI

Thank you for your interest. DevFlow AI is created and maintained by Mohamed Yangui. It is in
early development; please open an issue to discuss larger changes before starting work.

## Setup

- Node.js **22.13 or newer** for development (the published packages need 22.12+; the
  development tooling, ESLint 10 in particular, needs 22.13). With an older 22.x, pnpm prints an
  "Unsupported engine" warning.
- pnpm 10 (the exact version is pinned in `packageManager`; `corepack enable` picks it up).
- Windows, macOS and Linux are all supported development platforms. The repository uses LF line
  endings (`.gitattributes`), except for `.cmd`/`.bat` files.

```bash
pnpm install
git config core.hooksPath .githooks   # refuse commits and pushes to main (see below)
pnpm check      # build, typecheck, lint, format:check, test
```

## Scripts

| Script                                    | What it does                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                              | `tsc -b` for all packages, output in `packages/*/dist`                                                                  |
| `pnpm typecheck`                          | Type-checks sources and tests without building (uses the `devflow-source` condition)                                    |
| `pnpm lint`                               | ESLint with type-aware rules and package-boundary rules                                                                 |
| `pnpm format` / `pnpm format:check`       | Prettier                                                                                                                |
| `pnpm test`                               | Vitest: unit, repository and end-to-end tests (end-to-end tests need `pnpm build` first)                                |
| `pnpm test:examples`                      | Real Maven, Gradle and npm builds of `examples/` through `devflow verify` (needs Java 21+, npm, network; takes minutes) |
| `pnpm schemas:generate`                   | Regenerates `schemas/*.json` from the Zod schemas (needs `pnpm build`)                                                  |
| `pnpm scope:rename --to @scope [--write]` | Renames the npm scope everywhere ([ADR 0016](docs/adr/0016-npm-scope-and-publication.md))                               |

## Rules for changes

- **Package boundaries.** Allowed dependencies between packages are declared in
  `devflow.packageBoundaries` in the root `package.json`. Lint and tests enforce them. Changing
  them needs an ADR. No package may import `node:child_process`; adapters may not import
  `node:fs` or network modules.
- **Schemas first.** New data shapes are Zod schemas in `@devflowai/core`, strict where people or
  models write them, with invariants as refinements. If you change `TaskFile` or
  `ProjectConfig`, run `pnpm build && pnpm schemas:generate` and commit the result; a test
  checks for drift.
- **No placeholders that look functional.** A command, option or export that does not work
  yet must not exist. Skeleton packages export nothing.
- **Honest reporting in code.** Never produce `passed` without an execution record, and never
  mark a finding `confirmed` without deterministic evidence. The schemas reject both.
- **Security-sensitive areas** (anything that executes processes, writes files, handles paths,
  secrets or trust) need tests for the failure cases, and on Windows-specific behaviour, a test
  that runs on the Windows CI leg.

## Tests

- Unit tests live next to each package in `packages/*/test/`. Repository-level checks are in
  `tests/repo/`, end-to-end tests of the built CLI in `tests/e2e/`.
- Every schema change needs positive and negative tests.
- Tests that need a tool that may be missing (Java, Docker) must report themselves as skipped
  with the reason. They must never pass silently.
- Keep tests deterministic: no network, no real model calls (the Fake and Replay providers
  arrive in Phase 2).

## Architecture decisions

Significant decisions are recorded as ADRs in [`docs/adr/`](docs/adr/README.md). Write one
when a decision is hard to reverse, crosses packages, changes a security property, or rejects
an option others would propose. ADRs are not edited after acceptance; supersede them instead.

## Branches and pull requests

`main` is protected and always releasable. Nothing is committed or pushed to it directly.

- **One branch per phase or change.** Roadmap phases use `phase-<n>/<topic>` (for example
  `phase-2/context-engine`); other changes use `fix/<topic>`, `docs/<topic>` or
  `chore/<topic>`. Branch from an up-to-date `main`.
- **Every change is a pull request** into `main`. CI must pass on all jobs (Ubuntu and Windows,
  Node 22, 24 and 26).
- **Only the maintainer merges.** Mohamed Yangui reviews and accepts every pull request; nobody
  merges their own change, and nothing is merged automatically.
- **Enforcement.** On GitHub, `main` requires a pull request with passing checks and refuses
  force pushes and deletion. Locally, the hooks in `.githooks/` refuse commits on `main` and
  pushes to `main` once you run `git config core.hooksPath .githooks`. Never bypass them with
  `--no-verify`.

Within a branch:

- Small, focused commits with descriptive messages.
- `pnpm check` must pass.
- Describe in the pull request what you verified and how. If something could not be verified
  (for example a Windows-only path tested on Linux), say so.

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
