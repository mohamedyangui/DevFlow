# ADR 0006: Model output is data: command catalog and search/replace edits

- **Status:** Accepted, 2026-11-06. The `CommandSpec` schema exists in `@devflow-ai/core`
  (Phase 1). The catalog, executor and edit application arrive in Phases 2–4.
- **Deciders:** Mohamed Yangui

## Context

A core requirement is that DevFlow never executes arbitrary commands proposed by a model, and
treats repository content and issues as untrusted. Any text a model produces may have been
influenced by prompt injection.

## Decision

**The AI proposes, deterministic code decides.**

1. **Commands come from a catalog, never from model text.** Language adapters and the
   trusted project configuration describe commands as `CommandSpec` data: an executable, an
   argv template, a working directory, a timeout, and declared parameters. A model can only
   _select_ a catalog entry by id. If the entry declares parameters (for example a test filter),
   the model's value must fully match the parameter's anchored regular expression and replaces
   exactly one argv element.
   - The schema rejects placeholders that are not a whole argument, undeclared placeholders,
     unanchored parameter patterns, control characters in arguments, and environment variables
     whose names look like credentials.
   - The executable must be a bare tool name or a wrapper in the working directory.
     Shells and other dangerous executables are denied by the command policy at runtime.
2. **Edits are data.** The model returns an `EditSet` of exact-match search-and-replace blocks
   and whole-file creations. The control plane checks each path (workspace containment,
   plan scope, protected paths) and the file's current content hash before applying it. An
   edit whose search text does not match fails loudly.
3. **All model output is validated** with Zod before use. One repair attempt with the
   validation errors is allowed, then the step fails.

## Consequences

- Prompt injection cannot make DevFlow run a command that is not in the catalog. It can still
  influence the _content_ of generated code, which is why human review of the diff is a
  required control (see the [security model](../specs/security-model.md)).
- A project with an unusual build command must describe it in `.devflow/config.yaml` and the
  user must trust that configuration (ADR 0007).

## Alternatives considered

- **Letting the model emit shell commands, filtered by a deny list.** Rejected: deny lists are
  bypassable, and quoting rules differ by shell and platform.
- **Unified diffs.** Rejected: models frequently produce malformed hunks; search/replace
  either matches exactly or fails.
