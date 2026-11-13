# @devflowai/contracts

Contract compatibility verification for DevFlow AI: is a change to an OpenAPI or Protobuf
contract breaking? ([ADR 0021](../../docs/adr/0021-contract-compatibility.md)) And which code
consumes it? ([ADR 0022](../../docs/adr/0022-cross-language-change-impact.md))

**Status: Phase 6.** The built-in rules are implemented and tested with fixture pairs for
every rule. The `oasdiff` and `buf` integration is tested with recorded output and a fake
executor only. Change impact is tested with a fixture mini repository (Spring controller,
Java gRPC service, TypeScript client, Python module and their tests) and per-heuristic tests;
it has not been run on a real project yet.

## Comparing two versions

```ts
import { compareContract, compareContractBuiltin } from "@devflowai/contracts";

const diff = compareContractBuiltin({ file: "api/openapi.yaml", base, head });
// diff.decidedBy: "builtin-rules"
// diff.changes[i]: { kind, rule, compatibility, decidedBy, location, message }
// diff.summary: { breaking, nonBreaking, unknown }; diff.notes: what limited the comparison

// With oasdiff or buf when they are installed and the command policy allows them:
const decided = await compareContract(
  { file: "api/openapi.yaml", base, head },
  { toolset: { toolchain, policy, executor, logDir }, basePath, headPath },
);
```

- `base` or `head` is `null` when the file does not exist in that version (an added contract
  is non-breaking, a deleted one breaking).
- The kind (`openapi`, `protobuf`) comes from the file name and content
  (`contractKindOf`), like context discovery, or is passed as `kind`.
- Every change is `breaking`, `non-breaking` or `unknown`, decided by `builtin-rules`,
  `tool:oasdiff` or `tool:buf`. `ContractChange` and `ContractDiff` are Zod schemas.

## Parsers

- `OpenApiDocument.parse(text)`: OpenAPI 3.x in YAML or JSON; operations, parameters
  (path-level and referenced ones included), local `$ref` resolution with cycle detection,
  line numbers for JSON pointers. External references are reported, never fetched.
- `parseProto(text)`: proto3, proto2 and editions syntax; package, imports, nested messages
  and enums, fields with numbers, types, labels and oneofs, `reserved` numbers and names,
  enum values, services and rpcs. Throws `ProtoParseError` with a line number.

## Rules

See the tables in ADR 0021. In short, for OpenAPI: removed operations, removed or optional
response properties, new required request fields and parameters, type changes and removed
request enum values are breaking. For Protobuf: removed fields without a reservation, reused
or changed field numbers, type, cardinality and oneof changes, removed messages, enums, enum
values, services and rpcs, and changed rpc types are breaking. Additions are non-breaking.
What the rules cannot decide is `unknown`, for a person to check.

## Tools

`runContractTool` runs `oasdiff breaking <base> <head> --format json` or
`buf breaking <head> --against <base> --error-format json` through the caller's command policy
and executor (`OASDIFF_COMMAND`, `BUF_COMMAND`), only when the toolchain probe finds the tool.
`parseOasdiffOutput` and `parseBufOutput` map their JSON. Anything that keeps a tool from
deciding (missing, denied, failed, unexpected output) is a reason, and the built-in rules
decide instead.

## Change impact

```ts
import { contractImpact, findConsumers } from "@devflowai/contracts";

const repo = { files: [{ path, language, text }], contracts: new Map([[file, [base, head]]]) };
const consumers = findConsumers(change, repo, modules);
// consumers[i]: { path, line, language, kind, via?, match, confidence: "exact" | "pattern" }
const impact = contractImpact(diffs, repo); // one entry per breaking change
```

- OpenAPI: Spring `@*Mapping` handlers (class prefix plus method path), HTTP calls in
  TypeScript/JavaScript (`fetch`, axios, `HttpClient`), Java/Kotlin (RestTemplate, WebClient,
  MockMvc) and Python (`requests`, `httpx`) whose literal URL matches the operation's path with
  path variables normalized, and member calls named after the `operationId`.
- Protobuf: imports of the generated code (Java `java_package`/`java_outer_classname` or the
  proto package, `<Service>Grpc`; TS/JS `<name>_pb` and friends; Python `<name>_pb2`,
  `<name>_pb2_grpc`) in files that also name the changed declaration.
- `kind` is the mechanism (`spring-mapping`, `ts-client-call`, `java-client-call`,
  `python-client-call`, `operation-id-call`, `generated-import`) or `test`, with the mechanism
  in `via`. Generated code is never a consumer.
- `pattern` matches (unknown method, stripped base URL, operation-id call, bare module name...)
  may be false positives. Nothing is executed, no model is asked, and an empty list does not
  prove there is no consumer: the search is lexical (see ADR 0022 for what it cannot see).
- The caller reads the files and enforces its path policy; `@devflowai/workflow` exports
  `consumerSources` (context discovery) and `consumerRepository`.
