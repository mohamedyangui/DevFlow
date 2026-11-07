# @devflow/context

**Status: not implemented. Planned for Phase 2.** The package exists so that its boundaries
(it may depend only on `@devflow/core`) are enforced from the start. It exports nothing yet.

Planned responsibilities, specified in [docs/specs/context-engine.md](../../docs/specs/context-engine.md):

- Git-aware file discovery and classification (source, test, config, docs, generated, contract).
- Read-only discovery of `.proto` and OpenAPI files and their relationships to Java and
  JavaScript/TypeScript modules.
- Loading project instructions (`AGENTS.md`, `.devflow/rules/`) with a defined
  precedence.
- Explainable relevance ranking and token-budgeted context packing.
