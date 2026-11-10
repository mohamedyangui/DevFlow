import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isDevflowError } from "../errors.js";
import { CommandArgument, CommandSpec } from "../schemas/command.js";
import type { AuditLog } from "./audit-log.js";
import { isReservedEnvName } from "./environment.js";
import {
  LOCAL_EXECUTION,
  executionTarget,
  type ExecutionSettings,
  type ExecutionTarget,
} from "./execution-backend.js";
import { fingerprintCommand, type CommandBinding } from "./fingerprint.js";
import type { GuardedPath, PathGuard } from "./path-guard.js";
import type { TrustStore } from "./trust-store.js";

/**
 * The command policy decides whether a command may run (docs/specs/security-model.md,
 * section 4):
 *
 * 1. structural validation: the `CommandSpec` schema, parameter values against their anchored
 *    patterns, the working directory and the wrapper through the path guard;
 * 2. the hard deny list, which nothing can override;
 * 3. workspace trust for the current configuration;
 * 4. command approval by fingerprint: the trust store, an explicit CI allowlist, or an
 *    interactive approval. The fingerprint includes the execution backend and image
 *    (ADR 0020), and the approved command carries the target it was approved for.
 *
 * Only an allowed decision produces an {@link ApprovedCommand}, and the executor runs nothing
 * else. A denial carries a reason; the caller reports the gate as `not_executed` with it.
 */

export type DenialReason =
  | "invalid-spec"
  | "invalid-parameter"
  | "cwd-rejected"
  | "executable-rejected"
  | "hard-deny"
  | "workspace-untrusted"
  | "approval-required"
  | "rejected-by-user";

export type ApprovalVia = "trust-store" | "interactive" | "allowlist-flag";

/** What the user is shown before approving a command interactively. */
export interface CommandApprovalRequest {
  readonly commandId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly bindings: readonly CommandBinding[];
  readonly fingerprint: string;
  /** Where the command would run: on the host, or in a container (and which image). */
  readonly target: ExecutionTarget;
}

export type CommandApprovalAnswer = "approve-once" | "approve-always" | "reject";
export type CommandApprover = (request: CommandApprovalRequest) => Promise<CommandApprovalAnswer>;

export interface CommandPolicyOptions {
  readonly guard: PathGuard;
  readonly trust: TrustStore;
  /** SHA-256 of `.devflow/config.yaml`, or null when there is none. */
  readonly configSha256: string | null;
  /** Interactive approval. Absent in CI and other non-interactive runs. */
  readonly approver?: CommandApprover;
  /** Who approves interactively (recorded in the trust store and audit log). */
  readonly approvedBy?: string;
  /** Fingerprints pre-approved for this invocation with an explicit CI flag. */
  readonly allowlist?: readonly string[];
  readonly audit?: AuditLog;
  /** The execution backend of this invocation (ADR 0020). Defaults to `local`. */
  readonly execution?: ExecutionSettings;
}

export interface CommandRequest {
  readonly spec: unknown;
  /** Values for the command's declared parameters. */
  readonly params?: Readonly<Record<string, string>>;
  /** Content the command runs that DevFlow cannot see from the spec (e.g. a script body). */
  readonly bindings?: readonly CommandBinding[];
  /** The module the command belongs to, for a per-module container image. */
  readonly module?: string;
}

export type CommandExecutable =
  | { readonly kind: "tool"; readonly name: string }
  | { readonly kind: "wrapper"; readonly relative: string; readonly absolute: string };

/** A command the policy allowed. Only the policy can create one; it is deeply frozen. */
export interface ApprovedCommand {
  readonly commandId: string;
  readonly spec: CommandSpec;
  readonly executable: CommandExecutable;
  /** Arguments with parameter values substituted (without the executable). */
  readonly args: readonly string[];
  readonly cwd: GuardedPath;
  readonly fingerprint: string;
  readonly bindings: readonly CommandBinding[];
  readonly approval: { readonly via: ApprovalVia; readonly approvedBy?: string };
  /** Where the command was approved to run; the executor runs it there and nowhere else. */
  readonly target: ExecutionTarget;
}

export type PolicyDecision =
  | { readonly allowed: true; readonly command: ApprovedCommand }
  | {
      readonly allowed: false;
      readonly reason: DenialReason;
      readonly message: string;
      readonly fingerprint?: string;
    };

const approved = new WeakSet<object>();

/** Whether a value is an approval created by the command policy in this process. */
export function isApprovedCommand(value: unknown): value is ApprovedCommand {
  return typeof value === "object" && value !== null && approved.has(value);
}

// ---- Hard deny list -------------------------------------------------------------------------

function denyAll(names: readonly string[], reason: string): [string, string][] {
  return names.map((name) => [name, reason]);
}

/** Executables that can never run as a command, whatever the trust or approval. */
const DENIED_EXECUTABLES: ReadonlyMap<string, string> = new Map<string, string>([
  ...denyAll(
    [
      "sh",
      "bash",
      "zsh",
      "dash",
      "ksh",
      "csh",
      "tcsh",
      "fish",
      "ash",
      "busybox",
      "cmd",
      "command",
      "powershell",
      "pwsh",
      "wsl",
      "wscript",
      "cscript",
      "mshta",
      "env",
      "xargs",
      "nohup",
      "setsid",
      "nice",
      "timeout",
      "start",
      "eval",
      "exec",
      "osascript",
      "rundll32",
      "regsvr32",
      "msiexec",
      "schtasks",
      "at",
      "crontab",
    ],
    "shells and command launchers cannot be used as executables",
  ),
  ...denyAll(
    [
      "curl",
      "wget",
      "nc",
      "ncat",
      "netcat",
      "socat",
      "ssh",
      "scp",
      "sftp",
      "ftp",
      "tftp",
      "telnet",
      "rsync",
      "aria2c",
      "bitsadmin",
      "certutil",
    ],
    "network tools cannot be used as executables",
  ),
  ...denyAll(["sudo", "su", "doas", "runas", "pkexec"], "privilege escalation is never allowed"),
  ...denyAll(
    [
      "rm",
      "rmdir",
      "del",
      "erase",
      "rd",
      "shred",
      "dd",
      "mkfs",
      "format",
      "chmod",
      "chown",
      "chattr",
      "icacls",
      "takeown",
      "truncate",
      "mv",
      "move",
    ],
    "destructive file-system tools cannot be used as executables",
  ),
  ...denyAll(["npx", "pnpx", "bunx"], "tools that download and run packages cannot be used"),
  ["git", "git is only run by DevFlow's own fixed internal operations"],
]);

const DENIED_EXTENSIONS = /\.(ps1|psm1|vbs|vbe|wsf|wsh|hta|lnk|scr|msi|reg|js|jse)$/i;

/** Subcommands of package managers that publish, install or run downloaded code. */
const PACKAGE_MANAGER_DENIED: Readonly<Record<string, readonly string[]>> = {
  npm: [
    "publish",
    "unpublish",
    "deprecate",
    "dist-tag",
    "owner",
    "access",
    "adduser",
    "login",
    "logout",
    "token",
    "install",
    "i",
    "ci",
    "add",
    "update",
    "up",
    "upgrade",
    "uninstall",
    "remove",
    "rm",
    "un",
    "r",
    "link",
    "ln",
    "unlink",
    "exec",
    "x",
    "init",
    "create",
    "config",
    "set",
    "profile",
    "team",
    "org",
    "hook",
    "edit",
    "explore",
    "rebuild",
    "prune",
    "dedupe",
  ],
  pnpm: [
    "publish",
    "install",
    "i",
    "add",
    "update",
    "up",
    "upgrade",
    "remove",
    "rm",
    "uninstall",
    "un",
    "link",
    "ln",
    "unlink",
    "dlx",
    "create",
    "init",
    "login",
    "logout",
    "adduser",
    "config",
    "set",
    "import",
    "patch-commit",
    "store",
    "setup",
    "self-update",
    "env",
    "rebuild",
    "prune",
    "dedupe",
  ],
  yarn: [
    "publish",
    "npm",
    "install",
    "add",
    "up",
    "upgrade",
    "remove",
    "link",
    "unlink",
    "dlx",
    "create",
    "init",
    "login",
    "logout",
    "config",
    "set",
    "policies",
    "plugin",
    "self-update",
  ],
  bun: [
    "publish",
    "install",
    "i",
    "add",
    "remove",
    "rm",
    "update",
    "link",
    "unlink",
    "x",
    "create",
    "init",
    "upgrade",
    "pm",
  ],
};

const MAVEN_DENIED_GOALS = ["deploy", "site-deploy"];
const MAVEN_DENIED_PREFIXES = [
  "deploy:",
  "release:",
  "site:deploy",
  "site:stage-deploy",
  "wagon:",
  "scm:",
  "gpg:",
];
const NODE_DENIED_OPTIONS = [
  "-e",
  "--eval",
  "-p",
  "--print",
  "-i",
  "--interactive",
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  "--inspect-wait",
];
const SCRIPT_INTERPRETER_DENIED: Readonly<Record<string, readonly string[]>> = {
  python: ["-c", "-m"],
  python3: ["-c", "-m"],
  py: ["-c", "-m"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
};

/** The executable's tool name: lower case, without directory and Windows extensions. */
export function toolName(executable: string): string {
  const base = executable.startsWith("./") ? executable.slice(2) : executable;
  return base.toLowerCase().replace(/\.(exe|com|cmd|bat)$/, "");
}

/** Returns why a command is on the hard deny list, or undefined. */
export function hardDenyReason(executable: string, args: readonly string[]): string | undefined {
  if (DENIED_EXTENSIONS.test(executable))
    return "script types run by other interpreters are not allowed";
  const name = toolName(executable);
  const denied = DENIED_EXECUTABLES.get(name);
  if (denied !== undefined) return `${name}: ${denied}`;

  // Arguments after "--" belong to the tool being run, not to the executable.
  const separator = args.indexOf("--");
  const words = (separator === -1 ? args : args.slice(0, separator)).map((arg) =>
    arg.toLowerCase(),
  );

  const packageManager = PACKAGE_MANAGER_DENIED[name];
  if (packageManager !== undefined) {
    const hit = words.find((word) => packageManager.includes(word));
    if (hit !== undefined)
      return `${name} ${hit}: publishing, installing and running downloaded packages are not allowed`;
  }
  if (name === "mvn" || name === "mvnw") {
    const hit = words.find(
      (word) =>
        MAVEN_DENIED_GOALS.includes(word) || MAVEN_DENIED_PREFIXES.some((p) => word.startsWith(p)),
    );
    if (hit !== undefined) return `${name} ${hit}: deploying and releasing are not allowed`;
  }
  if (name === "gradle" || name === "gradlew") {
    const hit = words.find((word) => {
      if (word.startsWith("-")) return false;
      const task = word.slice(word.lastIndexOf(":") + 1);
      return task.startsWith("publish") || task.startsWith("upload");
    });
    if (hit !== undefined) return `${name} ${hit}: publishing is not allowed`;
  }
  if (name === "node") {
    for (const word of words) {
      if (!word.startsWith("-")) break; // The script path; what follows belongs to the script.
      const option = word.split("=")[0] ?? word;
      if (NODE_DENIED_OPTIONS.includes(option))
        return `node ${option}: inline code and debuggers are not allowed`;
    }
  }
  const interpreter = SCRIPT_INTERPRETER_DENIED[name];
  if (interpreter !== undefined) {
    const hit = words.find((word) => interpreter.includes(word));
    if (hit !== undefined) return `${name} ${hit}: inline code is not allowed`;
  }
  return undefined;
}

// ---- Policy ---------------------------------------------------------------------------------

export class CommandPolicy {
  private readonly options: CommandPolicyOptions;

  constructor(options: CommandPolicyOptions) {
    this.options = options;
  }

  async evaluate(request: CommandRequest): Promise<PolicyDecision> {
    const parsed = CommandSpec.safeParse(request.spec);
    if (!parsed.success) {
      return this.deny(
        undefined,
        "invalid-spec",
        `invalid command: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const spec = parsed.data;
    const reserved = Object.keys(spec.env).find(isReservedEnvName);
    if (reserved !== undefined) {
      return this.deny(
        spec,
        "invalid-spec",
        `commands must not set ${reserved}: it changes which program runs or injects code into it`,
      );
    }

    const substituted = substituteParameters(spec, request.params ?? {});
    if (typeof substituted === "string") return this.deny(spec, "invalid-parameter", substituted);

    const denied = hardDenyReason(spec.executable, substituted);
    if (denied !== undefined) return this.deny(spec, "hard-deny", denied, substituted);

    const { guard } = this.options;
    let cwd: GuardedPath;
    try {
      cwd = await guard.check(spec.cwd, { access: "read", origin: "internal" });
      if (!cwd.exists || !(await stat(cwd.absolute)).isDirectory()) {
        return await this.deny(
          spec,
          "cwd-rejected",
          `working directory "${spec.cwd}" is not a directory`,
          substituted,
        );
      }
    } catch (error) {
      if (!isDevflowError(error)) throw error;
      return this.deny(spec, "cwd-rejected", error.message, substituted);
    }

    const executable = await this.resolveExecutable(spec, cwd);
    if (typeof executable === "string")
      return this.deny(spec, "executable-rejected", executable, substituted);

    const script = await this.nodeScriptBindings(spec, substituted, cwd);
    if (typeof script === "string")
      return this.deny(spec, "executable-rejected", script, substituted);

    const bindings = [...executable.bindings, ...script, ...(request.bindings ?? [])];
    const target = executionTarget(this.options.execution ?? LOCAL_EXECUTION, request.module);
    const fingerprint = fingerprintCommand(spec, bindings, target);
    const argv = [spec.executable, ...substituted];

    const { trust, configSha256 } = this.options;
    const root = guard.root;
    if (trust.workspaceStatus(root, configSha256) !== "trusted") {
      return this.deny(
        spec,
        "workspace-untrusted",
        "workspace not trusted: run `devflow trust` to review and trust it",
        substituted,
        fingerprint,
      );
    }

    let approval: ApprovedCommand["approval"] | undefined;
    if (trust.isCommandApproved(root, configSha256, fingerprint)) {
      approval = { via: "trust-store" };
    } else if (this.options.allowlist?.includes(fingerprint) === true) {
      approval = { via: "allowlist-flag" };
    } else if (this.options.approver !== undefined) {
      const by = this.options.approvedBy ?? "user";
      const answer = await this.options.approver({
        commandId: spec.id,
        argv,
        cwd: spec.cwd,
        bindings,
        fingerprint,
        target,
      });
      await this.options.audit?.append({
        type: "decision",
        subject: "command",
        decision: answer === "reject" ? "rejected" : "approved",
        by,
        reference: `${spec.id} ${fingerprint}`,
      });
      if (answer === "reject") {
        return this.deny(
          spec,
          "rejected-by-user",
          "the command was rejected",
          substituted,
          fingerprint,
        );
      }
      if (answer === "approve-always") {
        await trust.approveCommand(root, configSha256, {
          fingerprint,
          commandId: spec.id,
          summary:
            target.backend === "local"
              ? argv.join(" ")
              : `${argv.join(" ")} (container ${target.image})`,
          approvedBy: by,
        });
      }
      approval = { via: "interactive", approvedBy: by };
    }
    if (approval === undefined) {
      return this.deny(
        spec,
        "approval-required",
        `approval required: command ${spec.id} (fingerprint ${fingerprint}) has not been approved`,
        substituted,
        fingerprint,
      );
    }

    const command: ApprovedCommand = deepFreeze({
      commandId: spec.id,
      spec,
      executable: executable.executable,
      args: substituted,
      cwd,
      fingerprint,
      bindings,
      approval,
      target,
    });
    approved.add(command);
    return { allowed: true, command };
  }

  private async resolveExecutable(
    spec: CommandSpec,
    cwd: GuardedPath,
  ): Promise<{ executable: CommandExecutable; bindings: CommandBinding[] } | string> {
    if (!spec.executable.startsWith("./")) {
      return { executable: { kind: "tool", name: spec.executable }, bindings: [] };
    }
    const name = spec.executable.slice(2);
    const base = cwd.relative === "." ? "" : `${cwd.relative}/`;
    const candidates = companionFiles(name).map((file) => `${base}${file}`);
    const bindings: CommandBinding[] = [];
    let wrapper: GuardedPath | undefined;
    for (const candidate of candidates) {
      let checked: GuardedPath;
      try {
        checked = await this.options.guard.check(candidate, { access: "read", origin: "internal" });
      } catch (error) {
        if (!isDevflowError(error)) throw error;
        return error.message;
      }
      if (!checked.exists) continue;
      if (!(await stat(checked.absolute)).isFile()) return `"${candidate}" is not a file`;
      const sha256 = createHash("sha256")
        .update(await readFile(checked.absolute))
        .digest("hex");
      bindings.push({ kind: "file", path: checked.relative, sha256 });
      if (candidate === `${base}${name}`) wrapper = checked;
    }
    if (wrapper === undefined) return `wrapper "${spec.executable}" not found in "${spec.cwd}"`;
    return {
      executable: { kind: "wrapper", relative: wrapper.relative, absolute: wrapper.absolute },
      bindings,
    };
  }

  /**
   * `node <script>` runs a file whose content the spec does not show. The script (the first
   * argument that is not an option) must be a file inside the workspace, and its content is
   * bound into the fingerprint, so an approval does not carry over to a changed script. A
   * missing script is refused before anything runs, typically because the project's
   * dependencies are not installed.
   */
  private async nodeScriptBindings(
    spec: CommandSpec,
    args: readonly string[],
    cwd: GuardedPath,
  ): Promise<CommandBinding[] | string> {
    if (toolName(spec.executable) !== "node") return [];
    let script: string | undefined;
    for (const [index, arg] of args.entries()) {
      if (arg === "--") {
        script = args[index + 1];
        break;
      }
      if (!arg.startsWith("-")) {
        script = arg;
        break;
      }
    }
    if (script === undefined) return [];
    if (script.includes("\\") || path.posix.isAbsolute(script) || /^[A-Za-z]:/.test(script)) {
      return `node script "${script}" must be a relative path with forward slashes`;
    }
    const joined = path.posix.normalize(
      cwd.relative === "." ? script : `${cwd.relative}/${script}`,
    );
    if (joined === ".." || joined.startsWith("../")) {
      return `node script "${script}" is outside the workspace`;
    }
    let checked: GuardedPath;
    try {
      checked = await this.options.guard.check(joined, { access: "read", origin: "internal" });
    } catch (error) {
      if (!isDevflowError(error)) throw error;
      return error.message;
    }
    if (!checked.exists) {
      return `node script "${joined}" does not exist (if it belongs to a package, install the project's dependencies first)`;
    }
    if (!(await stat(checked.absolute)).isFile()) return `node script "${joined}" is not a file`;
    const sha256 = createHash("sha256")
      .update(await readFile(checked.absolute))
      .digest("hex");
    return [{ kind: "file", path: checked.relative, sha256 }];
  }

  private async deny(
    spec: CommandSpec | undefined,
    reason: DenialReason,
    message: string,
    args?: readonly string[],
    fingerprint?: string,
  ): Promise<PolicyDecision> {
    if (spec !== undefined) {
      await this.options.audit?.append({
        type: "command",
        commandId: spec.id,
        argv: [spec.executable, ...(args ?? spec.args)],
        cwd: spec.cwd,
        decision: "denied",
        reason: `${reason}: ${message}`,
      });
    }
    return {
      allowed: false,
      reason,
      message,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    };
  }
}

/**
 * Files whose content an approval of wrapper `name` covers: the wrapper itself, its Windows or
 * POSIX sibling (the executor may run either), and the wrapper JARs and properties.
 */
function companionFiles(name: string): string[] {
  const stem = name.replace(/\.(cmd|bat)$/i, "");
  const files = [name, stem, `${stem}.cmd`, `${stem}.bat`];
  if (/^gradlew$/i.test(stem)) {
    files.push("gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties");
  }
  if (/^mvnw$/i.test(stem)) {
    files.push(".mvn/wrapper/maven-wrapper.jar", ".mvn/wrapper/maven-wrapper.properties");
  }
  return [...new Set(files)];
}

/**
 * Replaces `{name}` arguments with parameter values. Returns the arguments, or a message
 * explaining why a value is refused.
 */
export function substituteParameters(
  spec: CommandSpec,
  params: Readonly<Record<string, string>>,
): string[] | string {
  const declared = new Map(spec.parameters.map((p) => [p.name, p]));
  for (const name of Object.keys(params)) {
    if (!declared.has(name)) return `unknown parameter "${name}"`;
  }
  const args: string[] = [];
  for (const arg of spec.args) {
    const placeholder = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(arg);
    if (placeholder === null) {
      args.push(arg);
      continue;
    }
    const name = placeholder[1] ?? "";
    const param = declared.get(name);
    const value = params[name];
    if (param === undefined) return `undeclared placeholder "{${name}}"`;
    if (value === undefined) return `missing value for parameter "${name}"`;
    if (typeof value !== "string") return `parameter "${name}" must be a string`;
    if (value.length > param.maxLength) {
      return `parameter "${name}" is longer than ${param.maxLength} characters`;
    }
    if (!CommandArgument.safeParse(value).success) {
      return `parameter "${name}" contains control characters`;
    }
    if (value.startsWith("-")) {
      return `parameter "${name}" must not start with "-" (it could be read as an option)`;
    }
    if (!new RegExp(param.pattern, "u").test(value)) {
      return `parameter "${name}" does not match its pattern ${param.pattern}`;
    }
    args.push(value);
  }
  return args;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
