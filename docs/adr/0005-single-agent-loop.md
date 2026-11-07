# ADR 0005: One tool-using model loop per step, no multi-agent orchestration

- **Status:** Accepted, 2026-11-06. Implementation in Phases 2 and 4.

## Context

Multi-agent designs ("planner agent", "coder agent", "reviewer agent" talking to each other)
are popular. They multiply model calls, make failures hard to attribute, and make behaviour
hard to audit. DevFlow's workflow is already explicit: each step has a defined input, output
and set of capabilities.

## Decision

- Each workflow step that needs a model makes **one bounded loop** of model calls. The model
  may call **read-only tools** (`read_file`, `search_text`, `list_files`, `get_outline`), each
  routed through the path guard and redaction, and capped per step.
- The step's final output is a schema-validated JSON document (ADR 0006).
- Steps communicate only through persisted artifacts, never through model-to-model
  conversation.
- Step capabilities are granted by construction: the analysis step receives no workspace
  writer and no executor, so it cannot write files or run commands.

## Consequences

- Each model call is attributable to one step, one prompt template version and one budget.
- Replay testing (ADR 0010) is straightforward: a step is a function of its inputs and the
  recorded model responses.
- If a future measurement shows that a specialised sub-agent improves results for a specific
  step, it can be added inside that step without changing the workflow.

## Alternatives considered

- **Multi-agent crews.** Rejected until there is a measured benefit.
- **A single autonomous agent with write and execute tools.** Rejected: it conflicts with the
  security model (ADR 0006, ADR 0007).
