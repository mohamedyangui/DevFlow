# @devflow/contracts

Contract compatibility verification for DevFlow AI: is a change to an OpenAPI or Protobuf
contract breaking? ([ADR 0021](../../docs/adr/0021-contract-compatibility.md))

**Status: Phase 6.** The built-in rules are implemented and tested with fixture pairs for
every rule. The `oasdiff` and `buf` integration is tested with recorded output and a fake
executor only.

## Comparing two versions

```ts
import { compareContract, compareContractBuiltin } from "@devflow/contracts";

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
