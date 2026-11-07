import { z } from "zod";

/**
 * Structured output helpers.
 *
 * The gateway asks providers for JSON that matches a JSON Schema generated from the step's Zod
 * schema, then validates the answer with Zod itself: the JSON Schema guides the model, Zod
 * decides (ADR 0006, ADR 0011).
 */

/** JSON Schema (draft 2020-12) of a Zod schema's output type. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "throw",
  });
  const { $schema, ...rest } = generated as Record<string, unknown>;
  return rest;
}

const UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
] as const;

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/**
 * Rewrites a JSON Schema into the subset that strict structured-output modes accept:
 * every object closed (`additionalProperties: false`), and value constraints (lengths,
 * ranges, patterns, item counts, unknown formats) removed from the schema and restated in the
 * description so the model still sees them. Validation of those constraints happens in the
 * gateway with Zod.
 */
export function strictJsonSchema(
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return rewrite(schema) as Record<string, unknown>;
}

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite);
  if (node === null || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const moved: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
      moved.push(`${key}: ${JSON.stringify(value)}`);
    } else if (key === "format" && typeof value === "string" && !SUPPORTED_FORMATS.has(value)) {
      moved.push(`format: ${value}`);
    } else if (key === "properties" || key === "$defs" || key === "definitions") {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, child]) => [
          name,
          rewrite(child),
        ]),
      );
    } else {
      out[key] = rewrite(value);
    }
  }
  if (source.type === "object" || "properties" in source) {
    out.additionalProperties = false;
  }
  if (moved.length > 0) {
    const note = `(${moved.join(", ")})`;
    out.description =
      typeof out.description === "string" && out.description.length > 0
        ? `${out.description} ${note}`
        : note;
  }
  return out;
}

export type JsonExtraction =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/**
 * Parses the JSON value in a model answer. Accepts bare JSON, JSON in a Markdown code fence,
 * and JSON surrounded by a little prose (the outermost `{...}` is used).
 */
export function extractJson(text: string): JsonExtraction {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.unshift(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first > 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  let lastError = "empty answer";
  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch (error) {
      lastError = (error as Error).message;
    }
  }
  return { ok: false, error: `the answer is not valid JSON: ${lastError}` };
}

/** Readable validation issues, one per line, capped so a repair prompt stays small. */
export function describeIssues(error: z.ZodError, max = 20): string[] {
  const lines = error.issues.slice(0, max).map((issue) => {
    const where = issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
    return `${where}: ${issue.message}`;
  });
  if (error.issues.length > max) lines.push(`... and ${error.issues.length - max} more`);
  return lines;
}
