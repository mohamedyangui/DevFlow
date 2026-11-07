import { parse as parseYaml } from "yaml";
import type { OpenApiSummary, ProtobufSummary } from "./schemas.js";

/**
 * Read-only contract discovery (ADR 0017). Nothing here runs `protoc`, `buf` or a generator;
 * the scanners extract names so that ranking can connect a task to the contracts it mentions.
 */

const MAX_NAMES = 500;

/** Removes `//` and `/* *\/` comments while keeping string literals and line numbers. */
function stripProtoComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, i + 1);
      const stop = end === -1 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop;
    } else if (char === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const block = text.slice(i, end === -1 ? text.length : end + 2);
      out += block.replace(/[^\n]/g, " ");
      i = end === -1 ? text.length : end + 2;
    } else {
      out += text.charAt(i);
      i += 1;
    }
  }
  return out;
}

/** Extracts the declarations of a `.proto` file. Nested messages are not listed. */
export function scanProtobuf(path: string, text: string): ProtobufSummary {
  const source = stripProtoComments(text);
  const first = (pattern: RegExp): string | null => pattern.exec(source)?.[1] ?? null;
  const all = (pattern: RegExp): string[] =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? "").filter((v) => v !== "");

  const topLevel = (keyword: string): string[] => {
    const names: string[] = [];
    let depth = 0;
    const token = /[{}]|\b(message|enum|service)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const match of source.matchAll(token)) {
      if (match[0] === "{") depth += 1;
      else if (match[0] === "}") depth = Math.max(0, depth - 1);
      else if (depth === 0 && match[1] === keyword && match[2] !== undefined) names.push(match[2]);
    }
    return names.slice(0, MAX_NAMES);
  };

  return {
    kind: "protobuf",
    path,
    syntax: first(/\bsyntax\s*=\s*["']([^"']+)["']/),
    package: first(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/m),
    imports: all(/^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']/gm).slice(0, MAX_NAMES),
    javaPackage: first(/\boption\s+java_package\s*=\s*["']([^"']+)["']/),
    javaOuterClassname: first(/\boption\s+java_outer_classname\s*=\s*["']([^"']+)["']/),
    messages: topLevel("message"),
    enums: topLevel("enum"),
    services: topLevel("service"),
  };
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Whether a YAML or JSON text is an OpenAPI or Swagger document (a top-level key). */
export function looksLikeOpenApi(text: string): boolean {
  return /^(?:openapi|swagger)\s*:|^\s*\{[\s\S]{0,200}?"(?:openapi|swagger)"\s*:/m.test(
    text.slice(0, 4096),
  );
}

/** Extracts title, paths and operation ids of an OpenAPI document, or null if it is not one. */
export function scanOpenApi(path: string, text: string): OpenApiSummary | null {
  let document: unknown;
  try {
    document = parseYaml(text, { maxAliasCount: 50, uniqueKeys: false });
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  const root = document as Record<string, unknown>;
  const version = root.openapi ?? root.swagger;
  if (typeof version !== "string" && typeof version !== "number") return null;

  const info = root.info;
  const title =
    typeof info === "object" &&
    info !== null &&
    typeof (info as { title?: unknown }).title === "string"
      ? (info as { title: string }).title
      : null;
  const paths: string[] = [];
  const operationIds: string[] = [];
  const pathItems = root.paths;
  if (typeof pathItems === "object" && pathItems !== null) {
    for (const [route, item] of Object.entries(pathItems as Record<string, unknown>)) {
      if (paths.length >= MAX_NAMES) break;
      paths.push(route);
      if (typeof item !== "object" || item === null) continue;
      for (const method of HTTP_METHODS) {
        const operation = (item as Record<string, unknown>)[method];
        if (typeof operation !== "object" || operation === null) continue;
        const id = (operation as { operationId?: unknown }).operationId;
        if (typeof id === "string" && operationIds.length < MAX_NAMES) operationIds.push(id);
      }
    }
  }
  return {
    kind: "openapi",
    path,
    specVersion: String(version),
    title,
    paths,
    operationIds,
  };
}
