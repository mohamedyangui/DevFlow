import { JsonRpcErrorCode, type McpServer } from "./server.js";

/** Messages longer than this are refused with a parse error and skipped. */
export const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;

export interface StdioTransport {
  /** The client's messages: the server's stdin. */
  readonly input: AsyncIterable<string | Uint8Array>;
  /** Protocol messages only: the server's stdout. */
  readonly output: { write(text: string): unknown };
  readonly log?: (message: string) => void;
}

/**
 * Serves an MCP server over the stdio transport: newline-delimited JSON-RPC messages, one per
 * line, in UTF-8. Only protocol messages are written to `output`; anything else belongs on
 * stderr. Messages are handled as they arrive (a `ping` or a cancellation is answered while a
 * tool runs). Resolves when the input ends and every pending response has been written.
 */
export async function serveStdio(server: McpServer, transport: StdioTransport): Promise<void> {
  const pending = new Set<Promise<void>>();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let skipping = false;

  const write = (response: string | undefined): void => {
    if (response !== undefined) transport.output.write(`${response}\n`);
  };
  const handle = (line: string): void => {
    const message = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (message.trim() === "") return;
    const done = server
      .receive(message)
      .then(write)
      .catch((error: unknown) => {
        transport.log?.(
          `cannot handle a message: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => pending.delete(done));
    pending.add(done);
  };
  const tooLong = (): void => {
    transport.log?.(`a message longer than ${String(MAX_MESSAGE_CHARS)} characters was skipped`);
    write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: JsonRpcErrorCode.ParseError, message: "Parse error: message too long" },
      }),
    );
  };

  for await (const chunk of transport.input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (skipping) skipping = false;
      else handle(line);
      newline = buffer.indexOf("\n");
    }
    if (!skipping && buffer.length > MAX_MESSAGE_CHARS) {
      tooLong();
      skipping = true;
    }
    if (skipping) buffer = "";
  }
  buffer += decoder.decode();
  if (!skipping) handle(buffer);
  while (pending.size > 0) await Promise.all(pending);
}
