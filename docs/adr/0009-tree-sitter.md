# ADR 0009: `web-tree-sitter` behind a `SourceParser` port

- **Status:** Accepted, 2026-11-06, pending a Phase 3 spike. The `SourceParser` port is
  defined together with its implementation in Phase 3, not in Phase 1.
- **Deciders:** Mohamed Yangui

## Context

Ranking (ADR 0008) and the language adapters need symbol outlines and import edges for Java,
TypeScript, TSX and JavaScript. Native parser bindings are a frequent source of install
failures on Windows.

## Decision

Use **`web-tree-sitter` (WASM)** with pinned grammar versions behind a `SourceParser` port.
Provide a regex-based fallback that extracts imports and top-level declarations when a grammar
cannot be loaded. A Phase 3 spike confirms grammar/runtime ABI compatibility before the
decision is relied on.

## Consequences

- One parsing approach for every language, no native compilation.
- Grammar and runtime versions must be upgraded together.
- If the spike fails, the fallback is the TypeScript compiler API for TS/JS and a Java-specific
  parser, recorded in a superseding ADR.

## Alternatives considered

- **TypeScript compiler API plus `java-parser`.** Two different approaches; kept as the
  fallback plan.
- **Native `tree-sitter` bindings.** Rejected: native builds on Windows.
