import type { ProtoFile } from "../protobuf/parse.js";
import type { ImportRef, ScannedFile } from "./scan.js";

/**
 * The names of the code generated from a `.proto` file (ADR 0022), by the conventions of the
 * standard generators, and how an import refers to them:
 *
 * - Java/Kotlin (protoc, grpc-java): the package is `java_package`, else the proto package;
 *   the outer class is `java_outer_classname`, else the file name in CamelCase (with
 *   `OuterClass` appended when a declaration has that name); with `java_multiple_files`,
 *   every top-level message and enum is a class of its own; a service `S` gives `SGrpc`.
 * - TypeScript/JavaScript: `<name>_pb` (protoc-gen-js, protobuf-es), `<name>_grpc_pb`,
 *   `<name>_grpc_web_pb`, `<name>_connect`, `<name>.client` (protobuf-ts); a bare `<name>`
 *   module (ts-proto) is a pattern match only, and only under a directory that looks
 *   generated or names the proto package.
 * - Python: `<name>_pb2` and `<name>_pb2_grpc` (protoc, grpcio-tools), `<name>_grpc` (grpclib).
 */

export interface ProtoTarget {
  /** The contract file. */
  readonly file: string;
  /** The file name without `.proto`. */
  readonly stem: string;
  readonly package: string | null;
  /** Top-level declarations: messages, enums, services. */
  readonly messages: ReadonlySet<string>;
  readonly services: ReadonlySet<string>;
  readonly javaPackage: string;
  readonly javaOuterClass: string;
  readonly javaMultipleFiles: boolean;
  /** Directory names that make a bare TS/JS module name plausible. */
  readonly directoryHints: ReadonlySet<string>;
}

/** CamelCase of a file name the way protoc derives the outer class name. */
export function protocCamelCase(stem: string): string {
  let out = "";
  let upper = true;
  for (const char of stem) {
    if (/[A-Za-z]/.test(char)) {
      out += upper ? char.toUpperCase() : char;
      upper = false;
    } else if (/[0-9]/.test(char)) {
      out += char;
      upper = true;
    } else {
      upper = true;
    }
  }
  return out;
}

export function protoTarget(file: string, versions: readonly ProtoFile[]): ProtoTarget {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const stem = name.replace(/\.proto$/i, "");
  const latest = versions.at(-1);
  const pkg = latest?.package ?? null;
  const options = latest?.options ?? {};
  const messages = new Set<string>();
  const services = new Set<string>();
  for (const version of versions) {
    for (const message of version.messages) messages.add(message.name);
    for (const enumeration of version.enums) messages.add(enumeration.name);
    for (const service of version.services) services.add(service.name);
  }
  const camel = protocCamelCase(stem);
  const conflicts = messages.has(camel) || services.has(camel);
  const directoryHints = new Set(["gen", "generated", "proto", "protos", "pb", "grpc"]);
  for (const segment of file.split("/").slice(0, -1)) directoryHints.add(segment.toLowerCase());
  for (const segment of (pkg ?? "").split(".")) {
    if (segment !== "") directoryHints.add(segment.toLowerCase());
  }
  return {
    file,
    stem,
    package: pkg,
    messages,
    services,
    javaPackage: options.java_package ?? pkg ?? "",
    javaOuterClass: options.java_outer_classname ?? (conflicts ? `${camel}OuterClass` : camel),
    javaMultipleFiles: options.java_multiple_files === "true",
    directoryHints,
  };
}

export interface GeneratedImport {
  readonly ref: ImportRef;
  readonly confidence: "exact" | "pattern";
}

/** The imports of a file that refer to code generated from the target. */
export function generatedImports(target: ProtoTarget, file: ScannedFile): GeneratedImport[] {
  const out: GeneratedImport[] = [];
  for (const ref of file.imports) {
    const confidence =
      file.language === "java" || file.language === "kotlin"
        ? javaImport(target, ref)
        : file.language === "python"
          ? pythonImport(target, ref)
          : scriptImport(target, ref);
    if (confidence !== undefined) out.push({ ref, confidence });
  }
  return out;
}

function javaImport(target: ProtoTarget, ref: ImportRef): "exact" | "pattern" | undefined {
  const pkg = target.javaPackage;
  const qualified = (name: string) => (pkg === "" ? name : `${pkg}.${name}`);
  const names = [target.javaOuterClass, ...[...target.services].map((name) => `${name}Grpc`)];
  if (target.javaMultipleFiles) names.push(...target.messages, ...target.services);
  if (ref.wildcard) {
    if (ref.specifier === pkg) return "pattern";
    return names.some((name) => ref.specifier === qualified(name)) ? "exact" : undefined;
  }
  return names.some(
    (name) => ref.specifier === qualified(name) || ref.specifier.startsWith(`${qualified(name)}.`),
  )
    ? "exact"
    : undefined;
}

function pythonImport(target: ProtoTarget, ref: ImportRef): "exact" | undefined {
  const last = ref.specifier.slice(ref.specifier.lastIndexOf(".") + 1);
  return [`${target.stem}_pb2`, `${target.stem}_pb2_grpc`, `${target.stem}_grpc`].includes(last)
    ? "exact"
    : undefined;
}

function scriptImport(target: ProtoTarget, ref: ImportRef): "exact" | "pattern" | undefined {
  const segments = ref.specifier.split("/");
  const last = (segments.at(-1) ?? "").replace(/\.(?:[cm]?[jt]s|d\.ts)$/, "");
  const exact = [
    `${target.stem}_pb`,
    `${target.stem}_grpc_pb`,
    `${target.stem}_grpc_web_pb`,
    `${target.stem}_connect`,
    `${target.stem}.client`,
  ];
  if (exact.includes(last)) return "exact";
  if (last === target.stem && segments.length > 1) {
    const hinted = segments
      .slice(0, -1)
      .some((segment) => target.directoryHints.has(segment.toLowerCase()));
    return hinted ? "pattern" : undefined;
  }
  return undefined;
}

/** Whether the file's code names a declaration (services also through their stubs). */
export function referencesDeclaration(file: ScannedFile, name: string, service: boolean): boolean {
  const escaped = name.replace(/[$]/g, "\\$");
  const suffix = service ? "(?:Grpc|Stub|Servicer|Client|ImplBase|Promise\\w*)?" : "";
  return new RegExp(`(?<![\\w$])${escaped}${suffix}(?![\\w$])`).test(file.code);
}
