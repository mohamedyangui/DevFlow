# @devflow-ai/mcp

DevFlow AI as Model Context Protocol tools
([ADR 0026](../../docs/adr/0026-mcp-server.md), [specification](../../docs/specs/mcp.md)):
an in-house MCP server over the stdio transport and the DevFlow tool definitions.

**Status: Phase 6.** Tested in-process and over real stdio with the built CLI; not yet
connected to a real MCP client.

## Use it from a coding agent

Build DevFlow (`pnpm install && pnpm build`), then configure the client to start
`node /absolute/path/to/DevFlow/packages/cli/dist/bin.js mcp`. For Claude Code:

```bash
claude mcp add devflow -- node /absolute/path/to/DevFlow/packages/cli/dist/bin.js mcp
```

See the [specification](../../docs/specs/mcp.md) for a `.mcp.json` example, Windows paths,
the tool list and the security model. Approvals (plans, tests, changes, trust, commands) are
not tools: the developer gives them in a terminal.

## API

```ts
import { McpServer, defineTool, devflowTools, serveStdio } from "@devflow-ai/mcp";

const server = new McpServer({
  name: "devflow",
  version: "0.0.0",
  tools: devflowTools({ run, defaultWorkspace: process.cwd() }),
  log: (message) => process.stderr.write(`${message}\n`),
});
await serveStdio(server, { input: process.stdin, output: process.stdout });
```

- `McpServer.receive(line)` handles one JSON-RPC message and returns the serialized response
  (or `undefined`): `initialize` with version negotiation (2025-06-18, 2025-03-26), `ping`,
  `tools/list`, `tools/call`, `notifications/cancelled`, and the standard error codes.
- `serveStdio` reads newline-delimited messages and writes only protocol messages to
  `output`.
- `defineTool` builds a tool from a Zod schema: the listing gets it as JSON Schema, and every
  call is validated against it (invalid arguments are a -32602 error).
- `devflowTools({ run })` defines the DevFlow tools on top of a `CommandRunner` that runs
  `devflow <args> --json` in a workspace; `devflow mcp` in `@devflow-ai/cli` supplies one that
  calls `runCli` in-process with captured output and no terminal.

The package depends on `zod` only; it has no workspace dependency.
