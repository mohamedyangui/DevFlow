import { z } from "zod";

/**
 * Shared primitive schemas: identifiers, repository-relative paths and evidence.
 *
 * Paths are always repository-relative, use forward slashes, and are portable to Windows.
 * These schema checks are syntactic only; containment, symlink and protected-path checks
 * belong to the runtime PathGuard (Phase 2, docs/specs/security-model.md).
 */

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// Characters that are invalid in Windows file names, plus ASCII control characters.
// eslint-disable-next-line no-control-regex
const WINDOWS_INVALID_PATH_CHARS = /[<>:"|?*\u0000-\u001f]/;
// Globs may use * ? [ ] { } but never control characters, quotes, pipes or angle brackets.
// eslint-disable-next-line no-control-regex
const INVALID_GLOB_CHARS = /[<>:"|\u0000-\u001f]/;

interface PathCheckOptions {
  /** Allow glob metacharacters (`*`, `?`, `[`, `]`, `{`, `}`). */
  readonly glob: boolean;
}

/**
 * Checks that a value is a portable, repository-relative POSIX path (or glob).
 * Returns `null` when the value is acceptable, otherwise a human-readable reason.
 */
export function checkRepoRelativePath(
  value: string,
  options: PathCheckOptions = { glob: false },
): string | null {
  if (value.length === 0) return "path must not be empty";
  if (value.length > 1024) return "path must not be longer than 1024 characters";
  if (value.includes("\\")) return 'path must use forward slashes ("/")';
  if (value.startsWith("/")) return "path must be relative to the repository root";
  if (/^[A-Za-z]:/.test(value)) return "path must not contain a drive letter";
  if (value === ".") return null;

  const invalidChars = options.glob ? INVALID_GLOB_CHARS : WINDOWS_INVALID_PATH_CHARS;
  const segments = value.endsWith("/") ? value.slice(0, -1).split("/") : value.split("/");
  for (const segment of segments) {
    if (segment === "") return "path must not contain empty segments";
    if (segment === "..") return 'path must not contain ".." segments';
    if (segment === ".") return 'path must not contain "." segments';
    if (invalidChars.test(segment)) {
      return `path segment "${segment}" contains characters that are not portable to Windows`;
    }
    if (!options.glob && /[ .]$/.test(segment)) {
      return `path segment "${segment}" must not end with a space or a dot`;
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      return `path segment "${segment}" is a reserved device name on Windows`;
    }
  }
  return null;
}

/** A portable path relative to the repository root, e.g. `services/orders/pom.xml`. */
export const RepoPath = z
  .string()
  .superRefine((value, ctx) => {
    const problem = checkRepoRelativePath(value);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  })
  .meta({ description: "Repository-relative path using forward slashes." });
export type RepoPath = z.infer<typeof RepoPath>;

/** A repository-relative glob pattern, e.g. `services/**\/*.java`. */
export const RepoGlob = z
  .string()
  .superRefine((value, ctx) => {
    if (value.startsWith("!")) {
      ctx.addIssue({ code: "custom", message: 'negated globs ("!") are not supported here' });
      return;
    }
    const problem = checkRepoRelativePath(value, { glob: true });
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  })
  .meta({ description: "Repository-relative glob pattern using forward slashes." });
export type RepoGlob = z.infer<typeof RepoGlob>;

/**
 * Task identifier. It is used in branch names and directory names, so the character set is
 * deliberately restrictive.
 */
export const TaskId = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'must start with a letter or digit and contain only letters, digits, ".", "_" or "-" (at most 64 characters)',
  );
export type TaskId = z.infer<typeof TaskId>;

export const FunctionalRequirementId = z
  .string()
  .regex(/^FR-[1-9][0-9]{0,3}$/, "expected a functional requirement id such as FR-1");
export const NonFunctionalRequirementId = z
  .string()
  .regex(/^NFR-[1-9][0-9]{0,3}$/, "expected a non-functional requirement id such as NFR-1");
export const RequirementId = z
  .string()
  .regex(/^N?FR-[1-9][0-9]{0,3}$/, "expected a requirement id such as FR-1 or NFR-1");
export const AcceptanceCriterionId = z
  .string()
  .regex(/^AC-[1-9][0-9]{0,3}$/, "expected an acceptance criterion id such as AC-1");

/** Module identifier within a (mono)repository, e.g. `backend` or `web`. */
export const ModuleId = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
  );

export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase hex SHA-256");
export const GitCommit = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/, "expected a commit id");
export const IsoDateTime = z.iso.datetime({ offset: true });
export const Confidence = z.number().min(0).max(1);

/** A location in a source file. Lines and columns are 1-based. */
export const SourceLocation = z.strictObject({
  path: RepoPath,
  line: z.int().positive().optional(),
  column: z.int().positive().optional(),
  endLine: z.int().positive().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocation>;

/**
 * A piece of evidence supporting a result or finding.
 *
 * `deterministic` is true only when the evidence was produced by a deterministic tool or
 * check (a test run, a compiler, a linter, a DevFlow rule). Model output is never
 * deterministic evidence.
 */
export const Evidence = z.strictObject({
  kind: z.enum(["file", "execution", "test-report", "tool-report", "log-excerpt", "note"]),
  description: z.string().min(1),
  deterministic: z.boolean(),
  path: RepoPath.optional(),
  line: z.int().positive().optional(),
  sha256: Sha256.optional(),
  excerpt: z.string().max(4000).optional(),
});
export type Evidence = z.infer<typeof Evidence>;
