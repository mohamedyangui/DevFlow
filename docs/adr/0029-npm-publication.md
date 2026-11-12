# ADR 0029: npm publication as one bundled `@devflow-ai/cli` package

- **Status:** Accepted, 2026-11-12. Implements the publication step left open by ADR 0016 and
  ADR 0028. First npm version: `0.2.0`.
- **Deciders:** Mohamed Yangui

## Context

DevFlow is installed by building a source checkout (ADR 0028). Running it with `npx` or
installing it with `npm install -g` would make it much easier to try, and MCP clients are
usually configured with an `npx` command. ADR 0016 kept every package private until the scope
was verified and a publication decision was written.

The workspace has eleven packages and the CLI depends on all of the others. Publishing them
one by one would make ten library APIs public that are not designed or documented as such, and
every release would have to publish eleven packages in the right order. The tree-sitter grammar
packages that `@devflow-ai/context` depends on also carry native bindings with an install
script, although DevFlow only reads their WebAssembly builds.

## Decision

- **Scope `@devflow-ai`.** The scope is the npm organization `devflow-ai`, which the maintainer
  creates and owns before the first publication; it was renamed from the provisional
  `@devflow` with the procedure of ADR 0016. The publish workflow fails if the scope does not
  belong to the account that configured the trusted publisher.
- **One published package, `@devflow-ai/cli`,** with the `devflow` command. The workspace
  packages stay `private` and are not published separately.
- **The package is staged, not published from the workspace.** `scripts/pack-cli.mjs` builds
  `dist-npm/package` from the compiled workspace:
  - the CLI's `dist`, the README (relative links rewritten to the release tag on GitHub), the
    license and the changelog;
  - the internal packages it needs, as `bundleDependencies` (their compiled JavaScript and a
    reduced `package.json`);
  - the third-party dependencies of those packages, declared once at the top; the script stops
    if two packages ask for different ranges;
  - the grammar packages as their `.wasm` files, license and a minimal `package.json`, bundled,
    so installing DevFlow never runs a native build;
  - no type declarations or source maps.
- **Published from GitHub Actions only,** by `.github/workflows/publish.yml`, when a `vX.Y.Z`
  tag is pushed: build, tests, a check that the tag matches the version, the staged package,
  then `npm publish` with **provenance** through npm trusted publishing (OIDC). No npm token is
  stored in the repository. The job runs in the `npm` environment, so the maintainer can require
  a manual approval on GitHub before anything is published.
- **The maintainer creates the tag** after merging the release pull request (ADR 0028); nothing
  creates a tag automatically. A local `npm publish` of the staged package is refused, because
  provenance requires the CI environment.

## Consequences

- `npx @devflow-ai/cli` and `npm install -g @devflow-ai/cli` work, and the MCP server can be
  configured as `npx -y @devflow-ai/cli mcp`.
- The internal package names (`@devflow-ai/core`, ...) appear inside the tarball but cannot be
  installed on their own; using DevFlow as a library is not supported yet.
- The publish workflow needs one-time setup on npmjs.com (the organization and a trusted
  publisher for this repository and workflow) and an `npm` environment on GitHub.
- A version cannot be published twice: a broken release is fixed with a new patch version.

## Alternatives considered

- **Publishing all eleven packages.** Rejected for now: it makes internal APIs public and
  multiplies the release work. It can be revisited when a library is designed for outside use.
- **A single-file bundle (esbuild, tsup).** Rejected: a new build dependency, and DevFlow
  resolves files at run time (its own `package.json`, the grammar `.wasm` files, provider SDKs
  loaded on demand) that a bundler would have to special-case.
- **Publishing from the maintainer's machine with a token.** Rejected: no provenance, and a
  long-lived token to protect.
