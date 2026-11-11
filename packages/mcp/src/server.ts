import type { McpTool, ToolResult } from "./tool.js";

/** Protocol revisions this server speaks, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 error codes used by the server. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type RequestId = string | number;

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: RequestId; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: RequestId | null; readonly error: JsonRpcError };

export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpTool[];
  /** Guidance for the client's model, sent in the `initialize` result. */
  readonly instructions?: string;
  /** Diagnostics; the stdio transport sends them to stderr, never to stdout. */
  readonly log?: (message: string) => void;
}

/** A JSON-RPC error raised while handling a request. */
class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * The MCP server: JSON-RPC 2.0 messages in, responses out, independent of the transport.
 * It implements the lifecycle (`initialize`, `notifications/initialized`), `ping`,
 * `tools/list`, `tools/call` and `notifications/cancelled`. Tool calls run one at a time, in
 * the order they arrive; `ping` and cancellations are handled while a tool runs.
 */
export class McpServer {
  private readonly tools: ReadonlyMap<string, McpTool>;
  private protocolVersion: string | undefined;
  private readonly running = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: McpServerOptions) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  /** The protocol revision agreed with the client, once `initialize` was answered. */
  get negotiatedVersion(): string | undefined {
    return this.protocolVersion;
  }

  /**
   * Handles one message (a line of the stdio transport) and returns the serialized response,
   * or `undefined` when there is nothing to answer (notifications, responses, cancelled calls).
   */
  async receive(message: string): Promise<string | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return JSON.stringify(errorResponse(null, JsonRpcErrorCode.ParseError, "Parse error"));
    }
    if (Array.isArray(parsed)) {
      // JSON-RPC batches (allowed by 2025-03-26, removed in 2025-06-18).
      if (parsed.length === 0) {
        return JSON.stringify(
          errorResponse(null, JsonRpcErrorCode.InvalidRequest, "Invalid Request: empty batch"),
        );
      }
      const responses = (await Promise.all(parsed.map((item) => this.dispatch(item)))).filter(
        (response) => response !== undefined,
      );
      return responses.length === 0 ? undefined : JSON.stringify(responses);
    }
    const response = await this.dispatch(parsed);
    return response === undefined ? undefined : JSON.stringify(response);
  }

  private async dispatch(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isObject(message)) {
      return errorResponse(null, JsonRpcErrorCode.InvalidRequest, "Invalid Request");
    }
    const hasId = "id" in message;
    const id = hasId && isRequestId(message.id) ? message.id : null;
    if (!("method" in message)) {
      // A response to a request: this server sends none, so there is nothing to match.
      if ("result" in message || "error" in message) return undefined;
      return errorResponse(id, JsonRpcErrorCode.InvalidRequest, "Invalid Request");
    }
    const method = message.method;
    if (message.jsonrpc !== "2.0" || typeof method !== "string" || (hasId && id === null)) {
      return errorResponse(id, JsonRpcErrorCode.InvalidRequest, "Invalid Request");
    }
    const params = message.params;
    if (params !== undefined && !isObject(params)) {
      if (!hasId) return undefined;
      return errorResponse(
        id,
        JsonRpcErrorCode.InvalidParams,
        "Invalid params: params must be an object",
      );
    }
    if (id === null) {
      this.notify(method, params ?? {});
      return undefined;
    }
    try {
      const result = await this.request(id, method, params ?? {});
      if (result === CANCELLED) return undefined;
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (error instanceof RpcFailure) {
        return errorResponse(id, error.code, error.message, error.data);
      }
      this.log(
        `internal error in ${method}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      return errorResponse(id, JsonRpcErrorCode.InternalError, "Internal error");
    }
  }

  private notify(method: string, params: JsonObject): void {
    switch (method) {
      case "notifications/cancelled": {
        const requestId = params.requestId;
        if (!isRequestId(requestId)) return;
        const controller = this.running.get(key(requestId));
        if (controller === undefined) return;
        this.log(
          `request ${String(requestId)} cancelled by the client` +
            (typeof params.reason === "string" ? `: ${params.reason}` : ""),
        );
        controller.abort();
        return;
      }
      case "notifications/initialized":
      default:
        // Other notifications (initialized, progress, roots changes) need no action.
        return;
    }
  }

  private async request(id: RequestId, method: string, params: JsonObject): Promise<unknown> {
    if (method === "initialize") return this.initialize(params);
    if (method === "ping") return {};
    if (method !== "tools/list" && method !== "tools/call") {
      throw new RpcFailure(JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
    if (this.protocolVersion === undefined) {
      throw new RpcFailure(
        JsonRpcErrorCode.InvalidRequest,
        "The server is not initialized: send initialize first",
      );
    }
    if (method === "tools/list") {
      return {
        tools: [...this.tools.values()].map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
      };
    }
    return this.callTool(id, params);
  }

  private initialize(params: JsonObject): unknown {
    const requested = params.protocolVersion;
    if (typeof requested !== "string") {
      throw new RpcFailure(
        JsonRpcErrorCode.InvalidParams,
        "Invalid params: protocolVersion must be a string",
      );
    }
    const supported: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;
    this.protocolVersion = supported.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion: this.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.options.name, version: this.options.version },
      ...(this.options.instructions === undefined
        ? {}
        : { instructions: this.options.instructions }),
    };
  }

  private async callTool(id: RequestId, params: JsonObject): Promise<unknown> {
    const name = params.name;
    if (typeof name !== "string") {
      throw new RpcFailure(JsonRpcErrorCode.InvalidParams, "Invalid params: name must be a string");
    }
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new RpcFailure(JsonRpcErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    const args = params.arguments ?? {};
    if (!isObject(args)) {
      throw new RpcFailure(
        JsonRpcErrorCode.InvalidParams,
        "Invalid params: arguments must be an object",
      );
    }
    const requestKey = key(id);
    if (this.running.has(requestKey)) {
      throw new RpcFailure(
        JsonRpcErrorCode.InvalidRequest,
        `Request id ${String(id)} is already in use`,
      );
    }
    const controller = new AbortController();
    this.running.set(requestKey, controller);
    try {
      // One tool call at a time: DevFlow commands lock runs and write to the workspace.
      const turn = this.queue.then(async () => {
        if (controller.signal.aborted) return CANCELLED;
        return tool.invoke(args, { signal: controller.signal });
      });
      this.queue = turn.catch(() => undefined);
      const invocation = await turn.catch((error: unknown) => {
        this.log(
          `tool ${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        return {
          kind: "result",
          result: {
            text: `DevFlow could not complete ${name}: an internal error occurred (details are in the server log).`,
            structured: { error: { code: "INTERNAL_ERROR", message: "internal error" } },
            isError: true,
          },
        } as const;
      });
      if (invocation === CANCELLED || controller.signal.aborted) return CANCELLED;
      if (invocation.kind === "invalid-arguments") {
        throw new RpcFailure(
          JsonRpcErrorCode.InvalidParams,
          `Invalid arguments for ${name}: ${invocation.message}`,
        );
      }
      return this.toolResult(invocation.result);
    } finally {
      this.running.delete(requestKey);
    }
  }

  private toolResult(result: ToolResult): unknown {
    return {
      content: [{ type: "text", text: result.text }],
      // structuredContent exists from 2025-06-18; older clients read the text content.
      ...(this.protocolVersion === "2025-03-26" ? {} : { structuredContent: result.structured }),
      isError: result.isError,
    };
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

const CANCELLED = Symbol("cancelled");

function key(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function errorResponse(
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
