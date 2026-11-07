# ADR 0016: Configurable npm scope and a publication guard

- **Status:** Accepted, 2026-11-06. Implements decision D3 and refinement 4 of the architecture
  review.
- **Deciders:** Mohamed Yangui

## Context

No `@devflow/*` package is published on npm, but an unpublished name does not mean the scope
is available: the `devflow` organization may exist without public packages, or be claimed
later. The unscoped names `devflow` and `devflow-ai` are taken. The scope must be verified
before anything is published, and renaming must stay cheap.

## Decision

- The scope is **provisionally `@devflow`** and is defined once, in the root `package.json`:
  `"devflow": { "npmScope": "@devflow" }`. The ESLint boundary rules and the repository tests
  read it from there.
- **Renaming is mechanical:** `pnpm scope:rename --to @new-scope` lists the files that would
  change (dry run); `--write` applies the change to package names, imports, docs and the
  `npmScope` field. Then run `pnpm install` to refresh the lockfile. A repository test runs the
  script against a fixture.
- **Nothing can be published by accident:** every package, including the root, is
  `"private": true`, which makes `npm publish` and `pnpm publish` refuse. A repository test
  enforces it.
- Removing `private` is a deliberate change made only after the scope's ownership has been
  verified on npm by the maintainer, and is accompanied by a release ADR (provenance,
  versioning, changelog).
- The CLI binary is named `devflow` regardless of the scope.

## Consequences

- Choosing a different scope later is a single command plus a lockfile refresh.
- Until the release ADR, DevFlow is installed from source.

## Alternatives considered

- **Unscoped package names.** Rejected: the obvious names are taken.
- **Publishing placeholder packages to reserve names.** Rejected: publishes something that
  appears functional but is not.
