# ADR 0009: `web-tree-sitter` behind a `SourceParser` port

- **Status:** Accepted, 2026-11-06. Confirmed by the Phase 3 spike, 2026-11-08 (below). The
  `SourceParser` port is in `@devflowai/core` (`ports/source-parser.ts`), its implementation in
  `@devflowai/context` (`source-parser.ts`).
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

## Spike results (2026-11-08)

Run on Windows 11 with Node.js 22.12, with the versions now pinned in
`packages/context/package.json`:

| Package                  | Version | Grammar ABI              |
| ------------------------ | ------- | ------------------------ |
| `web-tree-sitter`        | 0.27.2  | runtime accepts 13 to 15 |
| `tree-sitter-java`       | 0.23.5  | 14                       |
| `tree-sitter-typescript` | 0.23.2  | 14 (TypeScript and TSX)  |
| `tree-sitter-javascript` | 0.25.0  | 15                       |

- Every grammar loads from the `.wasm` file its npm package ships. The packages' install
  scripts, which build native bindings, are not needed and are never run
  (`ignoredBuiltDependencies` in `pnpm-workspace.yaml`).
- Java, TypeScript, TSX and JavaScript samples parse without syntax errors, and walking the
  tree gives their declarations and imports. Loading the runtime takes about 20 ms, and
  loading a grammar and parsing a sample 15 to 60 ms. An 855 KiB Java file parses in about
  200 ms.
- Invalid code still yields a tree, with `hasError` set, and the declarations before the
  error.
- Node offsets are JavaScript string indices, also with non-ASCII text, so signatures are cut
  from the source text directly.

## Consequences

- One parsing approach for every language, no native compilation.
- Grammar and runtime versions must be upgraded together.
- If the spike fails, the fallback is the TypeScript compiler API for TS/JS and a Java-specific
  parser, recorded in a superseding ADR.

## Alternatives considered

- **TypeScript compiler API plus `java-parser`.** Two different approaches; kept as the
  fallback plan.
- **Native `tree-sitter` bindings.** Rejected: native builds on Windows.
