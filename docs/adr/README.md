# Architecture Decision Records

An ADR records one significant decision: the context, the decision, its consequences, and
the alternatives that were rejected. ADRs are immutable once accepted. To change a decision,
write a new ADR that supersedes the old one, and update the old one's status line to point at
it.

ADRs are decided by the project maintainer, Mohamed Yangui.

## Process

1. Copy the structure of an existing ADR into `NNNN-short-title.md`, using the next free
   number.
2. Set the status to **Proposed** and open a pull request.
3. When the change is merged, set the status to **Accepted** with the date.

Write an ADR when a decision is hard to reverse, affects more than one package, changes a
security property, or rejects an option that a reasonable contributor would otherwise propose.

## Index

| ADR                                          | Title                                                                                 | Status                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| [0001](0001-typescript-node-esm.md)          | TypeScript on Node.js 22+, ESM only                                                   | Accepted                               |
| [0002](0002-monorepo-tooling.md)             | pnpm workspaces, `tsc -b`, and a source export condition                              | Accepted                               |
| [0003](0003-package-boundaries.md)           | Seven MVP packages with enforced boundaries                                           | Accepted                               |
| [0004](0004-state-machine-and-run-store.md)  | Hand-written state machine and file-based run store                                   | Accepted (implementation in Phase 2)   |
| [0005](0005-single-agent-loop.md)            | One tool-using model loop per step, no multi-agent orchestration                      | Accepted (implementation in Phase 2/4) |
| [0006](0006-llm-output-is-data.md)           | Model output is data: command catalog and search/replace edits                        | Accepted                               |
| [0007](0007-workspace-trust.md)              | Workspace trust outside the repository; local execution only for trusted repositories | Accepted                               |
| [0008](0008-lexical-ranking.md)              | BM25 plus structural ranking, no embeddings                                           | Accepted (implementation in Phase 2)   |
| [0009](0009-tree-sitter.md)                  | `web-tree-sitter` behind a `SourceParser` port                                        | Accepted, confirmed by the spike       |
| [0010](0010-llm-providers.md)                | Official provider SDKs behind `LlmProvider`                                           | Accepted (implementation in Phase 2/4) |
| [0011](0011-zod-source-of-truth.md)          | Zod 4 as the single source of truth for schemas                                       | Accepted                               |
| [0012](0012-git-isolation.md)                | Dedicated local branch, commits per phase, never push                                 | Accepted (implementation in Phase 4)   |
| [0013](0013-report-and-status-semantics.md)  | JSON report as source of truth, strict status semantics                               | Accepted                               |
| [0014](0014-windows-invocation.md)           | Safe invocation of Windows `.cmd`/`.bat` wrappers                                     | Accepted (adapters in Phase 3)         |
| [0015](0015-test-intent-and-red-green.md)    | Test intent and red/green evidence                                                    | Accepted                               |
| [0016](0016-npm-scope-and-publication.md)    | Configurable npm scope and a publication guard                                        | Accepted                               |
| [0017](0017-contract-aware-context.md)       | Contract-aware context: read-only Protobuf and OpenAPI discovery                      | Accepted                               |
| [0018](0018-in-house-process-launcher.md)    | An in-house process launcher instead of `cross-spawn`                                 | Accepted                               |
| [0019](0019-github-rest-client.md)           | A small GitHub REST client on Node's `fetch` instead of `@octokit/rest`               | Accepted                               |
| [0020](0020-container-execution-backend.md)  | A container execution backend on `docker run`                                         | Accepted                               |
| [0021](0021-contract-compatibility.md)       | Contract compatibility: in-house OpenAPI and Protobuf parsers and built-in rules      | Accepted                               |
| [0022](0022-cross-language-change-impact.md) | Cross-language change impact: deterministic consumer heuristics                       | Accepted                               |
| [0023](0023-external-adapter-plugins.md)     | External language adapters as user-installed plugins, with adapter API versioning     | Accepted                               |
| [0024](0024-observability-export.md)         | Optional trace export compatible with OpenTelemetry, without an OpenTelemetry SDK     | Accepted                               |
| [0025](0025-evidence-seeking-review.md)      | Evidence-seeking review: model-written probe tests run in a git worktree              | Accepted                               |
| [0026](0026-mcp-server.md)                   | An in-house MCP server; approvals stay with the developer                             | Accepted                               |
| [0027](0027-agent-mode.md)                   | Agent mode: the calling coding agent answers DevFlow's model requests, no API key     | Accepted                               |

"Accepted" means the decision is made. Where the implementation belongs to a later phase,
the status says so: an accepted ADR is not a claim that the component exists. The
[roadmap](../roadmap.md) tracks what is implemented.
