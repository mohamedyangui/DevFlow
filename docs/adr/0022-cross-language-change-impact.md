# ADR 0022: Cross-language change impact: deterministic consumer heuristics

- **Status:** Accepted, 2026-11-11. Implemented in Phase 6 in `@devflow/contracts`
  (`src/impact/`), used by review mode and `devflow contracts impact`.
- **Deciders:** Mohamed Yangui

## Context

[ADR 0021](0021-contract-compatibility.md) answers "is this contract change breaking?". The
next question a reviewer asks is "who does it break?": the Spring controller that serves the
removed operation, the TypeScript client that calls it, the Python job that imports the
generated Protobuf module. In a mixed repository these consumers are in other languages and
other modules than the contract. DevFlow must list them without a compiler for every
language, without running anything from the repository, and a model must never decide them.

## Decision

**Deterministic heuristics over the repository text, in `@devflow/contracts`.**
`findConsumers(change, repo, modules)` returns `ConsumerRef[]`
(`{ path, line, language, kind, via?, match, confidence }`, a Zod schema in `@devflow/core`);
`contractImpact(diffs, repo)` gives one `ContractImpact` per breaking change, with at most 50
consumers listed and the rest counted. The package still depends on `@devflow/core` only: the
caller reads the files (`@devflow/workflow` uses context discovery, so ignore files, sensitive
files and the configured include and exclude globs apply) and passes their text. Comments are
masked before matching; string literals are kept. No new dependency.

**OpenAPI.** The target is the changed operation's method and path, path variables written
`{}` (`/orders/{id}` and `/orders/{orderId}` are the same), plus its `operationId` from the
version that still has it.

| Heuristic            | Languages              | What matches                                                                                                                                                         |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spring-mapping`     | Java, Kotlin           | `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`, `@RequestMapping(path/value, method)`; a class-level `@RequestMapping` is a prefix  |
| `ts-client-call`     | TypeScript, JavaScript | `fetch(url, { method })`, `axios(url \| { url, method })`, `x.request({ url, method })`, `x.get/post/put/delete/patch(url)` (axios, Angular `HttpClient`, supertest) |
| `java-client-call`   | Java, Kotlin           | RestTemplate (`getForObject`, `exchange` with `HttpMethod.X`...), WebClient and WebTestClient `.get().uri(url)`, MockMvc and RestAssured builders                    |
| `python-client-call` | Python                 | `requests`, `httpx`, sessions and clients: `x.get/post/...(url)`                                                                                                     |
| `operation-id-call`  | all                    | a member call named after the `operationId` (`api.deleteOrder(...)`; snake case in Python), for generated clients; ids shorter than 4 characters are ignored         |

URLs are read from string literals, template literals, f-strings and `+` concatenation; every
non-literal part is a hole. A leading hole (a base URL variable) is stripped. Constants are not
resolved. The path part of the document's `servers[].url` is accepted as a prefix.

**Protobuf.** The target is the generated code of the `.proto` file, by the conventions of
the standard generators, in files that also name the changed top-level declaration (a service
also through `Grpc`, `Stub`, `Servicer`, `Client`, `ImplBase`). A change of the whole file
(package changed, file removed) lists every importer.

| Language               | Generated names                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Java, Kotlin           | package `java_package`, else the proto package; outer class `java_outer_classname`, else the file name in CamelCase (`OuterClass` appended on a clash); with `java_multiple_files` every message; `<Service>Grpc` |
| TypeScript, JavaScript | `<name>_pb`, `<name>_grpc_pb`, `<name>_grpc_web_pb`, `<name>_connect`, `<name>.client`; a bare `<name>` module (ts-proto) only under a directory that looks generated or names the proto package                  |
| Python                 | `<name>_pb2`, `<name>_pb2_grpc`, `<name>_grpc`                                                                                                                                                                    |

The Protobuf parser now keeps simple file-level options (`java_package`,
`java_outer_classname`, `java_multiple_files`) for this.

**Confidence.** `exact`: the method is known on both sides and the path is equal segment for
segment (after normalizing variables and the server prefix), or the import is a generated name.
`pattern`: an unknown method, a stripped base URL, a literal value in place of a path variable,
a suffix match, a Java wildcard import of the package, a bare TS module name, any
`operation-id-call`. A pattern match may be a false positive, and says so wherever it is shown.

**Tests and generated code.** A consumer in a test file (module test roots, `src/test/`,
`*.test.ts`, `*Test.java`, `test_*.py`...) has kind `test` and the mechanism in `via`.
Generated code (`generated/`, `*_pb2.py`, `*_pb.ts`...) is never a consumer.

**Where it shows.** In review mode, when a compared contract has a breaking change, the
working tree is searched; `artifacts/review-contracts.json` keeps `impact` and `impactNotes`,
each confirmed breaking-change finding lists up to 20 consumers as deterministic `file`
evidence (with path and line), `report.json` has `impact`, and `report.md` an "Impact"
section, with pattern-only matches labelled. A pattern match adds a manual check. The consumers
never change a finding's severity or verification: the finding is the breaking change itself;
consumers are leads. `devflow contracts impact <file>... [--base <ref>] [--json]` does the same
from the command line.

## Consequences

- Consumers are found in Java, Kotlin, TypeScript, JavaScript and Python with no compiler, no
  tool and no model, in one pass over the files.
- The search is lexical: a URL built far from the call, a constant path, a route registered
  dynamically, reflection, another repository and other languages (Go, C#...) are not seen.
  An empty list is not proof that nothing consumes the contract; the report says so.
- Spring mappings are read by annotation position: a mapping on a nested class or with a path
  from a constant is missed. JAX-RS, Micronaut, Express, FastAPI and Django routes are not read.
- Generated names follow the default generator conventions; a project with custom output
  names or plugins is not matched.
- The source budget is 64 MiB and 1 MiB per file; what limited the search is a note in the
  report.

## Alternatives considered

- **Asking the model for consumers.** Rejected: the LLM never decides impact facts, and its
  answer cannot be checked.
- **Language parsers (tree-sitter grammars for every language).** Rejected for now: the
  grammars are not all installed, and annotations, URL literals and imports are reliably read
  lexically once comments are masked. The Java and TypeScript parsers' imports can be passed
  in (`ConsumerSource.imports`).
- **Running the generators (`protoc`, OpenAPI generator) to know the exact names.** Rejected:
  it executes tools on untrusted content and needs them installed.
