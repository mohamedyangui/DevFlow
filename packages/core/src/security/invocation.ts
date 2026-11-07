import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DevflowError, ErrorCode } from "../errors.js";
import type { InvocationStrategy } from "../schemas/command.js";
import type { ApprovedCommand } from "./command-policy.js";
import { toolName } from "./command-policy.js";
import { cmdArguments, shimEntryPoint } from "./windows-invocation.js";

/** How an approved command is launched (ADR 0014, ADR 0018). */

/** How a command will be started. */
export interface Invocation {
  readonly strategy: InvocationStrategy;
  /** Absolute path of the program that is spawned. */
  readonly file: string;
  readonly args: readonly string[];
  /** Pass `args` to Windows unchanged (only for the `windows-batch` layout). */
  readonly windowsVerbatimArguments: boolean;
}

export interface InvocationContext {
  readonly platform: NodeJS.Platform;
  /** The child environment (after {@link childEnvironment}); PATH lookups use it. */
  readonly env: Readonly<Record<string, string>>;
  /** The Node.js binary used for the `node-script` strategy. */
  readonly nodePath: string;
}

function envValue(
  env: Readonly<Record<string, string>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

const WINDOWS_RUNNABLE = [".com", ".exe", ".bat", ".cmd"];

/**
 * Finds a tool on PATH. Relative PATH entries (such as `.`) are ignored, so a repository
 * cannot shadow a tool with a file of the same name. On Windows only `.com`, `.exe`, `.bat` and
 * `.cmd` files are considered, in PATHEXT order.
 */
export async function findOnPath(
  name: string,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const directories = (envValue(env, "PATH", platform) ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir !== "" && pathApi.isAbsolute(dir));

  if (platform !== "win32") {
    for (const dir of directories) {
      const candidate = pathApi.join(dir, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
    return undefined;
  }

  const pathext = (envValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => WINDOWS_RUNNABLE.includes(ext));
  const hasExtension = WINDOWS_RUNNABLE.includes(pathApi.extname(name).toLowerCase());
  const names = hasExtension ? [name] : pathext.map((ext) => `${name}${ext}`);
  for (const dir of directories) {
    for (const candidate of names) {
      const full = pathApi.join(dir, candidate);
      if (await isFile(full)) return full;
    }
  }
  return undefined;
}

/**
 * Resolves the JavaScript entry point of a Node.js command shim, if the shim is one and the
 * entry point is a `.js`, `.mjs` or `.cjs` file inside the shim's parent directory.
 */
export async function resolveNodeShim(shimFile: string): Promise<string | undefined> {
  let text: string;
  try {
    const info = await stat(shimFile);
    if (info.size > 64 * 1024) return undefined;
    text = await readFile(shimFile, "utf8");
  } catch {
    return undefined;
  }
  const entry = shimEntryPoint(text);
  if (entry === undefined) return undefined;
  const shimDirectory = path.win32.dirname(shimFile);
  const resolved = path.win32.resolve(shimDirectory, entry.replaceAll("/", "\\"));
  const boundary = path.win32.dirname(shimDirectory);
  const relative = path.win32.relative(boundary, resolved);
  if (relative.startsWith("..") || path.win32.isAbsolute(relative)) return undefined;
  if (!/\.[cm]?js$/i.test(resolved) || !(await isFile(resolved))) return undefined;
  return resolved;
}

async function findJava(context: InvocationContext): Promise<string | undefined> {
  const javaHome = envValue(context.env, "JAVA_HOME", context.platform);
  if (javaHome !== undefined && path.win32.isAbsolute(javaHome)) {
    const candidate = path.win32.join(javaHome, "bin", "java.exe");
    if (await isFile(candidate)) return candidate;
  }
  return findOnPath("java", context.env, context.platform);
}

function notFound(message: string, details: Record<string, unknown>): DevflowError {
  return new DevflowError(ErrorCode.ExecutableNotFound, message, { details });
}

/** Chooses the invocation strategy for an approved command (ADR 0014). */
export async function resolveInvocation(
  command: ApprovedCommand,
  context: InvocationContext,
): Promise<Invocation> {
  const { platform } = context;
  const args = command.args;

  if (command.executable.kind === "wrapper") {
    const wrapper = command.executable.absolute;
    if (platform !== "win32") {
      return { strategy: "direct", file: wrapper, args, windowsVerbatimArguments: false };
    }
    const name = toolName(command.spec.executable);
    const cwd = command.cwd.absolute;
    if (name === "gradlew" || name === "mvnw") {
      const jar =
        name === "gradlew"
          ? path.win32.join(cwd, "gradle", "wrapper", "gradle-wrapper.jar")
          : path.win32.join(cwd, ".mvn", "wrapper", "maven-wrapper.jar");
      if (await isFile(jar)) {
        const java = await findJava(context);
        if (java === undefined) {
          throw notFound(`Java was not found (JAVA_HOME or PATH); it is needed to run ${name}`, {
            executable: command.spec.executable,
          });
        }
        const launcher =
          name === "gradlew"
            ? [
                "-Xmx64m",
                "-Xms64m",
                "-Dorg.gradle.appname=gradlew",
                "-classpath",
                jar,
                "org.gradle.wrapper.GradleWrapperMain",
              ]
            : [
                "-classpath",
                jar,
                `-Dmaven.multiModuleProjectDirectory=${cwd}`,
                "org.apache.maven.wrapper.MavenWrapperMain",
              ];
        return {
          strategy: "java-launcher",
          file: java,
          args: [...launcher, ...args],
          windowsVerbatimArguments: false,
        };
      }
    }
    const batch = /\.(cmd|bat)$/i.test(wrapper)
      ? wrapper
      : (await isFile(`${wrapper}.cmd`))
        ? `${wrapper}.cmd`
        : (await isFile(`${wrapper}.bat`))
          ? `${wrapper}.bat`
          : undefined;
    if (batch === undefined) {
      throw notFound(`${command.spec.executable} has no .cmd or .bat variant to run on Windows`, {
        executable: command.spec.executable,
      });
    }
    return batchInvocation(batch, args, context);
  }

  const found = await findOnPath(command.executable.name, context.env, platform);
  if (found === undefined) {
    throw notFound(`executable "${command.executable.name}" was not found on PATH`, {
      executable: command.executable.name,
    });
  }
  if (platform !== "win32" || /\.(exe|com)$/i.test(found)) {
    return { strategy: "direct", file: found, args, windowsVerbatimArguments: false };
  }
  const entry = await resolveNodeShim(found);
  if (entry !== undefined) {
    return {
      strategy: "node-script",
      file: context.nodePath,
      args: [entry, ...args],
      windowsVerbatimArguments: false,
    };
  }
  return batchInvocation(found, args, context);
}

function batchInvocation(
  batch: string,
  args: readonly string[],
  context: InvocationContext,
): Invocation {
  const systemRoot = envValue(context.env, "SystemRoot", context.platform) ?? "C:\\Windows";
  return {
    strategy: "windows-batch",
    file: path.win32.join(systemRoot, "System32", "cmd.exe"),
    args: cmdArguments(batch, args),
    windowsVerbatimArguments: true,
  };
}
