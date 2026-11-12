# @devflow-ai/context

The engineering context engine: it selects the repository content a workflow step needs,
within a token budget, without sending sensitive content to a model, and explains every
selection. It depends only on `@devflow-ai/core`. Specified in
[docs/specs/context-engine.md](../../docs/specs/context-engine.md).

**Implemented (Phase 2):**

- **Discovery** (`discoverFiles`): a directory walk that honours `.gitignore` files at every
  level and `.git/info/exclude`, never follows symbolic links, always excludes `.git`,
  `node_modules`, `target`, `build`, `dist` and `.devflow/runs`, and never reads files on the
  sensitive-path list. Large and binary files are reported as skipped.
- **Classification**: language, role (source, test, configuration, documentation, generated,
  contract, instructions) and owning module.
- **Read-only contract discovery** (ADR 0017): `.proto` declarations (`scanProtobuf`) and
  OpenAPI titles, paths and operation ids (`scanOpenApi`), without running any tool.
- **Ranking** (`rankFiles`, ADR 0008): BM25 over path, outline and content, plus boosts for
  identifiers, paths and routes quoted in the task, the task scope, contracts the task
  mentions, test/source pairs and one-hop import neighbours. Every file carries its reasons.
- **Instructions** (`loadInstructions`): `.devflow/rules/*.md`, the nearest `AGENTS.md` files
  and the root README, in precedence order, redacted and truncated.
- **Packing** (`buildContext`): top files in full, the next tier as outlines, the rest of the
  relevant modules as paths, all redacted and within the budget. The result is a
  `ContextPack`, persisted by the workflow as `artifacts/context.json`.
- **`WorkspaceRepository`**: the read-only `RepositoryView` given to language adapters.

**Not implemented yet:** module detection by language adapters (Phase 3; until then modules
come from `.devflow/config.yaml` or default to the workspace root), discovery with
`git ls-files` (the walk is used everywhere for now), the read-only tools a model can call
(`read_file`, `search_text`, `list_files`, `get_outline`) and parser-based outlines (ADR 0009).

```ts
import { buildContext } from "@devflow-ai/context";
import { PathGuard, SecretRedactor } from "@devflow-ai/core";

const pack = await buildContext({
  guard: await PathGuard.create(process.cwd()),
  task, // a TaskContract
  redactor: new SecretRedactor(),
  trusted: false,
});
for (const file of pack.files) console.log(file.mode, file.path, file.reasons.join("; "));
```
