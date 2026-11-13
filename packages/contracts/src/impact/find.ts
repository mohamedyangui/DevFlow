import {
  type ConsumerConfidence,
  type ConsumerMechanism,
  ConsumerRef,
  ContractImpact,
  type ModuleProfile,
  type SourceImport,
} from "@devflowai/core";
import { OpenApiDocument, isObject, operationKey } from "../openapi/document.js";
import { ProtoParseError, type ProtoFile, parseProto } from "../protobuf/parse.js";
import type { ContractChange, ContractDiff } from "../schemas.js";
import {
  generatedImports,
  protoTarget,
  referencesDeclaration,
  type ProtoTarget,
} from "./protobuf.js";
import {
  type HttpEndpoint,
  type ScannedFile,
  type Segments,
  pathSegments,
  scanFile,
  showSegments,
} from "./scan.js";

/**
 * Cross-language change impact (ADR 0022): the code that consumes a changed contract,
 * found by documented, deterministic heuristics (never by a model).
 *
 * - OpenAPI: Spring `@*Mapping` handlers (class prefix plus method path), HTTP calls in
 *   TypeScript/JavaScript, Java/Kotlin and Python whose literal URL normalizes to the
 *   operation's path, and member calls named after the operation's `operationId`.
 * - Protobuf: imports of the code generated from the `.proto` file, in Java/Kotlin,
 *   TypeScript/JavaScript and Python, in files that also name the changed declaration.
 *
 * Every consumer says how it was found and whether the match is `exact` or a `pattern`.
 */

/** A source file of the repository, as the caller read it. */
export interface ConsumerSource {
  /** Repository-relative POSIX path. */
  readonly path: string;
  /** `java`, `kotlin`, `typescript`, `javascript`, `python`; other languages are not read. */
  readonly language: string | null;
  readonly text: string;
  /** Whether it is a test file; derived from the modules' test roots and names when omitted. */
  readonly test?: boolean | undefined;
  /** Whether it is generated code (never a consumer); derived from its path when omitted. */
  readonly generated?: boolean | undefined;
  /** Imports from a source parser (Java, TypeScript); regular expressions read them otherwise. */
  readonly imports?: readonly SourceImport[] | undefined;
}

/** What the finder reads. The caller decides which files (and enforces its path policy). */
export interface ConsumerRepository {
  readonly files: readonly ConsumerSource[];
  /**
   * Every version of each contract file (base and head) by path; operation ids and generated
   * names of a removed declaration come from the version that still has it. When a contract
   * is missing here, its text in `files` is used, if any.
   */
  readonly contracts?: ReadonlyMap<string, readonly string[]> | undefined;
}

/** Files larger than this are not read for consumers. */
const MAX_SOURCE_BYTES = 1024 * 1024;
/** Operation ids shorter than this are too generic to look for. */
const MIN_OPERATION_ID = 4;

const TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)src\/(test|it|integrationTest|testFixtures)\//,
  /(^|\/)(__tests__|tests?|spec|e2e)\//,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/,
  /(Test|Tests|IT|Spec)\.(java|kt)$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
];

const GENERATED_PATTERNS: readonly RegExp[] = [
  /(^|\/)(generated|generated-sources|generated-test-sources|gen)\//,
  /_pb2(_grpc)?\.py$/,
  /_(grpc_)?(web_)?pb\.(js|d\.ts|ts)$/,
  /\.generated\.[a-z]+$/,
];

/** What the consumers of one change were searched for. */
export interface ConsumerSearch {
  /** `GET /orders/{id}`, `shop.v1.Order (api/orders.proto)`, ... */
  readonly target: string;
  readonly consumers: ConsumerRef[];
}

interface OpenApiTarget {
  readonly method: string | undefined;
  readonly path: string;
  readonly segments: Segments;
  readonly operationIds: readonly string[];
}

/**
 * Finds the consumers of contract changes in a repository. The files are scanned once, on
 * first use; each change is then a lookup.
 */
export class ConsumerIndex {
  private scanned: ScannedFile[] | undefined;
  private readonly tests = new Set<string>();
  private readonly openApi = new Map<string, OpenApiDocument[]>();
  private readonly protos = new Map<string, ProtoFile[]>();

  constructor(
    private readonly repo: ConsumerRepository,
    private readonly modules: readonly ModuleProfile[] = [],
  ) {}

  /** The consumers of one change, sorted by path and line. */
  find(change: ContractChange): ConsumerSearch {
    return change.kind === "openapi" ? this.openApiConsumers(change) : this.protoConsumers(change);
  }

  // ---- OpenAPI -----------------------------------------------------------------------------

  private openApiConsumers(change: ContractChange): ConsumerSearch {
    const documents = this.openApiVersions(change.location.file);
    const { path, method } = change.location;
    const targets: OpenApiTarget[] = [];
    const add = (route: string, verb: string | undefined, operationIds: readonly string[]) => {
      const segments = pathSegments(route);
      if (segments === undefined) return;
      const key = `${verb ?? "*"} ${showSegments(segments)}`;
      const known = targets.find((t) => `${t.method ?? "*"} ${showSegments(t.segments)}` === key);
      if (known === undefined) targets.push({ method: verb, path: route, segments, operationIds });
    };
    if (path !== undefined) {
      const ids = new Set<string>();
      for (const document of documents) {
        for (const operation of document.operations) {
          const sameOperation =
            method === undefined
              ? operationKey("x", operation.path) === operationKey("x", path)
              : operation.key === operationKey(method, path);
          if (sameOperation && operation.operationId !== undefined) ids.add(operation.operationId);
        }
      }
      add(path, method, [...ids]);
    } else {
      // A change of the whole document (deleted, unreadable): every operation it had.
      for (const document of documents) {
        for (const operation of document.operations) {
          add(
            operation.path,
            operation.method,
            operation.operationId === undefined ? [] : [operation.operationId],
          );
        }
      }
    }
    const prefixes = serverPrefixes(documents);
    const found: ConsumerRef[] = [];
    for (const file of this.files()) {
      for (const target of targets) {
        for (const mapping of file.mappings) {
          const confidence = matchEndpoint(mapping, target, prefixes, false);
          if (confidence !== undefined) found.push(this.ref(file, mapping, confidence));
        }
        for (const call of file.calls) {
          const confidence = matchEndpoint(call, target, prefixes, true);
          if (confidence !== undefined) found.push(this.ref(file, call, confidence));
        }
        for (const id of target.operationIds) {
          if (id.length < MIN_OPERATION_ID) continue;
          for (const name of new Set([
            id,
            ...(file.language === "python" ? [snakeCase(id)] : []),
          ])) {
            const line = file.memberCalls.get(name);
            if (line === undefined) continue;
            found.push(
              this.make(
                file,
                "operation-id-call",
                line,
                `.${name}(...) (operationId ${id})`,
                "pattern",
              ),
            );
          }
        }
      }
    }
    const shown =
      path === undefined
        ? `every operation of ${change.location.file}`
        : `${method === undefined ? "" : `${method.toUpperCase()} `}${path}`;
    return { target: shown, consumers: finish(found) };
  }

  private ref(
    file: ScannedFile,
    endpoint: HttpEndpoint,
    confidence: ConsumerConfidence,
  ): ConsumerRef {
    const verb = endpoint.method?.toUpperCase() ?? "ANY";
    const base = endpoint.leadingHole ? "<base>" : "";
    return this.make(
      file,
      endpoint.mechanism,
      endpoint.line,
      `${endpoint.via} ${verb} ${base}${showSegments(endpoint.segments)}`,
      confidence,
    );
  }

  // ---- Protobuf ----------------------------------------------------------------------------

  private protoConsumers(change: ContractChange): ConsumerSearch {
    const versions = this.protoVersions(change.location.file);
    const target = protoTarget(change.location.file, versions);
    const declaration = declarationOf(change, target);
    const found: ConsumerRef[] = [];
    for (const file of this.files()) {
      const imports = generatedImports(target, file);
      if (imports.length === 0) continue;
      if (
        declaration !== undefined &&
        !referencesDeclaration(file, declaration, target.services.has(declaration))
      ) {
        continue;
      }
      for (const { ref, confidence } of imports) {
        found.push(this.make(file, "generated-import", ref.line, ref.shown, confidence));
      }
    }
    const qualified =
      declaration === undefined
        ? `every declaration of ${change.location.file}`
        : `${target.package === null ? "" : `${target.package}.`}${declaration} (${change.location.file})`;
    return { target: qualified, consumers: finish(found) };
  }

  // ---- Files -------------------------------------------------------------------------------

  private make(
    file: ScannedFile,
    mechanism: ConsumerMechanism,
    line: number,
    match: string,
    confidence: ConsumerConfidence,
  ): ConsumerRef {
    const test = this.tests.has(file.path);
    return {
      path: file.path,
      line,
      language: file.language,
      kind: test ? "test" : mechanism,
      ...(test ? { via: mechanism } : {}),
      match: match.length > 300 ? `${match.slice(0, 297)}...` : match,
      confidence,
    };
  }

  private files(): ScannedFile[] {
    if (this.scanned !== undefined) return this.scanned;
    const testRoots = this.modules.flatMap((module) =>
      module.testRoots.map((root) => (root === "." ? "" : `${root.replace(/\/$/, "")}/`)),
    );
    const scanned: ScannedFile[] = [];
    for (const source of this.repo.files) {
      if (source.language === null || source.text.length > MAX_SOURCE_BYTES) continue;
      const generated =
        source.generated ?? GENERATED_PATTERNS.some((pattern) => pattern.test(source.path));
      if (generated) continue;
      const file = scanFile(source.path, source.language, source.text, source.imports);
      if (file === undefined) continue;
      const test =
        source.test ??
        (testRoots.some((root) => root !== "" && source.path.startsWith(root)) ||
          TEST_PATTERNS.some((pattern) => pattern.test(source.path)));
      if (test) this.tests.add(source.path);
      scanned.push(file);
    }
    this.scanned = scanned.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return this.scanned;
  }

  private texts(file: string): readonly string[] {
    const given = this.repo.contracts?.get(file);
    if (given !== undefined) return given;
    const source = this.repo.files.find((entry) => entry.path === file);
    return source === undefined ? [] : [source.text];
  }

  private openApiVersions(file: string): OpenApiDocument[] {
    let documents = this.openApi.get(file);
    if (documents === undefined) {
      documents = this.texts(file).flatMap((text) => {
        const parsed = OpenApiDocument.parse(text);
        return "document" in parsed ? [parsed.document] : [];
      });
      this.openApi.set(file, documents);
    }
    return documents;
  }

  private protoVersions(file: string): ProtoFile[] {
    let versions = this.protos.get(file);
    if (versions === undefined) {
      versions = this.texts(file).flatMap((text) => {
        try {
          return [parseProto(text)];
        } catch (error) {
          if (error instanceof ProtoParseError) return [];
          throw error;
        }
      });
      this.protos.set(file, versions);
    }
    return versions;
  }
}

/** The consumers of one contract change (see {@link ConsumerIndex}). */
export function findConsumers(
  change: ContractChange,
  repo: ConsumerRepository,
  modules: readonly ModuleProfile[] = [],
): ConsumerRef[] {
  return new ConsumerIndex(repo, modules).find(change).consumers;
}

/** At most this many consumers are listed per change; the rest are counted. */
export const MAX_CONSUMERS_PER_CHANGE = 50;

/** The consumers of every breaking change of the diffs, one entry per change. */
export function contractImpact(
  diffs: readonly ContractDiff[],
  repo: ConsumerRepository | ConsumerIndex,
  modules: readonly ModuleProfile[] = [],
  limit = MAX_CONSUMERS_PER_CHANGE,
): ContractImpact[] {
  const index = repo instanceof ConsumerIndex ? repo : new ConsumerIndex(repo, modules);
  const out: ContractImpact[] = [];
  for (const diff of diffs) {
    for (const change of diff.changes) {
      if (change.compatibility !== "breaking") continue;
      const search = index.find(change);
      out.push(
        ContractImpact.parse({
          kind: change.kind,
          file: diff.file,
          rule: change.rule,
          message: change.message,
          target: search.target,
          consumers: search.consumers.slice(0, limit),
          omitted: Math.max(0, search.consumers.length - limit),
        }),
      );
    }
  }
  return out;
}

// ---- Matching ----------------------------------------------------------------------------

/**
 * Whether an endpoint of the code is the target operation:
 *
 * - the method must be equal, or unknown in the code (then the match is a pattern);
 * - the segments must be equal, `{}` matching `{}`; a client call's literal segment also
 *   matches a path variable, and its `{}` a literal segment (as a pattern); a Spring mapping
 *   must match exactly, segment for segment;
 * - leading segments of the code equal to an OpenAPI `servers` base path are ignored; any
 *   other difference in length is a suffix match, a pattern, when the shorter path has a
 *   literal segment;
 * - a base URL variable stripped from a client call makes it a pattern.
 */
export function matchEndpoint(
  endpoint: HttpEndpoint,
  target: { readonly method: string | undefined; readonly segments: Segments },
  serverPrefixes: readonly Segments[],
  client: boolean,
): ConsumerConfidence | undefined {
  if (endpoint.method !== undefined && target.method !== undefined) {
    if (endpoint.method !== target.method) return undefined;
  }
  let pattern =
    endpoint.method === undefined || target.method === undefined || endpoint.leadingHole;
  let code = endpoint.segments;
  const wanted = target.segments;
  if (code.length > wanted.length) {
    const extra = code.slice(0, code.length - wanted.length);
    const server = serverPrefixes.some(
      (prefix) => prefix.length === extra.length && prefix.every((s, i) => s === extra[i]),
    );
    if (!server) pattern = true;
    code = code.slice(extra.length);
  }
  let spec = wanted;
  if (spec.length > code.length) {
    spec = spec.slice(spec.length - code.length);
    pattern = true;
  }
  if (code.length === 0 || !code.some((segment) => segment !== "{}")) return undefined;
  for (const [index, segment] of code.entries()) {
    const other = spec[index] ?? "";
    if (segment === other) continue;
    if (!client) return undefined;
    if (other === "{}" || segment === "{}") {
      pattern = true;
      continue;
    }
    if (segment.includes("{}") && segmentMatches(segment, other)) {
      pattern = true;
      continue;
    }
    return undefined;
  }
  return pattern ? "pattern" : "exact";
}

/** A segment with holes (`order-{}`) against a literal one (`order-12`). */
function segmentMatches(withHoles: string, literal: string): boolean {
  const parts = withHoles.split("{}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]*")}$`).test(literal);
}

/** The path part of each `servers[].url`, e.g. `/api/v1`. */
function serverPrefixes(documents: readonly OpenApiDocument[]): Segments[] {
  const out: Segments[] = [];
  for (const document of documents) {
    const servers = document.root.servers;
    if (!Array.isArray(servers)) continue;
    for (const server of servers) {
      if (!isObject(server) || typeof server.url !== "string") continue;
      const segments = pathSegments(server.url.replace(/^[a-z]+:\/\/[^/]*/i, "") || "/");
      if (segments !== undefined && segments.length > 0) out.push(segments);
    }
  }
  return out;
}

/**
 * The top-level declaration a Protobuf change concerns (`shop.v1.Order.total` gives
 * `Order`), or undefined when it concerns the whole file (package changed, file deleted,
 * unreadable) or names nothing the file declares.
 */
function declarationOf(change: ContractChange, target: ProtoTarget): string | undefined {
  const symbol = change.location.symbol;
  if (symbol === undefined || change.rule === "package-changed") return undefined;
  const pkg = target.package;
  const relative =
    pkg !== null && symbol.startsWith(`${pkg}.`) ? symbol.slice(pkg.length + 1) : symbol;
  const top = relative.split(".")[0] ?? "";
  return target.messages.has(top) || target.services.has(top) ? top : undefined;
}

function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Valid, deduplicated, sorted by path, line and kind. */
function finish(found: readonly ConsumerRef[]): ConsumerRef[] {
  const seen = new Map<string, ConsumerRef>();
  for (const ref of found) {
    if (!ConsumerRef.safeParse(ref).success) continue;
    const key = `${ref.path}:${String(ref.line)}:${ref.via ?? ref.kind}:${ref.match}`;
    const known = seen.get(key);
    // An exact match wins over a pattern for the same place.
    if (known === undefined || (known.confidence === "pattern" && ref.confidence === "exact")) {
      seen.set(key, ref);
    }
  }
  return [...seen.values()].sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.line - b.line ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
}
