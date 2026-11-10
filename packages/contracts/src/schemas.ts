import { ContractKind } from "@devflow/core";
import { z } from "zod";

/**
 * The result of comparing two versions of a contract (ADR 0021). Compatibility is decided by
 * deterministic rules (built in, or an external tool's), never by a model.
 */

export const ContractCompatibility = z.enum(["breaking", "non-breaking", "unknown"]);
export type ContractCompatibility = z.infer<typeof ContractCompatibility>;

/** Who decided a change's compatibility. */
export const ContractDecider = z.enum(["builtin-rules", "tool:oasdiff", "tool:buf"]);
export type ContractDecider = z.infer<typeof ContractDecider>;

/** Where a change is: the file, and inside it an API path and method, a JSON pointer or a symbol. */
export const ContractLocation = z.strictObject({
  /** The contract file, as the caller named it (repository-relative in review mode). */
  file: z.string().min(1),
  /** OpenAPI: the path template, e.g. `/pets/{id}`. */
  path: z.string().min(1).optional(),
  /** OpenAPI: the HTTP method, lower case. */
  method: z.string().min(1).optional(),
  /** OpenAPI: a JSON pointer into the document (RFC 6901), e.g. `/paths/~1pets/get`. */
  pointer: z.string().optional(),
  /** Protobuf: the fully qualified symbol, e.g. `shop.v1.Order.total`. */
  symbol: z.string().min(1).optional(),
  /** The line in the head version (base version for removals), when known. */
  line: z.int().positive().optional(),
});
export type ContractLocation = z.infer<typeof ContractLocation>;

export const ContractChange = z.strictObject({
  kind: ContractKind,
  /** The rule that found the change, e.g. `operation-removed` or an oasdiff/buf rule id. */
  rule: z.string().min(1),
  compatibility: ContractCompatibility,
  decidedBy: ContractDecider,
  location: ContractLocation,
  message: z.string().min(1),
});
export type ContractChange = z.infer<typeof ContractChange>;

/** Every change between the base and the head version of one contract file. */
export const ContractDiff = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: ContractKind,
    file: z.string().min(1),
    /** Whether the file exists in each version. */
    base: z.enum(["present", "absent"]),
    head: z.enum(["present", "absent"]),
    /** Who decided the changes: the built-in rules, or a tool when one ran. */
    decidedBy: ContractDecider,
    changes: z.array(ContractChange),
    /** Number of breaking, non-breaking and unknown changes. */
    summary: z.strictObject({
      breaking: z.int().nonnegative(),
      nonBreaking: z.int().nonnegative(),
      unknown: z.int().nonnegative(),
    }),
    /** What limited the comparison: an unresolved reference, a tool that could not run, ... */
    notes: z.array(z.string().min(1)),
  })
  .superRefine((diff, ctx) => {
    const count = (compatibility: ContractCompatibility) =>
      diff.changes.filter((change) => change.compatibility === compatibility).length;
    if (
      diff.summary.breaking !== count("breaking") ||
      diff.summary.nonBreaking !== count("non-breaking") ||
      diff.summary.unknown !== count("unknown")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["summary"],
        message: "the summary must count the changes",
      });
    }
    if (diff.changes.some((change) => change.kind !== diff.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["changes"],
        message: "every change must be of the diff's kind",
      });
    }
  });
export type ContractDiff = z.infer<typeof ContractDiff>;

/** Counts the changes per compatibility. */
export function summarize(changes: readonly ContractChange[]): ContractDiff["summary"] {
  let breaking = 0;
  let nonBreaking = 0;
  let unknown = 0;
  for (const change of changes) {
    if (change.compatibility === "breaking") breaking += 1;
    else if (change.compatibility === "non-breaking") nonBreaking += 1;
    else unknown += 1;
  }
  return { breaking, nonBreaking, unknown };
}
