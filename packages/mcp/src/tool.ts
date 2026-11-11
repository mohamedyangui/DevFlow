import { z } from "zod";

/** What a tool call returns: text for the model, the JSON outcome, and whether it is an error. */
export interface ToolResult {
  /** A readable summary for the calling agent; it also carries the JSON outcome. */
  readonly text: string;
  /** The JSON outcome, sent as `structuredContent` to clients that negotiated 2025-06-18. */
  readonly structured: Readonly<Record<string, unknown>>;
  /** A tool execution error (MCP `isError`): DevFlow refused the call or could not run it. */
  readonly isError: boolean;
}

export interface ToolContext {
  /** Aborted when the client cancels the request (`notifications/cancelled`). */
  readonly signal: AbortSignal;
}

/** Behaviour hints for clients (MCP tool annotations). They are hints, not guarantees. */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export type ToolInvocation =
  | { readonly kind: "result"; readonly result: ToolResult }
  | { readonly kind: "invalid-arguments"; readonly message: string };

/** A tool as the server sees it: its listing and a call that validates its own arguments. */
export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** JSON Schema of the arguments, generated from the tool's Zod schema. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
  invoke(args: unknown, context: ToolContext): Promise<ToolInvocation>;
}

export interface ToolSpec<Input extends z.ZodType<Record<string, unknown>>> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: Input;
  readonly annotations: ToolAnnotations;
  readonly call: (args: z.output<Input>, context: ToolContext) => Promise<ToolResult>;
}

/**
 * Defines a tool from a Zod schema: the listing gets the schema as JSON Schema (as core does
 * for task files), and every call is validated against it before the tool runs.
 */
export function defineTool<Input extends z.ZodType<Record<string, unknown>>>(
  spec: ToolSpec<Input>,
): McpTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: toolInputSchema(spec.input),
    annotations: spec.annotations,
    invoke: async (args, context) => {
      const parsed = spec.input.safeParse(args);
      if (!parsed.success) {
        return { kind: "invalid-arguments", message: describeIssues(parsed.error) };
      }
      return { kind: "result", result: await spec.call(parsed.data, context) };
    },
  };
}

/**
 * The JSON Schema of a tool's arguments. `$schema` is left out: several clients reject tool
 * schemas that carry it, and MCP does not require it.
 */
export function toolInputSchema(input: z.ZodType): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(input, { io: "input" });
  return schema;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map(
      (issue) =>
        `${issue.path.length === 0 ? "arguments" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}
