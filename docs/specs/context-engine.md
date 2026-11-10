# Specification: engineering context engine

- **Status:** Phase 2 implements the pipeline in `@devflow/context`: discovery, classification,
  sensitive-content filtering, contract scanning, instruction loading, ranking and packing,
  and the `WorkspaceRepository` implementation of `RepositoryView`. Section 5 lists what
  differs from the full design and what is still to come.

## 1. Purpose

Select the repository content a workflow step needs, within a token budget, without sending
sensitive content to a model, and explain every selection.

## 2. Pipeline

1. **Discover.** `git ls-files -co --exclude-standard -z`, or a directory walk honouring ignore
   files when the directory is not a git repository. Always excluded: `.git`, `node_modules`,
   `target`, `build`, `dist`, `.devflow/runs`, Python virtual environments and caches
   (`.venv`, `.tox`, `.nox`, `__pycache__`), binary files (NUL-byte sniffing), files larger
   than `context.maxFileBytes`.
2. **Classify.** Language, role (source, test, configuration, documentation, generated,
   **contract**) and owning module.
3. **Filter sensitive content.** Files on the sensitive-path list are never read for a prompt;
   other content is scanned and redacted ([security model](security-model.md)).
4. **Detect modules.** Each adapter's `detectModules` runs; files map to the nearest module
   root. Modules from different adapters coexist, so a mixed Java + TypeScript monorepo yields,
   for example, a `backend` module (java) and a `web` module (javascript).
5. **Load instructions** in precedence order (section 4), each tagged with source and trust.
6. **Rank** with BM25 plus structural boosts ([ADR 0008](../adr/0008-lexical-ranking.md)).
   Every selected file carries its reasons.
7. **Pack** to the step's budget: top files in full, the next tier as outlines, the rest of the
   module as a path list.

The model can request more through read-only tools (`read_file`, `search_text`, `list_files`,
`get_outline`), each routed through the path guard and redaction and capped per step.

## 3. Contract awareness (Protobuf and OpenAPI)

See [ADR 0017](../adr/0017-contract-aware-context.md).

**Read-only discovery** (Phases 2–3):

- `.proto` files are classified as Protobuf contracts. A lightweight scanner (no `protoc`)
  extracts `syntax`, `package`, `import` paths, `option java_package`/`java_outer_classname`,
  and top-level `message`, `enum` and `service` names.
- OpenAPI documents (`openapi.{yaml,yml,json}`, `swagger.*`, or any YAML/JSON file with a
  top-level `openapi:` or `swagger:` key) are classified as OpenAPI contracts; the title,
  paths and `operationId`s are extracted.
- Adapters report each module's relation to a contract (`defines`, `generates-code-from`,
  `consumes-generated-code`) with evidence. Examples of evidence: a `protobuf-maven-plugin`
  block in `pom.xml`, the `com.google.protobuf` Gradle plugin, a `buf.gen.yaml`, a `ts-proto`
  or `@bufbuild/protoc-gen-es` dependency, an `openapi-generator` plugin, an import of a
  generated package.
- Mapping generated code back to its contract uses deterministic rules: Java packages from
  `option java_package` (or the proto `package`), and TS/JS import paths that match the
  generator's configured output directory.
- **Ranking:** when a task mentions a message, service, field, path or operation id from a
  contract, the contract file, the generated code, and modules with `generates-code-from` or
  `consumes-generated-code` relations are boosted, with reasons such as "defines message
  `OrderCreated` mentioned in AC-2".

**Not in discovery:** running `protoc`, `buf` or generators; deciding whether a change is
breaking. Compatibility verification is Phase 6. Until then, plans and reports list touched
contracts and affected modules as "compatibility not verified".

## 4. Instruction precedence

| Rank | Source                                                                        | Shapes code        | Grants permissions         |
| ---- | ----------------------------------------------------------------------------- | ------------------ | -------------------------- |
| 1    | DevFlow safety policy (built in)                                              | n/a                | cannot be overridden       |
| 2    | The user's invocation: CLI flags, interactive answers, `~/.devflow`           | yes                | yes                        |
| 3    | Task contract (what to build); external sources such as issues stay untrusted | yes                | no                         |
| 4    | `.devflow/config.yaml` and `.devflow/rules/`                                  | yes                | only after `devflow trust` |
| 5    | `AGENTS.md` (nearest file first)                                              | yes                | no                         |
| 6    | Conventions inferred from existing code                                       | yes                | no                         |
| 7    | README, docs, code comments                                                   | informational only | no                         |

A conflict between rank 3 and ranks 4–6 is surfaced as a clarification question or a plan
risk, never resolved silently. Commands mentioned in documentation are never executed.
Untrusted content placed in a prompt is wrapped in labelled delimiters; this is a mitigation,
the real protection being that the model cannot act.

## 5. Phase 2 implementation notes

- **Discovery** walks the directory in every case and applies `.gitignore` files (with git's
  precedence: deeper files win, the last matching rule wins) and `.git/info/exclude`.
  `git ls-files` arrives with DevFlow's internal git operations (Phase 4). Symbolic links are
  never followed. Files on the sensitive-path list are skipped without being read; their paths
  are counted but never packed.
- **Content loading:** at most 64 MiB of text is read for ranking; further files are ranked by
  path only. Content with NUL bytes or invalid UTF-8 is treated as binary.
- **Modules** come from `.devflow/config.yaml`; without it the whole workspace is one module
  `root`. Adapter detection plugs in when the adapters exist (Phase 3).
- **Outlines and imports** of Java, TypeScript (with TSX) and JavaScript files come from the
  tree-sitter `SourceParser` ([ADR 0009](../adr/0009-tree-sitter.md)): one line per class,
  interface, enum, record, type, function, method, constructor and test, with its line number,
  indented by nesting, and the declaration without its body (annotations and `export`
  included), for example `L9:   @GetMapping("/api/orders") public List<OrderDto> list()`.
  Import edges come from the parsed `import` and `export … from` statements, `import()` and
  `require()` calls. Other languages (Kotlin, Python, Go, Protobuf, Markdown headings) keep
  regex-based declaration lines and imports. So do the three parsed languages when a grammar
  cannot be loaded (the pack then has a warning), and files beyond the first 32 MiB of parsed
  source.
- **Ranking boosts:** an identifier from the task that is a file's name (+6) or appears in it
  (+3, at most +12 in total), a path named in the task (+10), the task's `scope.include`
  (+3) and `scope.modules` (+2), a contract declaring a message, service, enum, operation or
  path the task mentions (+6). Scores are then weighted by role (generated ×0.3,
  documentation ×0.6, configuration ×0.8). The test/source partner of a top file gains half of
  its score, and files imported by a top file gain 30%. `scope.exclude` removes files.
- **Packing:** instructions take at most 30% of the budget (the lowest precedence is dropped
  first). Then up to 25 files in full (each at most a quarter of the budget), up to 60 as
  outlines, and up to 400 as paths, including the other files of the relevant modules.
  Tokens are estimated as characters / 4.
- **Not yet implemented:** the read-only model tools (`read_file`, `search_text`,
  `list_files`, `get_outline`) arrive with the tool-using step loop (ADR 0005, Phase 4);
  generated-code mapping from adapter evidence arrives with the adapters (Phase 3); recent git
  churn is not used.
