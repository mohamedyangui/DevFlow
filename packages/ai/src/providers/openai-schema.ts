import { strictJsonSchema } from "../structured.js";

/**
 * JSON Schemas for OpenAI's strict structured outputs.
 *
 * Strict mode needs every property of an object listed in `required` and accepts `anyOf` but
 * not `oneOf`. So, on top of {@link strictJsonSchema}, an optional property becomes required
 * and nullable, and the model answers `null` where it would have left the property out;
 * {@link dropOmittedNulls} turns those nulls back into absent properties before the gateway
 * validates the answer with the step's Zod schema.
 */

type Json = Record<string, unknown>;

const NULL_SCHEMA = { type: "null" } as const;

/** Keywords that strict mode rejects. Validation happens in the gateway with Zod. */
const DROPPED_KEYWORDS = new Set(["default", "examples", "$comment", "title"]);

export function openAiStrictSchema(schema: Readonly<Json>): Json {
  return rewrite(strictJsonSchema(schema)) as Json;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite);
  if (!isObject(node)) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "properties" || key === "$defs" || key === "definitions") {
      out[key] = Object.fromEntries(
        Object.entries(value as Json).map(([name, child]) => [name, rewrite(child)]),
      );
    } else {
      out[key === "oneOf" ? "anyOf" : key] = rewrite(value);
    }
  }
  if (isObject(out.properties)) {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const properties = out.properties;
    for (const name of Object.keys(properties)) {
      if (!required.has(name)) properties[name] = nullable(properties[name]);
    }
    out.required = Object.keys(properties);
  }
  return out;
}

function nullable(schema: unknown): unknown {
  if (!isObject(schema)) return { anyOf: [schema, NULL_SCHEMA] };
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as unknown[];
    const hasNull = branches.some((branch) => isObject(branch) && branch.type === "null");
    return hasNull ? schema : { ...schema, anyOf: [...branches, NULL_SCHEMA] };
  }
  const { description, ...rest } = schema;
  return {
    anyOf: [rest, NULL_SCHEMA],
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * Removes the properties that are `null` in `value` but optional in `schema` (the schema the
 * request was built from, before {@link openAiStrictSchema}). Follows `properties`, `items`,
 * `anyOf`/`oneOf` (the first object branch that has every key of the value) and local `$ref`s
 * into `$defs`. Values that do not fit the schema are left as they are: Zod reports them.
 */
export function dropOmittedNulls(value: unknown, schema: Readonly<Json>): unknown {
  return strip(value, schema, schema, 0);
}

const MAX_DEPTH = 64;

function acceptsNull(node: unknown, root: Readonly<Json>): boolean {
  const schema = resolve(node, root);
  if (schema === undefined) return false;
  const type = schema.type;
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  if (schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  const branches = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined;
  return branches?.some((branch) => acceptsNull(branch, root)) ?? false;
}

function resolve(node: unknown, root: Readonly<Json>): Json | undefined {
  if (!isObject(node)) return undefined;
  const ref = node.$ref;
  if (typeof ref === "string") {
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
    const defs = match === null ? undefined : root[match[1] ?? ""];
    const target = isObject(defs) ? defs[match?.[2] ?? ""] : undefined;
    return isObject(target) ? target : undefined;
  }
  return node;
}

function strip(value: unknown, node: unknown, root: Readonly<Json>, depth: number): unknown {
  const schema = resolve(node, root);
  if (schema === undefined || depth > MAX_DEPTH) return value;
  const branches = Array.isArray(schema.anyOf)
    ? (schema.anyOf as unknown[])
    : Array.isArray(schema.oneOf)
      ? (schema.oneOf as unknown[])
      : undefined;
  if (branches !== undefined) {
    if (isObject(value)) {
      const keys = Object.keys(value);
      const branch = branches
        .map((candidate) => resolve(candidate, root))
        .find(
          (candidate) =>
            candidate !== undefined &&
            isObject(candidate.properties) &&
            keys.every((key) => key in (candidate.properties as Json)),
        );
      return branch === undefined ? value : strip(value, branch, root, depth + 1);
    }
    if (Array.isArray(value)) {
      const branch = branches
        .map((candidate) => resolve(candidate, root))
        .find((candidate) => candidate?.items !== undefined);
      return branch === undefined ? value : strip(value, branch, root, depth + 1);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return schema.items === undefined
      ? value
      : value.map((item) => strip(item, schema.items, root, depth + 1));
  }
  if (isObject(value) && isObject(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const properties = schema.properties;
    const out: Json = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === null && key in properties && !required.has(key)) {
        // A property that also accepts null keeps it: there, null is an answer.
        if (!acceptsNull(properties[key], root)) continue;
      }
      out[key] = key in properties ? strip(child, properties[key], root, depth + 1) : child;
    }
    return out;
  }
  return value;
}
