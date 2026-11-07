import { CREDENTIAL_ENV_NAME } from "./secrets.js";

/**
 * The environment of child processes (docs/specs/security-model.md, section 5): an allowlist
 * of variables from DevFlow's own environment, plus the command's non-secret additions.
 * Credential-like variables are always removed.
 */

/** Variables passed from DevFlow's environment to child processes. Everything else is dropped. */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "JAVA_HOME",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  "USER",
  "LOGNAME",
  // Windows needs these for ordinary programs to start and find their data.
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
];

/**
 * Variables a command may never set, because they change which program runs or inject code
 * into it (preloads, interpreter options, package-manager script shells).
 */
export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    [
      "PATH",
      "PATHEXT",
      "COMSPEC",
      "SYSTEMROOT",
      "WINDIR",
      "NODE_OPTIONS",
      "NODE_PATH",
      "JAVA_TOOL_OPTIONS",
      "_JAVA_OPTIONS",
      "JDK_JAVA_OPTIONS",
      "BASH_ENV",
      "ENV",
      "SHELL",
      "PERL5OPT",
      "PERL5LIB",
      "PYTHONSTARTUP",
      "PYTHONPATH",
      "RUBYOPT",
    ].includes(upper) ||
    upper.startsWith("LD_") ||
    upper.startsWith("DYLD_") ||
    upper.startsWith("GIT_") ||
    upper.startsWith("NPM_CONFIG_") ||
    upper.startsWith("YARN_") ||
    upper.startsWith("PNPM_")
  );
}

/**
 * Builds a child process environment: the allowlisted variables of `parent` (looked up
 * case-insensitively on Windows), plus the command's own non-secret additions. Variables with
 * credential-like names are always removed, whatever their origin.
 */
export function childEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  additions: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  const keys = Object.keys(parent);
  for (const name of CHILD_ENV_ALLOWLIST) {
    const key =
      platform === "win32" ? keys.find((k) => k.toUpperCase() === name.toUpperCase()) : name;
    const value = key === undefined ? undefined : parent[key];
    if (key !== undefined && value !== undefined) env[key] = value;
  }
  for (const [name, value] of Object.entries(additions)) {
    if (!isReservedEnvName(name)) env[name] = value;
  }
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !CREDENTIAL_ENV_NAME.test(name)),
  );
}
