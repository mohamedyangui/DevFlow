# ADR 0021: Contract compatibility: in-house OpenAPI and Protobuf parsers and built-in rules

- **Status:** Accepted, 2026-11-10. Implemented in Phase 6 in `@devflow-ai/contracts`
  (`src/openapi/`, `src/protobuf/`, `src/tools.ts`, `src/compare.ts`), used by review mode
  and `devflow contracts diff`.
- **Deciders:** Mohamed Yangui

## Context

[ADR 0017](0017-contract-aware-context.md) separated contract discovery (Phases 2 and 3)
from compatibility verification (Phase 6). The architecture proposal (section 13) planned
`oasdiff` or built-in rules for OpenAPI, and `buf breaking` or `protobufjs` plus built-in
rules for Protobuf. DevFlow must answer "is this contract change breaking?" deterministically
on machines where neither tool is installed, and a model must never decide it.

## Decision

**A new package, `@devflow-ai/contracts`, depending on `@devflow-ai/core` only.** It adds no npm
dependency: it uses `yaml` and `zod`, which the repository already has.

**OpenAPI 3.x.** The document is read with the YAML parser (JSON is YAML 1.2), with line
positions for locations. Local `$ref`s (`#/...`, JSON pointers with `~0`/`~1` escapes) are
resolved, chains followed, cycles detected; external references (files, URLs) are never
fetched and are reported as unresolved. Operations are matched by method and path with path
variables unnamed (`/pets/{id}` and `/pets/{petId}` are the same operation). Request schemas
are compared as inputs, response schemas as outputs; `allOf` members are merged;
`readOnly` properties are ignored in requests and `writeOnly` ones in responses.

| Change                                                                                      | Compatibility |
| ------------------------------------------------------------------------------------------- | ------------- |
| Operation removed; 2xx response removed; media type removed                                 | breaking      |
| Response property removed, or became optional                                               | breaking      |
| New required parameter, request property or request body; became required                   | breaking      |
| Type changed (both sides typed)                                                             | breaking      |
| Request enum value removed; request newly restricted to an enum                             | breaking      |
| Null added to a response type; null removed from a request type                             | breaking      |
| Operation, optional parameter or property, response, media type added                       | non-breaking  |
| Response enum value added or enum list removed; request property, parameter or body removed | unknown       |
| Format changed; `oneOf`/`anyOf` changed; type added or removed                              | unknown       |
| Unresolved reference that differs; non-2xx response removed                                 | unknown       |
| Swagger 2.0, unreadable document, comparison budget exhausted                               | unknown       |

**Protobuf.** An in-house tokenizer and recursive-descent parser reads proto3, proto2
(`required`, groups, extensions, `extend`) and editions syntax: package, imports, nested
messages and enums, fields (number, type, label, oneof, `map<,>`), `reserved` numbers,
ranges (`to max`) and names, enum values (aliases), services and rpcs (streaming). Options
are skipped. Types are resolved inside the file (innermost scope first) and compared by
package-relative name, so a package rename is one change. The rules follow buf's `WIRE_JSON`
category:

| Change                                                                    | Compatibility |
| ------------------------------------------------------------------------- | ------------- |
| Field removed without reserving its number and its name                   | breaking      |
| Field number reused with another name; field number changed               | breaking      |
| Field type, cardinality (singular, repeated, required) or oneof changed   | breaking      |
| Reserved number or name reused; reservation removed; required field added | breaking      |
| Message, enum, enum value, service or rpc removed; enum value renamed     | breaking      |
| Rpc request or response type changed; streaming changed; package changed  | breaking      |
| Field or enum value removed with number and name reserved; additions      | non-breaking  |
| Explicit presence (`optional`) added or removed                           | unknown       |

**Tools.** When the toolchain probe finds `oasdiff` or `buf` on PATH, they run as commands of
the command policy (workspace trust and an approval of the fingerprint, like a gate), never
through a shell: `oasdiff breaking <base> <head> --format json` and
`buf breaking <head> --against <base> --error-format json`, with the base version copied into
the run directory. Their JSON output is mapped to the same `ContractChange` shape
(`decidedBy: tool:oasdiff | tool:buf`; oasdiff levels 3/2/1 to breaking/unknown/non-breaking,
every buf annotation breaking). A missing, denied, failing or unreadable tool falls back to the
built-in rules, and the diff says why. `oasdiff` is never run on documents with external
references (it would fetch them), and no tool runs when a review skips its gates (for
example on a fork's pull request) or when the container backend is selected
([ADR 0020](0020-container-execution-backend.md)): the tools run on the host, so with that
backend the built-in rules decide.

**Review mode.** Every changed contract file is compared at the base commit (read with
`GitWorkspace.show`) and in the working tree. Breaking changes become one `confirmed`,
`high`, `compatibility` finding per file with deterministic evidence naming each rule and who
decided it. `unknown` changes and files that could not be compared become manual checks of
the report, never findings.

## Consequences

- Compatibility is decided on any machine, offline, with no tool to install; installing
  `oasdiff` or `buf` makes the decision theirs.
- The built-in rules are a documented subset. Not compared: security schemes, servers,
  callbacks, links, response headers, `additionalProperties`, numeric and length bounds,
  `discriminator`; Protobuf options (including `json_name`), extensions, and editions
  features. A change outside the subset is not reported, so "no breaking change found" is
  not a proof of compatibility.
- The tool path is tested with recorded output and a fake executor only; neither tool has
  been run by the test suite.
- A breaking change fails the review verdict; an intended break needs a person to accept it.

## Alternatives considered

- **`protobufjs` and an OpenAPI parser library (`@apidevtools/swagger-parser`).** Rejected:
  new dependencies (and, for the OpenAPI library, code that can fetch remote references) for
  a parser that only has to read what compatibility needs.
- **Requiring `oasdiff` and `buf`.** Rejected: most workspaces do not have them, and the
  answer would then be "not verified" everywhere.
- **Letting the model judge compatibility.** Rejected by the master rules: the model may
  explain the impact, never decide it.
