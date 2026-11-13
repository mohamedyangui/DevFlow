# ADR 0028: Source releases with one version for all packages

- **Status:** Accepted, 2026-11-12. First release: `v0.1.0`.
- **Deciders:** Mohamed Yangui

## Context

DevFlow had no release: every package was at `0.0.0`, there was no tag and no changelog, and
`devflow --version`, the MCP server's `serverInfo` and the reports all said `0.0.0`. People who
find the project need a fixed point to install, to report bugs against and to compare with
later versions. Publishing on npm is still blocked by ADR 0016 (scope ownership not verified),
so a release cannot be an npm package yet.

## Decision

- **Source releases.** A release is an annotated git tag `vX.Y.Z` on a commit of `main`, and a
  GitHub release for that tag whose notes are the version's `CHANGELOG.md` section. It is
  installed by building that tag from source, as the README describes. No build artifact is
  attached.
- **One version for every package.** The root `package.json` and every workspace package carry
  the same version, the version the CLI reports. A repository test enforces it.
- **Semantic Versioning, `0.x` for now.** While the version is `0.x`, a minor release may break
  the CLI, the configuration or the run store; the changelog says so when it does.
- **A changelog entry per release.** `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/)
  layout) has a section for the current version; a repository test checks it.
- **Release steps.** The version bump and the changelog go through a pull request like any
  change. After the maintainer merges it, the maintainer creates the tag and publishes the
  GitHub release; nothing creates a tag or a release automatically.
- **Packages stay `private`.** ADR 0016 still applies: removing `private`, provenance and npm
  publication need their own decision once the scope is verified.

## Consequences

- `devflow --version`, the MCP `serverInfo` and the reports show a real version, so a bug
  report or a report file can be traced to a release.
- Users build from source; there is no `npm install -g` yet (added by ADR 0029 in 0.2.0).
- The tests that compare a version read it from the CLI's `package.json` instead of a literal.

## Alternatives considered

- **Independent package versions (changesets).** Rejected for now: the packages are not
  published separately, and one version is simpler to report and to support.
- **Attaching a built tarball to the GitHub release.** Rejected for now: it would be an
  unsigned binary with no provenance, and building from the tag gives the same result.
