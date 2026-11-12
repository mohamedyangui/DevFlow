# ADR 0008: BM25 plus structural ranking, no embeddings

- **Status:** Accepted, 2026-11-06. Implementation in Phase 2 (`@devflow-ai/context`).
- **Deciders:** Mohamed Yangui

## Context

The model needs the right files for a task within a token budget. Options are lexical ranking,
embeddings with a vector store, or both.

## Decision

Rank files with **BM25** over path tokens, symbol outlines and content, then apply explainable
boosts: identifiers quoted in the task, task scope paths, test/source pairing, one-hop import
neighbours of the top results, and optionally recent git churn. Every ranked file carries the
reasons it was selected (for example "matched `OrderController` from AC-1"). The model can
fetch more with read-only tools (ADR 0005).

## Consequences

- Local, deterministic and free: no embedding API calls, no data leaves the machine for
  indexing.
- Ranking decisions can be shown in the report and tested with fixtures.
- Semantic matches with no shared vocabulary may be missed. The read-only tools and an
  optional embedding plugin later mitigate this.

## Alternatives considered

- **Embeddings with a vector database.** Deferred: extra infrastructure, cost, and sending
  repository content to an embedding provider.
