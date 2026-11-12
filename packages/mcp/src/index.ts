/**
 * @devflow-ai/mcp: DevFlow as Model Context Protocol tools (ADR 0026). An in-house MCP server
 * (JSON-RPC 2.0 over the stdio transport) and the DevFlow tool definitions, which run the
 * CLI's commands through an injected runner. `devflow mcp` wires them to the CLI.
 */
export {
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcError,
  type JsonRpcResponse,
  type McpServerOptions,
  type RequestId,
} from "./server.js";
export { MAX_MESSAGE_CHARS, serveStdio, type StdioTransport } from "./stdio.js";
export {
  defineTool,
  toolInputSchema,
  type McpTool,
  type ToolAnnotations,
  type ToolContext,
  type ToolInvocation,
  type ToolResult,
  type ToolSpec,
} from "./tool.js";
export {
  DEVFLOW_TOOL_NAMES,
  MAX_EMBEDDED_REQUEST_CHARS,
  devflowTools,
  embeddable,
  type CommandResult,
  type CommandRunner,
  type DevflowToolsOptions,
} from "./devflow-tools.js";
export { guidanceFor, type Guidance } from "./next-steps.js";
