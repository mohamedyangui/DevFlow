# Specification: DevFlow as MCP tools

- **Status:** Phase 6, agent mode in Phase 7. `devflow mcp` serves the DevFlow tools over the
  MCP stdio transport ([ADR 0026](../adr/0026-mcp-server.md)); in agent mode the calling agent
  answers DevFlow's model requests ([ADR 0027](../adr/0027-agent-mode.md)). It is tested
  in-process and over real stdio with the built executable; see
  [What is validated](#7-what-is-validated).

`devflow mcp` lets a coding agent (an MCP client) call DevFlow as tools: validate tasks,
analyse and plan them, write and run tests, implement them test-first, follow runs, read
reports, run approved verification gates, review a change and compare contracts. **The agent
never approves anything**: plans, tests, code changes, workspace trust and commands are
approved by the developer in a terminal.

**No API key is needed.** By default the server runs in agent mode: when DevFlow needs a model
(analysis, plan, tests, code change, review), the run stops and the tool result contains the
request (`agentRequest`). The agent does what it asks, answers with `devflow_agent_respond`,
and the run continues. DevFlow checks the answer like any model's output (schema, repairs,
red and green runs, approvals). `devflow mcp --provider anthropic` (or `openai`, or `config`
for `ai.provider` of the configuration) uses an API provider instead.

## 1. Setup

DevFlow is not published to npm yet. Build it from a clone:

```bash
git clone https://github.com/mohamedyangui/DevFlow.git
cd DevFlow
pnpm install
pnpm build
```

The server command is then:

```text
node /absolute/path/to/DevFlow/packages/cli/dist/bin.js mcp
```

The server works in the directory it is started in (the MCP client usually starts it in the
project's root); each tool also takes a `workspace` argument, an absolute path.

### Generic MCP client configuration

Any client that launches stdio servers needs the command `node` and the arguments
`["/absolute/path/to/DevFlow/packages/cli/dist/bin.js", "mcp"]`.

### `.mcp.json` (project-scoped configuration)

```json
{
  "mcpServers": {
    "devflow": {
      "command": "node",
      "args": ["/absolute/path/to/DevFlow/packages/cli/dist/bin.js", "mcp"]
    }
  }
}
```

On Windows, write the path with forward slashes or escaped backslashes:
`"C:/path/to/DevFlow/packages/cli/dist/bin.js"` or
`"C:\\path\\to\\DevFlow\\packages\\cli\\dist\\bin.js"`.

### Claude Code

```bash
claude mcp add devflow -- node /absolute/path/to/DevFlow/packages/cli/dist/bin.js mcp
```

On Windows:

```powershell
claude mcp add devflow -- node C:\path\to\DevFlow\packages\cli\dist\bin.js mcp
```

### Codex

Codex reads MCP servers from `~/.codex/config.toml` (not tested with Codex yet):

```toml
[mcp_servers.devflow]
command = "node"
args = ["/absolute/path/to/DevFlow/packages/cli/dist/bin.js", "mcp"]
```

### A `devflow` command on PATH

`packages/cli/package.json` declares the `devflow` binary. From the clone, after `pnpm build`:

```bash
cd packages/cli
npm link             # or: pnpm link --global
```

Both were checked on Windows without network access: `npm link` creates a `devflow` shim in
npm's global prefix, and `pnpm link --global` one in `PNPM_HOME` (which `pnpm setup` adds to
PATH). `devflow --version` worked through both shims, and `devflow mcp` answered a `ping`
through the npm one. The filtered form
`pnpm --filter @devflow/cli link --global` is refused by pnpm 10 ("Unknown option:
recursive"). For MCP client configurations, prefer the `node .../bin.js mcp` form: it does
not depend on PATH or on how the client starts `.cmd` shims on Windows (not tested).

## 2. Tools

| Tool                     | Runs                                  | Writes                                  |
| ------------------------ | ------------------------------------- | --------------------------------------- |
| `devflow_task_validate`  | `devflow task validate <path> --json` | nothing                                 |
| `devflow_analyze`        | `devflow analyze --json`              | the run directory under `.devflow/runs` |
| `devflow_plan`           | `devflow plan --json`                 | the run directory                       |
| `devflow_answer`         | `devflow answer <run> --json`         | the run directory                       |
| `devflow_status`         | `devflow status [run] --json`         | nothing                                 |
| `devflow_report`         | `devflow report <run> --json`         | nothing (never publishes)               |
| `devflow_verify`         | `devflow verify --json`               | `.devflow/runs/verify/...`              |
| `devflow_review`         | `devflow review --json`               | the run directory                       |
| `devflow_contracts_diff` | `devflow contracts diff --json`       | nothing                                 |
| `devflow_test`           | `devflow test --json`                 | the run directory, test files           |
| `devflow_implement`      | `devflow implement --json`            | the run directory, then the change      |
| `devflow_agent_request`  | `devflow agent show <run> --json`     | nothing                                 |
| `devflow_agent_respond`  | `devflow agent answer <run> --json`   | `.devflow/agent`, then the run          |

`devflow_test` and `devflow_implement` write test files and the code change only after the
developer approved them in a terminal (`devflow approve <run>`).

Arguments (JSON Schema in `tools/list`, generated from Zod; unknown arguments are refused):

- every tool: `workspace` (optional, absolute path of an existing directory);
- `devflow_task_validate`: `path`, `strict`;
- `devflow_analyze`, `devflow_plan`: exactly one of `task` (file) or `issue` (GitHub issue),
  `repo`, `provider`, `model`, `cassette`, `maxInputTokens`, `maxOutputTokens`,
  `maxCallsPerStep`;
- `devflow_answer`: `run`, `answers` (question id to text), and the model options;
- `devflow_status`: `run` (optional); `devflow_report`: `run`;
- `devflow_verify`: `gates`, `baseline`, `backend`;
- `devflow_review`: `task` or `issue`, `repo`, `base` or `pr`, `backend`, the model options;
- `devflow_contracts_diff`: `files`, `base`, `kind`;
- `devflow_test`, `devflow_implement`: `task` or `issue`, `repo`, `backend`, the model options;
- `devflow_agent_request`: `run`; `devflow_agent_respond`: `run`, `requestId`, `answer` (one
  JSON value when the request has a schema, else text).

Workflow tools without `provider` use the server's provider: `agent` unless
`devflow mcp --provider` says otherwise.

### Agent mode

A run in agent mode stops at each model request with `AGENT_INPUT_REQUIRED` (status
`interrupted`, exit code 3). The tool result then has `agentRequest`, the output of
`devflow agent show <run> --json`:

```json
{
  "runId": "...",
  "state": "REQUIREMENTS_ANALYSIS",
  "requestId": "64 hex digits",
  "instructions": "...",
  "system": "...",
  "messages": [{ "role": "user", "content": "..." }],
  "format": "requirements_analysis",
  "jsonSchema": { "type": "object" }
}
```

The agent answers with `devflow_agent_respond` (`run`, `requestId`, `answer`). The result is
the run's next state: another `agentRequest`, a wait for the developer (an approval, a
clarification), or the end of the run. An answer that does not match the schema is followed
by a repair request. A run started in agent mode stays in agent mode: after the developer
approves in a terminal, the run continues until it needs the agent again, and
`devflow_status` shows the request it waits for.

Each result has a text content (a summary, the next steps and the JSON) and, for clients
that negotiated 2025-06-18, `structuredContent`:

```json
{
  "workspace": "/abs/path",
  "exitCode": 3,
  "summary": "Run 2026-11-11T10-00-00Z_TASK-7: AWAITING_PLAN_APPROVAL.",
  "nextSteps": [
    "The plan (...) must be reviewed and approved by the developer in a terminal: devflow approve 2026-11-11T10-00-00Z_TASK-7 ..."
  ],
  "result": { "runId": "...", "status": "waiting", "waitingFor": "plan-approval" }
}
```

`result` is exactly the command's `--json` output ([CLI specification](cli.md)); `exitCode`
is the command's [exit code](cli.md#2-exit-codes). `isError` is true when the command refused
the call (exit code 2), failed internally, or produced no JSON; a negative outcome (an invalid
task, a failed gate, a breaking change, a run waiting for the developer) is a normal result.

## 3. Not exposed

`trust`, `approve`, `reject`, `resume`, `cancel`, `pr create`, `--publish`, `--allow`,
`--run-fork-code`, plugin management and every interactive approval. The developer runs them
in a terminal. The tool results name the exact command, for example:

- a plan waits: `devflow approve <run>` or `devflow reject <run> --feedback "..."`;
- the workspace is not trusted: `devflow trust`;
- a gate command is not approved: `devflow verify --allow <fingerprint>` or
  `devflow resume <run> --allow <fingerprint>`, after reviewing the command shown;
- a budget is reached: `devflow resume <run> --max-input-tokens <n> ...`.

## 4. Security model

- **Approvals stay with the developer.** The commands run without a terminal, so no prompt is
  shown and nothing is approved interactively; `--allow` cannot be passed. Gate commands run
  only when the workspace is trusted and the command was approved "always" earlier, by the
  developer. The [command policy](security-model.md#4-command-policy) is unchanged.
- **Answers are attributed.** Decisions made through the server (answers to clarification
  questions) are recorded as `<user> (via MCP)`. Relaying the developer's answers is the
  agent's job; the tool description tells it never to invent them. The plan that follows
  still needs the developer's approval.
- **No option injection.** Values are passed as `--name=value` and positional arguments
  after `--`; arguments are validated against strict schemas (no unknown keys, no NUL).
- **stdout is the protocol.** All logs and command diagnostics go to stderr.
- **Same privileges as the CLI.** The server reads what the developer's account can read and,
  outside agent mode, calls the model provider named by the server or the call, within the
  run budgets.
- **Agent answers are model output.** In agent mode the agent writes the analysis, plan,
  tests and change; DevFlow validates them as it does a model's and records the provider
  `agent`. The request text comes from the task and the repository: the tool descriptions
  tell the agent to treat it as data.

## 5. Protocol

JSON-RPC 2.0, one message per line on stdin and stdout (UTF-8, `\n` or `\r\n`). Supported
protocol versions: `2025-06-18` and `2025-03-26`; the server answers with the client's version
when it supports it, otherwise with `2025-06-18`. Methods: `initialize`, `ping`, `tools/list`,
`tools/call`; notifications: `notifications/initialized`, `notifications/cancelled` (aborts
the running command; no response is sent for it). Errors: -32700 (parse error, also for a
message over 16 MiB), -32600 (invalid request, or a tool request before `initialize`), -32601
(method not found), -32602 (invalid params, unknown tool, invalid arguments), -32603 (internal
error). Batches are accepted. Tool calls run one at a time; `ping` is answered while a call
runs. The server exits when stdin closes.

## 6. Example session

```text
-> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"client","version":"1"}}}
<- {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"devflow","version":"0.0.0"},"instructions":"..."}}
-> {"jsonrpc":"2.0","method":"notifications/initialized"}
-> {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"devflow_task_validate","arguments":{"path":"examples/tasks/add-pagination.task.yaml"}}}
<- {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"examples/tasks/add-pagination.task.yaml is valid ..."}],"structuredContent":{...},"isError":false}}
```

## 7. What is validated

- Unit tests of the JSON-RPC layer: framing (chunks, CRLF, UTF-8 split across chunks, long
  messages), every error code, version negotiation, batches, cancellation, unknown tools and
  invalid arguments (`packages/mcp/test`).
- Tool tests through the server with the real command line and a scripted model
  (`packages/cli/test/mcp.test.ts`): task validation of the example tasks, a plan that waits
  for approval, status and report, relayed answers, and verify refusing to run a command that
  is not trusted or not approved; the approval tools are absent from `tools/list`.
- Agent mode (`packages/cli/test/mcp.test.ts`, `packages/cli/test/agent.test.ts`,
  `packages/workflow/test/implement-mode.test.ts`, `packages/ai/test/agent.test.ts`): a
  scripted model plays the agent; a plan through `devflow mcp` with no provider and no model
  id, a full implement run (plan, tests, red, change, green, verified) with no budget used,
  repairs, and refused answers (wrong request, not JSON, empty, too long).
- An end-to-end test that starts the built `node packages/cli/dist/bin.js mcp` as a child
  process and runs `initialize`, `tools/list` and `tools/call devflow_task_validate` over
  real stdio (`tests/e2e/mcp-stdio.test.ts`).

**Not validated:** the server has not been connected to a real MCP client (no coding agent,
IDE or inspector), and no real model was called through it. Agent mode has not been used by a
real coding agent. Client-specific behaviour
(timeouts, how a client starts the command on Windows, how it shows `structuredContent`) is
untested.
