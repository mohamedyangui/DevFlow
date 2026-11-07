import type { z } from "zod";

/** Stable codes for problems found in a task's content. */
export const TaskIssueCode = {
  ParseError: "TASK_PARSE_ERROR",
  Schema: "TASK_SCHEMA",
  DuplicateId: "TASK_DUPLICATE_ID",
  UnknownRequirementRef: "TASK_UNKNOWN_REQUIREMENT_REF",
  NoAcceptanceCriteria: "TASK_NO_ACCEPTANCE_CRITERIA",
  NoTraceability: "TASK_NO_TRACEABILITY",
  UncoveredRequirement: "TASK_UNCOVERED_REQUIREMENT",
  EmptyDefinitionOfDone: "TASK_EMPTY_DEFINITION_OF_DONE",
  IncompleteGivenWhenThen: "TASK_INCOMPLETE_GIVEN_WHEN_THEN",
  MarkdownFrontMatter: "TASK_MARKDOWN_FRONT_MATTER",
  MarkdownConflict: "TASK_MARKDOWN_CONFLICT",
  MarkdownUnparsedText: "TASK_MARKDOWN_UNPARSED_TEXT",
} as const;
export type TaskIssueCode = (typeof TaskIssueCode)[keyof typeof TaskIssueCode];

export type IssueSeverity = "error" | "warning";
export type IssuePath = readonly (string | number)[];

export interface ValidationIssue {
  readonly severity: IssueSeverity;
  readonly code: TaskIssueCode;
  readonly message: string;
  /** Path into the task document, e.g. `["acceptanceCriteria", 2, "covers", 0]`. */
  readonly path: IssuePath;
  /** 1-based line in the source file, when known. */
  readonly line?: number;
}

/** Formats a path as `acceptanceCriteria[2].covers[0]`. */
export function formatIssuePath(path: IssuePath): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(segment)) out += out === "" ? segment : `.${segment}`;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out === "" ? "(document)" : out;
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

export function issuesFromZodError(error: z.ZodError): ValidationIssue[] {
  return error.issues.flatMap((issue) => toValidationIssues(issue, []));
}

function toValidationIssues(issue: z.core.$ZodIssue, prefix: IssuePath): ValidationIssue[] {
  const path = [
    ...prefix,
    ...issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
  ];
  const matched = issue.code === "invalid_union" ? matchedUnionBranch(issue) : undefined;
  if (matched !== undefined) {
    // The value has the right shape for exactly one alternative (e.g. it is an object where
    // "text or object" is allowed), so that alternative's own problems are the useful ones.
    return matched.flatMap((inner) => toValidationIssues(inner, path));
  }
  return [
    { severity: "error", code: TaskIssueCode.Schema, message: describeZodIssue(issue), path },
  ];
}

/**
 * Returns the issues of the only union alternative whose type matched the value, or
 * `undefined` when none or several matched. An alternative "did not match" when it failed
 * with a type error on the value itself.
 */
function matchedUnionBranch(
  issue: z.core.$ZodIssueInvalidUnion,
): readonly z.core.$ZodIssue[] | undefined {
  const matching = issue.errors.filter(
    (branch) => !branch.some((inner) => inner.code === "invalid_type" && inner.path.length === 0),
  );
  return matching.length === 1 ? matching[0] : undefined;
}

function describeZodIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === "invalid_type" && issue.message.endsWith("received undefined")) {
    return "required field is missing";
  }
  if (issue.code === "invalid_union") {
    // The value fits no alternative at all, e.g. a number where text or an object is allowed.
    const expected = issue.errors.flatMap((branch) =>
      branch
        .filter((inner) => inner.code === "invalid_type" && inner.path.length === 0)
        .map((inner) => (inner.code === "invalid_type" ? inner.expected : "")),
    );
    if (expected.length === issue.errors.length && expected.length > 0) {
      const received = /received (\w+)/.exec(issue.errors[0]?.[0]?.message ?? "")?.[1];
      return `expected ${expected.join(" or ")}${received === undefined ? "" : `, received ${received}`}`;
    }
  }
  return issue.message;
}
