# ADR 0011: Zod 4 as the single source of truth for schemas

- **Status:** Accepted, 2026-11-06
- **Deciders:** Mohamed Yangui

## Context

DevFlow's data crosses trust boundaries constantly: task files written by people, project
configuration from the repository, model output, tool reports, persisted run artifacts. Each
needs runtime validation, TypeScript types, and, for files people edit, JSON Schema for
editor completion. Maintaining these separately drifts.

## Decision

- Every external data shape is a **Zod 4 schema** in `@devflow-ai/core`. TypeScript types are
  inferred with `z.infer`.
- **Invariants live in the schemas**, as refinements, not in scattered `if` statements. For
  example: a gate result of `passed` requires an execution record with exit code 0; a finding
  can be `confirmed` only with deterministic evidence; a report can carry the verdict
  `verified` only if every required gate passed.
- Objects that people or models write are **strict** (`z.strictObject`): unknown keys are
  errors, so a typo like `acceptanceCriterias` or an injected `apiKey` field is rejected rather
  than silently ignored.
- **JSON Schema is generated** from the Zod schemas (`pnpm schemas:generate` writes
  `schemas/task.schema.json` and `schemas/config.schema.json`, input form). A repository test
  fails if the committed files drift from the schemas.
- Model-facing "wire" schemas (Phase 2+) are kept simple (all fields required, nullable instead
  of optional, no deep unions) and mapped to the domain schemas after validation.

## Consequences

- One edit changes validation, types and editor completion together.
- Zod 4's error messages are generic. The task loader translates them into user-facing
  messages with paths and line numbers (`issuesFromZodError`).
- Refinements on record keys produce only "Invalid key in record" in Zod 4, so checks that
  need a specific message (for example credential-like environment variable names) are
  written as object-level refinements instead.

## Alternatives considered

- **Hand-written JSON Schema plus Ajv.** Rejected: types and schema drift.
- **TypeBox.** Viable; rejected because Zod's refinement model fits cross-field invariants
  better and is more familiar to contributors.
