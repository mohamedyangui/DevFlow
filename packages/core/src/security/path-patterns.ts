import picomatch from "picomatch";

/**
 * Path lists used by the path guard and the context engine (docs/specs/security-model.md,
 * section 6). Patterns are repository-relative globs with forward slashes. They are matched
 * with `dot: true` (so `*` matches dot files) and case-insensitively on Windows and macOS,
 * where the file system usually is.
 */

/**
 * Files that are never read for a model prompt, wherever they are in the repository. They
 * usually hold credentials. Matching is on the path's real location as well as on the path
 * as written, so a symlink cannot be used to smuggle one of them into a prompt.
 */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.kdbx",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_dsa",
  "**/id_dsa.*",
  "**/id_ecdsa",
  "**/id_ecdsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/.npmrc",
  "**/.yarnrc.yml",
  "**/.pypirc",
  "**/.netrc",
  "**/_netrc",
  "**/.git-credentials",
  "**/credentials",
  "**/credentials.*",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.tfvars",
  "**/.terraform/**",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.docker/config.json",
  "**/.m2/settings.xml",
  "**/.m2/settings-security.xml",
];

/**
 * Paths that can never be written through the guard, not even when a confirmed plan unlocks
 * them: repository metadata and DevFlow's own state.
 */
export const HARD_PROTECTED_PATH_PATTERNS: readonly string[] = [
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
  ".devflow",
  ".devflow/**",
];

/**
 * Paths that are write-protected by default. A confirmed plan can unlock one specific path
 * from this list; `security.additionalProtectedPaths` can only add to it.
 */
export const DEFAULT_PROTECTED_PATH_PATTERNS: readonly string[] = [
  ".github/workflows/**",
  // Lockfiles
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/gradle.lockfile",
  "**/gradle/dependency-locks/**",
  // Build wrappers (their hash is part of command fingerprints, ADR 0007)
  "**/mvnw",
  "**/mvnw.cmd",
  "**/.mvn/wrapper/**",
  "**/gradlew",
  "**/gradlew.bat",
  "**/gradle/wrapper/**",
  // Secrets
  ...SENSITIVE_PATH_PATTERNS,
];

/** True on platforms whose default file systems compare names case-insensitively. */
export function caseInsensitiveFileSystem(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** A compiled set of glob patterns. */
export interface PathMatcher {
  /** Returns the first pattern that matches the repository-relative path, or `undefined`. */
  match(relativePath: string): string | undefined;
}

export function createPathMatcher(
  patterns: readonly string[],
  options: { caseInsensitive: boolean },
): PathMatcher {
  const compiled = patterns.map((pattern) => ({
    pattern,
    test: picomatch(pattern, { dot: true, nocase: options.caseInsensitive }),
  }));
  return {
    match(relativePath) {
      return compiled.find((entry) => entry.test(relativePath))?.pattern;
    },
  };
}
