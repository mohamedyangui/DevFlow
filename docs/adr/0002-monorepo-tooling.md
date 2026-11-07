# ADR 0002: pnpm workspaces, `tsc -b`, and a source export condition

- **Status:** Accepted, 2026-11-06

## Context

The repository contains seven packages (ADR 0003) that depend on each other. We need:

- fast, strict dependency installation that prevents phantom dependencies;
- incremental builds in dependency order;
- type-checking, linting and tests that work on a fresh clone **without** building first;
- published packages that point at compiled JavaScript, never at TypeScript sources.

## Decision

- **pnpm workspaces** (`packages/*`), with the pnpm version pinned in `packageManager`.
  Internal dependencies use `workspace:*`.
- **`tsc -b` project references** for builds. Each package has a `tsconfig.build.json` that is
  `composite`, emits to `dist/`, and references exactly the packages it depends on. The root
  `tsconfig.build.json` references all seven packages.
- **A custom export condition, `devflow-source`.** Each package's `exports` map is:

  ```json
  ".": {
    "devflow-source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
  ```

  The root `tsconfig.json` (type-check only, `noEmit`) sets
  `customConditions: ["devflow-source"]`, and so does Vitest. So inside the repository, every
  package resolves its workspace dependencies to their TypeScript sources. Outside the
  repository nobody sets that condition, so consumers get `dist/`.

- **No task runner** (Nx, Turborepo). Root scripts call `tsc`, `eslint`, `prettier` and
  `vitest` directly.

## Consequences

- `pnpm typecheck`, `pnpm lint` and `pnpm test` work on a fresh clone. Only the end-to-end test
  of the compiled binary (`tests/e2e/`) needs `pnpm build` first, and it fails with an
  explicit message if the build is missing.
- `files: ["dist"]` keeps `src/` out of published tarballs, so the `devflow-source` entry would
  not resolve for a consumer even if they set the condition. That is intentional.
- Two TypeScript configurations exist (build vs type-check). A repository test checks that
  each package's build references match its declared dependencies.

## Alternatives considered

- **Nx or Turborepo.** Rejected for now: seven packages do not need a task graph or remote
  cache, and each tool adds configuration and dependencies. Revisit if build times grow.
- **TypeScript `paths` aliases.** Rejected: they diverge from how Node resolves packages at
  runtime, and need a second mechanism for Vitest.
- **Building before every test run.** Rejected: slow feedback and stale-`dist` bugs.
