# ADR 0001: TypeScript on Node.js 22+, ESM only

- **Status:** Accepted, 2026-11-06
- **Related:** decision D7 in the [architecture proposal](../design/architecture-proposal.md)

## Context

DevFlow is a CLI and an SDK that has to run on Windows, macOS and Linux, on developer machines
and in CI. It orchestrates other tools (Maven, Gradle, npm, pnpm, model APIs) rather than doing
heavy computation itself. Its main correctness risk is data shape: model output, task files,
tool reports. Its users are both Java and JavaScript/TypeScript developers.

Node.js 20 reached end of life in April 2026. Node 22 and 24 are the supported LTS lines, and
Node 26 is the current release line.

## Decision

- **Language:** TypeScript in the strictest practical configuration: `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `isolatedModules`.
- **Runtime:** Node.js 22 or newer.
  - Published packages declare `engines.node: ">=22.12.0"`. Commander 15, a runtime dependency
    of the CLI, requires 22.12.
  - The repository's development tooling declares `>=22.13.0`, because ESLint 10's
    dependencies require it. This only affects contributors, not users.
- **Modules:** ESM only, with `module`/`moduleResolution` set to `NodeNext`. No CommonJS build.
- **CI:** every supported line (22, 24, 26) on Linux and Windows.

### Tool versions (pinned in Phase 1)

| Tool       | Version    | Why this version                                                                                                                                                                                                   |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript | `~6.0.3`   | TypeScript 7.0 (the native compiler) is current, but `typescript-eslint` 8.72 supports `<6.1` only. Type-aware linting is worth more than the faster compiler today. Revisit when typescript-eslint supports TS 7. |
| ESLint     | `^10.14.0` | ESLint 9 is deprecated. ESLint 10 needs Node 22.13+, hence the contributor floor.                                                                                                                                  |
| Vitest     | `^5.1.0`   | Current major. Runs TypeScript directly, no build needed for tests.                                                                                                                                                |
| Zod        | `^4.6.7`   | See ADR 0011.                                                                                                                                                                                                      |

## Consequences

- Users on Node 20 or older cannot run DevFlow. The CLI states the requirement in `engines`.
- Consumers that still use `require()` need Node's `require(esm)` support, which is stable in
  Node 22.12+.
- `exactOptionalPropertyTypes` makes some code more verbose (spreading optional fields), in
  exchange for catching "present but undefined" bugs in persisted JSON.
- `engine-strict` is **not** enabled: a contributor on Node 22.12 gets a warning from pnpm, not
  a failure. Upgrading is recommended.

## Alternatives considered

- **Node ≥ 20.** Rejected: end of life.
- **Dual CJS/ESM packages.** Rejected: doubles build output and invites dual-package hazards for
  no real audience.
- **TypeScript 7.** Deferred for the typescript-eslint reason above.
- **Go or Rust single binary.** Rejected: the JS/TS adapter and the provider SDKs are native to
  the Node ecosystem, and contributors from both target communities can read TypeScript.
