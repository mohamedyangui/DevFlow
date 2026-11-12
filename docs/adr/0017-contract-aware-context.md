# ADR 0017: Contract-aware context: read-only Protobuf and OpenAPI discovery

- **Status:** Accepted, 2026-11-06. Implements refinement 5 of the architecture review.
  Phase 1 defines the `ContractRelation` schema in `ModuleProfile`. Read-only discovery arrives
  in Phases 2–3; compatibility verification in Phase 6.
- **Deciders:** Mohamed Yangui

## Context

Monorepos often share API contracts between languages: a `.proto` file compiled into Java
classes by the backend and into TypeScript types by the frontend, or an `openapi.yaml`
implemented by a Spring controller and consumed by a generated TypeScript client. A change on
one side affects the other, and the files that matter for a task are often the contract and
the generated code, not just the module being edited.

## Decision

The design separates **discovery** (early) from **compatibility verification** (Phase 6).

**Read-only discovery (Phases 2–3):**

- `@devflow-ai/context` classifies `.proto` files and OpenAPI documents (`openapi.yaml`,
  `openapi.json`, files with a top-level `openapi:` or `swagger:` key) as **contract files**.
  It extracts cheaply and without a full parser: the `package`, `import` statements,
  `service` and `message` names for Protobuf; the title, paths and operation ids for OpenAPI.
- Language adapters report how their module relates to each contract as a `ContractRelation`
  in `ModuleProfile.contracts`, always with evidence:
  - `defines` — the contract file is inside the module;
  - `generates-code-from` — the build generates code from it. Java:
    `protobuf-maven-plugin`, `com.google.protobuf` Gradle plugin, `openapi-generator` plugins.
    JS/TS: `ts-proto`, `protoc-gen-es`, `@bufbuild/*`, `buf.gen.yaml`, `openapi-typescript`,
    `orval`;
  - `consumes-generated-code` — the module imports code generated from the contract elsewhere.
- Context ranking boosts contract files and their generated counterparts when a task mentions
  a message, service, path or operation from them.
- Discovery **never runs** `protoc`, `buf` or any generator. It reads files only.

**Compatibility verification (Phase 6):** `buf breaking` or built-in rules for Protobuf, and
`oasdiff` or built-in rules for OpenAPI, deciding `breaking`, `non-breaking` or `unknown`
deterministically. A model may explain the impact and propose consumer updates; it never
decides compatibility.

## Consequences

- From Phase 3, a task touching a shared contract shows the affected modules in both languages
  in its context and plan, before any compatibility tooling exists.
- Until Phase 6, DevFlow does not claim a contract change is compatible or breaking. Reports
  list touched contracts as "compatibility not verified".

## Alternatives considered

- **Waiting for Phase 6 for anything contract-related.** Rejected: mixed-language monorepos
  are a primary use case, and discovery is cheap.
- **Running `protoc` during discovery.** Rejected: executes tooling, needs trust and
  installation.
