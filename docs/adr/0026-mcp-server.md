# ADR 0026: An in-house MCP server that exposes DevFlow as tools, with approvals kept by the developer

- **Status:** Accepted, 2026-11-11. Implemented in Phase 6 in `@devflowai/mcp` and
  `devflow mcp` (`packages/cli/src/commands/mcp.ts`).
- **Deciders:** Mohamed Yangui

## Context

Coding agents call external tools through the Model Context Protocol (MCP). Until now an agent
could use DevFlow only by running the CLI in a terminal, which depends on the agent being
allowed to run shell commands and on it parsing human-oriented output. DevFlow should be
usable as tools from such agents: validate a task, analyse and plan it, show a run's state,
read a report, run the verification gates, review a change, compare contracts.

Two constraints shape the design. First, DevFlow's value rests on decisions taken by a person:
plan, test and change approvals, workspace trust, command approvals, publishing. An agent that
calls DevFlow through MCP is the same agent whose work those decisions check; it must not be
able to take them. Second, the official MCP SDK would be a new runtime dependency with its own
transitive dependencies, for a protocol surface DevFlow needs only a small part of: tools over
stdio.

## Decision

1. **The protocol is implemented in-house** in `@devflowai/mcp` (dependency: `zod` only; no
   workspace dependency). It covers what a tools-only stdio server needs: JSON-RPC 2.0
   messages, newline-delimited on stdin and stdout; `initialize` with version negotiation
   (2025-06-18 and 2025-03-26: the client's version when supported, else the latest);
   `notifications/initialized`; `ping`; `tools/list`; `tools/call`; `notifications/cancelled`,
   which aborts the running command; the standard error codes (-32700, -32600, -32601,
   -32602, -32603); and batches, which 2025-03-26 allows. Resources, prompts, sampling,
   logging, pagination and the HTTP transport are not implemented.
2. **stdout carries protocol messages only.** Every diagnostic goes to stderr. Each tool runs
   a CLI command in-process with `--json`, with its own captured stdout and stderr, so no
   command output and no progress message can reach the protocol stream.
3. **Each tool is an existing CLI command.** The tools build an argument list for `runCli` and
   return its JSON outcome; there is no second implementation of any workflow. Option values
   are passed as `--name=value` and positional arguments after `--`, so a value sent by the
   client cannot be read as another option (`--publish`, `--allow`). Arguments are validated
   with Zod schemas, and the same schemas, converted to JSON Schema as core does for task
   files, are the tools' input schemas. Invalid arguments are a JSON-RPC -32602 error; a
   command that refuses (exit code 2) or cannot run is a tool result with `isError`.
4. **Exposed tools:** `devflow_task_validate`, `devflow_analyze`, `devflow_plan`,
   `devflow_answer`, `devflow_status`, `devflow_report`, `devflow_verify`, `devflow_review`,
   `devflow_contracts_diff`. A call may name its `workspace` (an absolute, existing
   directory); otherwise the server's working directory is used.
5. **Deliberately not exposed:** `trust`, `approve` and `reject` (plans, tests and changes),
   `resume`, `cancel`, `pr create`, `--publish`, `--allow`, `--run-fork-code`, plugin
   management and every interactive approval. Commands run without a terminal: no prompt is
   available, so nothing is approved interactively, and a command that is not already approved
   (trusted workspace and an "always" approval) is reported as a denial with its fingerprint.
   `devflow_verify` and `devflow_review` take no `--allow`: a fingerprint sent by the agent
   would be the agent approving its own command.
6. **Results say what the developer does next.** Each result has a summary, the next steps
   and the CLI's JSON outcome (run id, state, paths, denials). Every human decision is stated
   as a terminal command for the developer, for example `devflow approve <run>`,
   `devflow trust`, `devflow verify --allow <fingerprint>`. The text content carries the JSON
   as well, for clients without `structuredContent` (2025-03-26).
7. **Clarification answers can be relayed.** `devflow_answer` records answers to blocking
   questions, which feed the analysis but approve nothing: the plan written afterwards still
   waits for the developer's approval. Its description tells the agent to relay the
   developer's answers, never to invent them. Every decision made through the server is
   recorded as `<user> (via MCP)` (`DEVFLOW_USER` of the command), so the audit log tells
   them apart.
8. **Calls run one at a time** in arrival order: commands lock runs and write to the
   workspace. `ping` and cancellations are handled while a call runs.

## Consequences

- An agent can drive the analysis, planning, verification and review loop, but every
  approval, trust decision and publication still needs the developer in a terminal. A
  compromised or confused agent can start runs and spend model budget within the configured
  limits; it cannot approve plans, run unapproved commands or publish.
- The server is tested in-process and over real stdio with the built executable. It has not
  been tested against every MCP client; interoperability is limited to the protocol subset
  above.
- `devflow_task_validate`, `devflow_contracts_diff` and the other tools read files the CLI
  can read: the server runs with the developer's privileges, like the CLI.
- Protocol revisions after 2025-06-18 need an explicit update of the supported versions.

## Alternatives considered

- **The official MCP SDK.** Rejected for now: a new dependency tree for a small, stable
  subset, against the repository's practice of in-house protocol code where the surface is
  small (ADR 0018, ADR 0019).
- **Exposing approvals with a confirmation flag.** Rejected: the flag would be set by the
  agent being checked.
- **Running the CLI as a child process per call.** Rejected: slower, and it would need
  `child_process` outside the policy-gated launcher; in-process calls with an injected I/O
  give the same isolation of output.
