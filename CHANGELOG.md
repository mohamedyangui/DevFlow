# Changelog

All notable changes to DevFlow AI are listed here. Versions follow
[Semantic Versioning](https://semver.org/); while the version is `0.x`, a minor release may
contain breaking changes. Each release is a git tag and a GitHub release
([ADR 0028](docs/adr/0028-source-releases.md)); from 0.2.0 it is also published on npm as
`@devflowai/cli` ([ADR 0029](docs/adr/0029-npm-publication.md)).

## [0.2.0] - 2026-11-12

### Added

- **npm package `@devflowai/cli`** with the `devflow` command: `npm install -g @devflowai/cli`
  or `npx @devflowai/cli`, and `npx -y @devflowai/cli mcp` as an MCP server command. One
  package with the internal packages bundled; the tree-sitter grammars are shipped as
  WebAssembly only, so installing runs no native build.
- `scripts/pack-cli.mjs` stages the package from the built workspace (`--pack` runs
  `npm pack`).
- A publish workflow (`.github/workflows/publish.yml`): on a `vX.Y.Z` tag it builds, tests,
  checks the tag against the version and stages the release with provenance through npm
  trusted publishing, in the `npm` environment. The staged version goes live when the
  maintainer approves it on npmjs.com. No npm token is stored.

### Changed

- **The npm scope is `@devflowai`** (was the provisional `@devflow`). Code importing the
  internal packages by name must use the new scope.
- ESLint and Prettier ignore `dist-npm/` and local `.claude/` worktrees.

## [0.1.0] - 2026-11-12

The first release. DevFlow runs from a source checkout of the `v0.1.0` tag.

### Workflow

- Task contracts in YAML, JSON or Markdown with acceptance criteria, validated and linted with
  line numbers (`devflow task validate`), and JSON Schemas for task and configuration files.
- Assist mode: requirements analysis (edge cases, contradictions, dependencies) and a plan,
  each waiting for a developer's approval (`devflow analyze`, `devflow plan`, `devflow approve`,
  `devflow reject`).
- Test mode (`devflow test`): the model writes tests for the acceptance criteria, the developer
  approves the files by hash, and the tests run once against the current code for red/green
  baseline evidence per criterion.
- Implement mode (`devflow implement`, `devflow run`): the code change as exact edits limited to
  the approved plan, approved by hash, then verification against the baseline, a bounded repair
  loop and a verdict decided by deterministic rules.
- Git isolation: each run works on its own local branch (`devflow/<task id>`) and commits
  exactly the approved files; DevFlow never pushes on its own.
- Reports (`report.md`, `report.json`) with the evidence per criterion, the findings, the model
  usage and the audit trail; `devflow status` and `devflow report`.
- Review of a local change or a checked-out pull request (`devflow review`): gates,
  deterministic checks and an optional model review whose findings stay unverified, or are
  confirmed by a probe test with `--seek-evidence`.

### Verification and languages

- Verification engine and `devflow verify`: configured gates or a test gate per module,
  statuses from exit codes and parsed results, comparison with a baseline run.
- Language adapters for Java (Maven, Gradle), JavaScript/TypeScript (npm, pnpm, Yarn, Bun) and
  Python (uv, Poetry, pip), with test, lint and type-check parsers.
- External adapter plugins (`devflow plugins`) checked against the adapter API version and
  pinned by hash.
- Contract compatibility for OpenAPI 3.x and Protobuf with built-in breaking-change rules
  (`devflow contracts diff`) and cross-language change impact (`devflow contracts impact`).
- Example repositories (Spring Boot, Gradle, Express, a full-stack monorepo) verified against
  real builds.

### Security

- Workspace trust (`devflow trust`), a command policy with a hard deny list and approval by
  fingerprint (interactive or `--allow <fingerprint>` per invocation), and an in-house process
  launcher with environment scrubbing, output caps and timeouts.
- Path guard, secret detection and redaction in logs, prompts and reports, and an audit log of
  every decision.
- Optional container execution backend (`docker run --network none`, no fallback to the host).

### AI providers and coding agents

- Anthropic and OpenAI providers with structured output, cost tracking from a configured price
  table, budgets and per-step model routing.
- MCP server (`devflow mcp`) for coding agents: task validation, analysis, planning, test and
  implement runs, status, reports, verification, review and contract diffs. Approvals, trust
  and command permissions are not exposed as tools.
- Agent mode (`--provider agent`, the default of `devflow mcp`): the calling coding agent
  answers DevFlow's model requests, so no API key is needed.

### GitHub

- GitHub issues as task sources (`--issue`), pull request review with opt-in publishing of a
  redacted summary, and draft pull requests prepared only with explicit authorization
  (`devflow pr create --yes`).
- A composite GitHub Action with fork-safe verify and gated review workflow examples.
- Optional trace export compatible with OpenTelemetry (`--trace file|otlp`).

### Known limitations

- No npm package: DevFlow is installed from source (see the README). Fixed in 0.2.0.
- Validated end to end with one real coding-agent session (an MCP client in headless mode) on
  a small JavaScript project. Codex and other MCP clients have not been tried.
- The GitHub client, the GitHub Action, OTLP export to a real collector, `oasdiff`, `buf`, Jest
  and the pytest JUnit path are tested with fixtures or stand-ins only. The
  [roadmap](docs/roadmap.md) says what has and has not been run for real.

[0.2.0]: https://github.com/mohamedyangui/DevFlow/releases/tag/v0.2.0
[0.1.0]: https://github.com/mohamedyangui/DevFlow/releases/tag/v0.1.0
