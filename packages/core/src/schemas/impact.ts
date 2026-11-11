import { z } from "zod";
import { ContractKind } from "./module.js";
import { RepoPath } from "./primitives.js";

/**
 * Cross-language change impact (ADR 0022): the code that consumes a changed OpenAPI operation
 * or Protobuf declaration, found by documented, deterministic heuristics over the repository
 * (never by a model). A consumer is a lead for a person to check, not proof that the change
 * breaks it, and an empty list is not proof that nothing consumes the contract.
 */

/** How a consumer was found. */
export const ConsumerMechanism = z.enum([
  /** A Spring `@GetMapping`/`@RequestMapping`... handler serving the operation's path. */
  "spring-mapping",
  /** A TypeScript or JavaScript HTTP call (`fetch`, axios, `http.get`...) to the path. */
  "ts-client-call",
  /** A Java HTTP call (RestTemplate, WebClient `.uri`, MockMvc builders...) to the path. */
  "java-client-call",
  /** A Python HTTP call (`requests`, `httpx`, a session or client) to the path. */
  "python-client-call",
  /** A call of a method named after the operation's `operationId` (generated clients). */
  "operation-id-call",
  /** An import of code generated from the `.proto` file (Java, TypeScript/JavaScript, Python). */
  "generated-import",
]);
export type ConsumerMechanism = z.infer<typeof ConsumerMechanism>;

/** A consumer's kind: its mechanism, or `test` when the file is a test (see `via`). */
export const ConsumerKind = z.enum([...ConsumerMechanism.options, "test"]);
export type ConsumerKind = z.infer<typeof ConsumerKind>;

/**
 * `exact`: a literal name or path equal to the contract's (after normalizing path variables
 * to `{}`), with a known HTTP method. `pattern`: a match by naming convention or a normalized
 * template only (a stripped base URL, an unknown method, a bare module name, a method name
 * equal to an operation id): it may be a false positive.
 */
export const ConsumerConfidence = z.enum(["exact", "pattern"]);
export type ConsumerConfidence = z.infer<typeof ConsumerConfidence>;

export const ConsumerRef = z
  .strictObject({
    path: RepoPath,
    /** 1-based line of the match. */
    line: z.int().positive(),
    /** The file's language: `java`, `kotlin`, `typescript`, `javascript`, `python`. */
    language: z.string().min(1),
    kind: ConsumerKind,
    /** How a test consumer was found; present only when `kind` is `test`. */
    via: ConsumerMechanism.optional(),
    /** What matched, e.g. `GET /orders/{}` or `import shop.v1.orders_pb2`. */
    match: z.string().min(1).max(300),
    confidence: ConsumerConfidence,
  })
  .refine((ref) => (ref.kind === "test") === (ref.via !== undefined), {
    message: "via is set exactly when kind is test",
    path: ["via"],
  });
export type ConsumerRef = z.infer<typeof ConsumerRef>;

/** One breaking contract change and the consumers found for it. */
export const ContractImpact = z.strictObject({
  kind: ContractKind,
  /** The contract file (repository-relative). */
  file: z.string().min(1),
  /** The rule that found the change, e.g. `operation-removed`. */
  rule: z.string().min(1),
  message: z.string().min(1),
  /** What the consumers were searched for: `GET /orders/{}`, `shop.v1.Order`, ... */
  target: z.string().min(1),
  consumers: z.array(ConsumerRef),
  /** Consumers found beyond the listed ones, left out. */
  omitted: z.int().nonnegative(),
});
export type ContractImpact = z.infer<typeof ContractImpact>;
