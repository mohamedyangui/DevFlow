import { z } from "zod";
import { IsoDateTime, RepoGlob, RepoPath } from "./primitives.js";

/**
 * Commands are data. Adapters and project configuration describe them; only the policy-gated
 * executor (Phase 2) may run them. See ADR 0006 and ADR 0014.
 */

export const CommandPurpose = z.enum([
  "build",
  "compile",
  "test",
  "lint",
  "typecheck",
  "static-analysis",
  "format-check",
]);
export type CommandPurpose = z.infer<typeof CommandPurpose>;

/** Placeholder syntax inside an argument: `{testFilter}`. It must be the whole argument. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const WHOLE_PLACEHOLDER = /^\{([A-Za-z][A-Za-z0-9]*)\}$/;

/**
 * Environment variable names that look like they carry credentials. Commands may not add such
 * variables: secrets are never passed to child processes (docs/specs/security-model.md).
 */
const SECRET_LIKE_ENV_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;

/** One argv element. Control characters such as NUL, CR and LF are never allowed. */
export const CommandArgument = z
  .string()
  .max(4096)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]*$/, "arguments must not contain control characters");

/**
 * The executable is either a bare tool name resolved by the executor (`mvn`, `node`, `pnpm`)
 * or a wrapper script relative to the command's working directory (`./mvnw`, `./gradlew`).
 * Shell interpreters are rejected by the command policy at runtime, not here.
 */
export const CommandExecutable = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9][A-Za-z0-9._+-]*|\.\/[A-Za-z0-9][A-Za-z0-9._+-]*)$/,
    'expected a bare tool name (e.g. "mvn") or a wrapper in the working directory (e.g. "./mvnw")',
  );

/**
 * A parameter the workflow (or, indirectly, a model) may supply. Its value must fully match
 * `pattern`, which must be anchored, and replaces exactly one argv element.
 */
export const ParamSpec = z
  .strictObject({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
    description: z.string().min(1),
    pattern: z.string().min(2),
    maxLength: z.int().positive().max(1024),
  })
  .superRefine((param, ctx) => {
    if (!param.pattern.startsWith("^") || !param.pattern.endsWith("$")) {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message: 'parameter patterns must be anchored with "^" and "$"',
      });
      return;
    }
    try {
      new RegExp(param.pattern, "u");
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message: `invalid regular expression: ${(error as Error).message}`,
      });
    }
  });
export type ParamSpec = z.infer<typeof ParamSpec>;

export const CommandSpec = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    purpose: CommandPurpose,
    executable: CommandExecutable,
    args: z.array(CommandArgument).max(256),
    cwd: RepoPath,
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), CommandArgument),
    timeoutMs: z.int().min(1_000).max(7_200_000),
    network: z.enum(["none", "required"]),
    parameters: z.array(ParamSpec),
    results: z.strictObject({
      parser: z.string().min(1),
      reportGlobs: z.array(RepoGlob),
    }),
    origin: z.enum(["adapter", "project-config", "user"]),
  })
  .superRefine((spec, ctx) => {
    for (const name of Object.keys(spec.env)) {
      if (SECRET_LIKE_ENV_NAME.test(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["env", name],
          message: "commands must not add credential-like environment variables",
        });
      }
    }
    const declared = new Set(spec.parameters.map((p) => p.name));
    if (declared.size !== spec.parameters.length) {
      ctx.addIssue({ code: "custom", path: ["parameters"], message: "duplicate parameter name" });
    }
    spec.args.forEach((arg, index) => {
      const placeholders = [...arg.matchAll(PLACEHOLDER)].map((m) => m[1] ?? "");
      if (placeholders.length === 0) return;
      const whole = WHOLE_PLACEHOLDER.exec(arg);
      if (whole === null) {
        ctx.addIssue({
          code: "custom",
          path: ["args", index],
          message: "a placeholder must be the entire argument (no prefix, suffix or second placeholder)",
        });
        return;
      }
      const name = whole[1] ?? "";
      if (!declared.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["args", index],
          message: `placeholder "{${name}}" does not match a declared parameter`,
        });
      }
    });
  });
export type CommandSpec = z.infer<typeof CommandSpec>;

/**
 * How the executor actually launched a command. Recorded for auditability, especially on
 * Windows where `.cmd`/`.bat` wrappers need a dedicated strategy (ADR 0014). `container` is
 * the container backend: `docker run` with the command as the container's entry point
 * (ADR 0020).
 */
export const InvocationStrategy = z.enum([
  "direct",
  "node-script",
  "java-launcher",
  "windows-batch",
  "container",
]);
export type InvocationStrategy = z.infer<typeof InvocationStrategy>;

/** A record of one command execution. Every executed command was approved. */
export const ExecutionRecord = z.strictObject({
  commandId: z.string().min(1),
  argv: z.array(z.string()).min(1),
  cwd: RepoPath,
  invocation: InvocationStrategy,
  approval: z.strictObject({
    via: z.enum(["trust-store", "interactive", "allowlist-flag"]),
    approvedBy: z.string().min(1).optional(),
  }),
  startedAt: IsoDateTime,
  durationMs: z.int().nonnegative(),
  exitCode: z.int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  stdoutPath: RepoPath,
  stderrPath: RepoPath,
  outputTruncated: z.boolean(),
  /** Present when the command ran in a container: the image as configured, and its id. */
  container: z
    .strictObject({
      image: z.string().min(1).max(255),
      imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .optional(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecord>;
