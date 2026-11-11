import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  MAX_MESSAGE_CHARS,
  McpServer,
  defineTool,
  serveStdio,
  type McpTool,
} from "../src/index.js";

/** A tool that echoes its argument, fails on request, or waits until it is cancelled. */
function echoTool(onAbort: (reason: string) => void = () => undefined): McpTool {
  return defineTool({
    name: "echo",
    title: "Echo",
    description: "Echoes a message.",
    input: z.strictObject({
      message: z.string().min(1).describe("What to echo."),
      fail: z.boolean().optional(),
      wait: z.boolean().optional(),
    }),
    annotations: { readOnlyHint: true },
    call: async (args, context) => {
      if (args.wait === true) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            onAbort("aborted");
            resolve();
          });
        });
      }
      return {
        text: `echo: ${args.message}`,
        structured: { message: args.message },
        isError: args.fail === true,
      };
    },
  });
}

function server(tools: McpTool[] = [echoTool()]): McpServer {
  return new McpServer({ name: "devflow", version: "1.2.3", tools });
}

type Json = Record<string, unknown>;

async function send(target: McpServer, message: unknown): Promise<Json | undefined> {
  const response = await target.receive(
    typeof message === "string" ? message : JSON.stringify(message),
  );
  return response === undefined ? undefined : (JSON.parse(response) as Json);
}

function initialize(id: number | string = 1, protocolVersion: unknown = "2025-06-18"): Json {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } },
  };
}

async function ready(protocolVersion = "2025-06-18"): Promise<McpServer> {
  const target = server();
  await send(target, initialize(0, protocolVersion));
  await send(target, { jsonrpc: "2.0", method: "notifications/initialized" });
  return target;
}

function call(id: number, args: unknown, name = "echo"): Json {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("initialize and version negotiation", () => {
  it("answers with serverInfo, the tools capability and the client's version when supported", async () => {
    const response = await send(server(), initialize(1, "2025-06-18"));
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "devflow", version: "1.2.3" },
      },
    });
  });

  it("accepts 2025-03-26", async () => {
    const response = await send(server(), initialize("a", "2025-03-26"));
    expect((response?.result as Json).protocolVersion).toBe("2025-03-26");
    expect(response?.id).toBe("a");
  });

  it("proposes its latest version when the client's is not supported", async () => {
    const response = await send(server(), initialize(1, "2024-11-05"));
    expect((response?.result as Json).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-06-18");
  });

  it("rejects an initialize without a protocol version", async () => {
    const response = await send(server(), initialize(1, 42));
    expect((response?.error as Json).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it("refuses tool requests before initialize, but answers ping", async () => {
    const target = server();
    const list = await send(target, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((list?.error as Json).code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(await send(target, { jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });
  });
});

describe("JSON-RPC errors", () => {
  it("answers unparseable JSON with a parse error and a null id", async () => {
    expect(await send(server(), "{not json")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });

  it.each([
    ["a non-object", 42],
    ["a missing jsonrpc version", { id: 1, method: "ping" }],
    ["a wrong jsonrpc version", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["a non-string method", { jsonrpc: "2.0", id: 1, method: 7 }],
    ["a null id", { jsonrpc: "2.0", id: null, method: "ping" }],
    ["an object id", { jsonrpc: "2.0", id: {}, method: "ping" }],
    ["no method", { jsonrpc: "2.0", id: 1 }],
  ])("answers %s with an invalid request error", async (_label, message) => {
    const response = await send(server(), message);
    expect((response?.error as Json).code).toBe(-32600);
  });

  it("keeps the id of an invalid request when it is valid", async () => {
    const response = await send(server(), { jsonrpc: "1.0", id: 9, method: "ping" });
    expect(response?.id).toBe(9);
  });

  it("answers an unknown method with method not found", async () => {
    const response = await send(await ready(), {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
    });
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found: resources/list" },
    });
  });

  it("answers non-object params with invalid params", async () => {
    const response = await send(await ready(), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: [1],
    });
    expect((response?.error as Json).code).toBe(-32602);
  });

  it("does not answer notifications, even unknown ones, nor responses", async () => {
    const target = await ready();
    expect(await send(target, { jsonrpc: "2.0", method: "notifications/whatever" })).toBe(
      undefined,
    );
    expect(await send(target, { jsonrpc: "2.0", id: 5, result: {} })).toBe(undefined);
  });

  it("answers a batch with an array, without the notifications", async () => {
    const target = await ready();
    const response = await target.receive(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "nope" },
      ]),
    );
    const parsed = JSON.parse(response ?? "") as Json[];
    expect(parsed.map((item) => item.id)).toEqual([1, 2]);
    expect(await send(target, [])).toMatchObject({ error: { code: -32600 } });
  });
});

describe("tools", () => {
  it("lists the tools with a JSON Schema generated from Zod", async () => {
    const response = await send(await ready(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response?.result).toEqual({
      tools: [
        {
          name: "echo",
          title: "Echo",
          description: "Echoes a message.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string", minLength: 1, description: "What to echo." },
              fail: { type: "boolean" },
              wait: { type: "boolean" },
            },
            required: ["message"],
            additionalProperties: false,
          },
        },
      ],
    });
  });

  it("returns text content, structuredContent and isError", async () => {
    const target = await ready();
    expect((await send(target, call(1, { message: "hi" })))?.result).toEqual({
      content: [{ type: "text", text: "echo: hi" }],
      structuredContent: { message: "hi" },
      isError: false,
    });
    expect((await send(target, call(2, { message: "hi", fail: true })))?.result).toMatchObject({
      isError: true,
    });
  });

  it("leaves structuredContent out for 2025-03-26 clients", async () => {
    const target = await ready("2025-03-26");
    const result = (await send(target, call(1, { message: "hi" })))?.result as Json;
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
  });

  it("answers an unknown tool with invalid params", async () => {
    const response = await send(await ready(), call(1, {}, "devflow_approve"));
    expect(response?.error).toEqual({ code: -32602, message: "Unknown tool: devflow_approve" });
  });

  it.each([
    ["a missing required argument", {}],
    ["a wrong type", { message: 3 }],
    ["an unknown argument", { message: "x", allow: "abc" }],
    ["non-object arguments", ["x"]],
  ])("answers %s with invalid params", async (_label, args) => {
    const response = await send(await ready(), call(1, args));
    expect((response?.error as Json).code).toBe(-32602);
  });

  it("answers a call without a tool name with invalid params", async () => {
    const response = await send(await ready(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {},
    });
    expect((response?.error as Json).code).toBe(-32602);
  });

  it("turns an exception in a tool into a tool error, and keeps serving", async () => {
    const logs: string[] = [];
    const broken = defineTool({
      name: "broken",
      title: "Broken",
      description: "Throws.",
      input: z.strictObject({}),
      annotations: {},
      call: () => Promise.reject(new Error("boom")),
    });
    const target = new McpServer({
      name: "devflow",
      version: "1",
      tools: [broken, echoTool()],
      log: (message) => logs.push(message),
    });
    await send(target, initialize());
    const failed = (await send(target, call(1, {}, "broken")))?.result as Json;
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("boom");
    expect(logs.join("\n")).toContain("boom");
    expect(((await send(target, call(2, { message: "ok" })))?.result as Json).isError).toBe(false);
  });

  it("aborts a cancelled call and sends no response for it", async () => {
    const aborted: string[] = [];
    const target = new McpServer({
      name: "devflow",
      version: "1",
      tools: [echoTool((reason) => aborted.push(reason))],
    });
    await send(target, initialize());
    const pending = send(target, call(7, { message: "slow", wait: true }));
    // ping is answered while the tool runs.
    expect(await send(target, { jsonrpc: "2.0", id: 8, method: "ping" })).toMatchObject({
      id: 8,
      result: {},
    });
    await send(target, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "user stopped it" },
    });
    expect(await pending).toBe(undefined);
    expect(aborted).toEqual(["aborted"]);
  });
});

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<string | Uint8Array> {
  for (const part of parts) {
    await Promise.resolve();
    yield part;
  }
}

async function serve(...parts: (string | Uint8Array)[]): Promise<{ lines: Json[]; raw: string }> {
  let raw = "";
  await serveStdio(server(), {
    input: chunks(...parts),
    output: {
      write: (text: string) => {
        raw += text;
      },
    },
  });
  return {
    raw,
    lines: raw
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Json),
  };
}

describe("stdio transport", () => {
  it("reads newline-delimited messages split across chunks, with CRLF and UTF-8 split mid-character", async () => {
    const init = JSON.stringify(initialize(1));
    const message = new TextEncoder().encode(
      `${JSON.stringify(call(2, { message: "héllo wörld" }))}\r\n`,
    );
    const { lines, raw } = await serve(
      init.slice(0, 10),
      `${init.slice(10)}\n\n`,
      message.slice(0, 50),
      message.slice(50, 51),
      message.slice(51),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    );
    // Messages are handled concurrently: a ping may be answered before a tool call.
    expect(lines.map((line) => line.id).sort()).toEqual([1, 2, 3]);
    const echoed = lines.find((line) => line.id === 2);
    expect((echoed?.result as Json).structuredContent).toEqual({ message: "héllo wörld" });
    // Every line is one JSON message: no embedded newline, nothing else on stdout.
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(3);
  });

  it("answers a bad line with a parse error and goes on", async () => {
    const { lines } = await serve(
      "garbage\n",
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
    );
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
  });

  it("skips a message that is too long", async () => {
    const huge = "x".repeat(MAX_MESSAGE_CHARS + 10);
    const { lines } = await serve(
      huge,
      "yyy\n",
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
    );
    expect(lines).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: message too long" },
      },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
  });
});
