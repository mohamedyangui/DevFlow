import type { ContractKind } from "@devflow/core";
import { OpenApiDocument, isObject } from "./openapi/document.js";
import { OpenApiComparison } from "./openapi/diff.js";
import { ProtobufComparison } from "./protobuf/diff.js";
import { ProtoParseError, type ProtoFile, parseProto } from "./protobuf/parse.js";
import { type ContractChange, ContractDiff, type ContractDecider, summarize } from "./schemas.js";
import { type ContractToolset, runContractTool } from "./tools.js";

/**
 * Compares two versions of a contract file (ADR 0021): `oasdiff` or `buf` when they are
 * installed and allowed, the built-in rules otherwise. The result is deterministic and never
 * comes from a model.
 */

export interface CompareInput {
  /** The file, for locations and messages (repository-relative in review mode). */
  readonly file: string;
  /** The contract kind; detected from the file name and content when omitted. */
  readonly kind?: ContractKind | undefined;
  /** The base version's text, or null when the file does not exist in it. */
  readonly base: string | null;
  /** The head version's text, or null when the file does not exist in it. */
  readonly head: string | null;
}

export interface ToolInput {
  readonly toolset: ContractToolset;
  /** Workspace-relative paths of the two versions on disk, for the tool. */
  readonly basePath: string;
  readonly headPath: string;
}

const OPENAPI_NAME = /^(openapi|swagger)(\.[a-z0-9-]+)*\.(ya?ml|json)$/i;

/** Whether a YAML or JSON text is an OpenAPI or Swagger document (a top-level key). */
export function looksLikeOpenApi(text: string): boolean {
  return /^(?:openapi|swagger)\s*:|^\s*\{[\s\S]{0,200}?"(?:openapi|swagger)"\s*:/m.test(
    text.slice(0, 4096),
  );
}

/**
 * The contract kind of a file, the way context discovery classifies contracts (ADR 0017):
 * `.proto` files, and YAML or JSON files named `openapi.*`/`swagger.*` or with a top-level
 * `openapi:`/`swagger:` key. Null for anything else.
 */
export function contractKindOf(
  file: string,
  ...texts: readonly (string | null | undefined)[]
): ContractKind | null {
  const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  if (name.endsWith(".proto")) return "protobuf";
  if (!/\.(ya?ml|json)$/.test(name)) return null;
  if (OPENAPI_NAME.test(name)) return "openapi";
  return texts.some((text) => typeof text === "string" && looksLikeOpenApi(text))
    ? "openapi"
    : null;
}

/** Compares with the built-in rules only. */
export function compareContractBuiltin(input: CompareInput): ContractDiff {
  const kind = kindOf(input);
  const outcome = builtin(kind, input);
  return finish(kind, input, "builtin-rules", outcome.changes, outcome.notes);
}

/**
 * Compares with `oasdiff` or `buf` when `tools` is given, the tool is installed and the
 * command policy lets it run; with the built-in rules otherwise. The notes say why a tool
 * did not decide.
 */
export async function compareContract(
  input: CompareInput,
  tools?: ToolInput,
): Promise<ContractDiff> {
  const kind = kindOf(input);
  if (tools === undefined || input.base === null || input.head === null) {
    return compareContractBuiltin({ ...input, kind });
  }
  const tool = kind === "openapi" ? "oasdiff" : "buf";
  const notes: string[] = [];
  const external =
    kind === "openapi" ? [...externalRefs(input.base), ...externalRefs(input.head)] : [];
  if (external.length > 0) {
    notes.push(
      `oasdiff was not run: the documents have external references (${[...new Set(external)].slice(0, 5).join(", ")}), which it would fetch`,
    );
  } else {
    const run = await runContractTool(
      tool,
      { base: tools.basePath, head: tools.headPath, file: input.file },
      tools.toolset,
    );
    if (run.ran) {
      return finish(kind, input, `tool:${tool}`, run.changes, [
        `decided by ${tool} (${run.execution.argv.join(" ")})`,
      ]);
    }
    notes.push(`${tool} did not decide: ${run.reason}; the built-in rules were used`);
  }
  const outcome = builtin(kind, input);
  return finish(kind, input, "builtin-rules", outcome.changes, [...notes, ...outcome.notes]);
}

function kindOf(input: CompareInput): ContractKind {
  return input.kind ?? contractKindOf(input.file, input.base, input.head) ?? "openapi";
}

function finish(
  kind: ContractKind,
  input: CompareInput,
  decidedBy: ContractDecider,
  changes: readonly ContractChange[],
  notes: readonly string[],
): ContractDiff {
  return ContractDiff.parse({
    schemaVersion: 1,
    kind,
    file: input.file,
    base: input.base === null ? "absent" : "present",
    head: input.head === null ? "absent" : "present",
    decidedBy,
    changes,
    summary: summarize(changes),
    notes: [...new Set(notes)],
  });
}

function single(
  kind: ContractKind,
  file: string,
  rule: string,
  compatibility: ContractChange["compatibility"],
  message: string,
): ContractChange {
  return {
    kind,
    rule,
    compatibility,
    decidedBy: "builtin-rules",
    location: { file },
    message,
  };
}

function builtin(
  kind: ContractKind,
  input: CompareInput,
): { changes: ContractChange[]; notes: string[] } {
  const { base, head, file } = input;
  if (base === null && head === null) return { changes: [], notes: [] };
  if (base === null) {
    return {
      changes: [single(kind, file, "contract-added", "non-breaking", `${file} is a new contract`)],
      notes: [],
    };
  }
  if (head === null) {
    return {
      changes: [
        single(
          kind,
          file,
          "contract-removed",
          "breaking",
          `${file} was deleted: everything it declared is removed`,
        ),
      ],
      notes: [],
    };
  }
  return kind === "openapi" ? builtinOpenApi(file, base, head) : builtinProtobuf(file, base, head);
}

function builtinOpenApi(
  file: string,
  baseText: string,
  headText: string,
): { changes: ContractChange[]; notes: string[] } {
  const base = OpenApiDocument.parse(baseText);
  const head = OpenApiDocument.parse(headText);
  const unreadable = [
    "error" in base ? `the base version cannot be read: ${base.error}` : undefined,
    "error" in head ? `the head version cannot be read: ${head.error}` : undefined,
  ].filter((text) => text !== undefined);
  if (!("document" in base) || !("document" in head)) {
    return {
      changes: [
        single(
          "openapi",
          file,
          "unparseable",
          "unknown",
          `${unreadable.join("; ")}; compare it yourself`,
        ),
      ],
      notes: unreadable,
    };
  }
  const versions = [base.document, head.document].filter((document) => !document.supported);
  if (versions.length > 0) {
    const message = `the built-in rules support OpenAPI 3.x only, not ${versions.map((document) => document.version).join(" or ")}; compare it yourself`;
    return {
      changes: [single("openapi", file, "unsupported-version", "unknown", message)],
      notes: [message],
    };
  }
  const comparison = new OpenApiComparison(base.document, head.document, file).run();
  return { changes: comparison.changes, notes: comparison.notes };
}

function builtinProtobuf(
  file: string,
  baseText: string,
  headText: string,
): { changes: ContractChange[]; notes: string[] } {
  const read = (text: string, which: string): ProtoFile | string => {
    try {
      return parseProto(text);
    } catch (error) {
      if (error instanceof ProtoParseError) {
        return `the ${which} version cannot be read: ${error.message}`;
      }
      throw error;
    }
  };
  const base = read(baseText, "base");
  const head = read(headText, "head");
  if (typeof base === "string" || typeof head === "string") {
    const reasons = [base, head].filter((side) => typeof side === "string");
    return {
      changes: [
        single(
          "protobuf",
          file,
          "unparseable",
          "unknown",
          `${reasons.join("; ")}; compare it yourself`,
        ),
      ],
      notes: reasons,
    };
  }
  const notes = [base, head]
    .filter((side) => side.syntax.startsWith("editions:"))
    .map(
      (side) =>
        `${side.syntax.replace("editions:", "edition ")}: field presence features are not read; presence changes are not compared`,
    );
  const comparison = new ProtobufComparison(base, head, file).run();
  return { changes: comparison.changes, notes: [...notes, ...comparison.notes] };
}

/** The `$ref`s of a document that point outside it (files or URLs). */
export function externalRefs(text: string): string[] {
  const parsed = OpenApiDocument.parse(text);
  if (!("document" in parsed)) return [];
  const found: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 200 || found.length >= 100) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (isObject(value)) {
      if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) found.push(value.$ref);
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(parsed.document.root, 0);
  return found;
}
