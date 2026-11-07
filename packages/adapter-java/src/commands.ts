import {
  joinRepoPath,
  type CommandPurpose,
  type CommandSpec,
  type ModuleProfile,
  type ParamSpec,
} from "@devflow/core";
import { baseName } from "./paths.js";

/** Result parsers of the Java adapter, named in `CommandSpec.results.parser`. */
export const JAVA_PARSERS = {
  junitXml: "junit-xml",
  checkstyle: "checkstyle-xml",
  spotbugs: "spotbugs-xml",
  compiler: "javac",
  exitCode: "exit-code",
} as const;

const MINUTE = 60_000;

export const MAVEN_TEST_SELECTOR: ParamSpec = {
  name: "testSelector",
  description:
    "Surefire test selection, written as test=<selection>: a class, Class#method, wildcards (*) or a comma-separated list, e.g. test=OrderControllerTest#ac1_returnsSecondPage",
  pattern: "^test=[A-Za-z0-9_$.*#+,/]+$",
  maxLength: 512,
};

export const GRADLE_TEST_FILTER: ParamSpec = {
  name: "testFilter",
  description:
    "Gradle test filter: a fully qualified class or method name, wildcards (*) allowed, e.g. com.acme.OrderControllerTest.ac1_returnsSecondPage",
  pattern: "^[A-Za-z_$*][A-Za-z0-9_$.*]*$",
  maxLength: 512,
};

/** `--no-transfer-progress` exists since Maven 3.6.1. Unknown versions are assumed recent. */
export function supportsNoTransferProgress(version: string | undefined): boolean {
  if (version === undefined) return true;
  const [major, minor = 0, patch = 0] = version
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
  if (major === undefined || Number.isNaN(major)) return true;
  if (major !== 3) return major > 3;
  if (Number.isNaN(minor) || minor !== 6) return Number.isNaN(minor) || minor > 6;
  return !Number.isNaN(patch) && patch >= 1;
}

/**
 * The command catalog of a Java module. Commands run the module's wrapper when it has one,
 * otherwise `mvn` or `gradle` from PATH; when that is missing too, the verification engine
 * reports the gate as not executed. Every purpose has one command without parameters (the one
 * a gate runs); the filtered test command is for targeted runs. Builds may download
 * dependencies, so commands declare network access.
 *
 * Gradle commands clean the outputs of the tasks whose reports they read (`cleanTest test`),
 * so an up-to-date task cannot leave only an old report behind.
 */
export function javaCommandCatalog(profile: ModuleProfile): CommandSpec[] {
  const tool = profile.buildTool;
  if (tool === undefined || (tool.id !== "maven" && tool.id !== "gradle")) return [];
  const executable =
    tool.wrapper === undefined
      ? tool.id === "maven"
        ? "mvn"
        : "gradle"
      : `./${baseName(tool.wrapper).replace(/\.(cmd|bat)$/i, "")}`;
  const hasTool = (id: string) => profile.qualityTools.some((found) => found.id === id);
  const reports = (glob: string) => [joinRepoPath(profile.root, glob)];
  const command = (
    suffix: string,
    purpose: CommandPurpose,
    args: readonly string[],
    parser: string,
    reportGlobs: readonly string[],
    timeoutMs: number,
    parameters: readonly ParamSpec[] = [],
  ): CommandSpec => ({
    id: `${profile.moduleId}:${suffix}`,
    purpose,
    executable,
    args: [...args],
    cwd: profile.root,
    env: {},
    timeoutMs,
    network: "required",
    parameters: [...parameters],
    results: { parser, reportGlobs: [...reportGlobs] },
    origin: "adapter",
  });

  if (tool.id === "maven") {
    const base = [
      "--batch-mode",
      ...(supportsNoTransferProgress(tool.version) ? ["--no-transfer-progress"] : []),
    ];
    const surefire = reports("**/target/surefire-reports/TEST-*.xml");
    const failsafe = reports("**/target/failsafe-reports/TEST-*.xml");
    const catalog = [
      command(
        "compile",
        "compile",
        [...base, "test-compile"],
        JAVA_PARSERS.compiler,
        [],
        20 * MINUTE,
      ),
      command("test", "test", [...base, "test"], JAVA_PARSERS.junitXml, surefire, 60 * MINUTE),
      command(
        "test-filter",
        "test",
        [
          ...base,
          "--define",
          "{testSelector}",
          "--define",
          "surefire.failIfNoSpecifiedTests=false",
          "test",
        ],
        JAVA_PARSERS.junitXml,
        surefire,
        60 * MINUTE,
        [MAVEN_TEST_SELECTOR],
      ),
      command(
        "build",
        "build",
        [...base, "verify"],
        JAVA_PARSERS.junitXml,
        [...surefire, ...failsafe],
        90 * MINUTE,
      ),
    ];
    if (hasTool("checkstyle")) {
      catalog.push(
        command(
          "checkstyle",
          "lint",
          [...base, "checkstyle:check"],
          JAVA_PARSERS.checkstyle,
          reports("**/target/checkstyle-result.xml"),
          20 * MINUTE,
        ),
      );
    }
    if (hasTool("spotbugs")) {
      catalog.push(
        command(
          "spotbugs",
          "static-analysis",
          [...base, "compile", "spotbugs:check"],
          JAVA_PARSERS.spotbugs,
          reports("**/target/spotbugsXml.xml"),
          30 * MINUTE,
        ),
      );
    }
    if (hasTool("spotless")) {
      catalog.push(
        command(
          "format-check",
          "format-check",
          [...base, "spotless:check"],
          JAVA_PARSERS.exitCode,
          [],
          20 * MINUTE,
        ),
      );
    }
    return catalog;
  }

  const base = ["--no-daemon", "--console=plain"];
  const testResults = reports("**/build/test-results/**/TEST-*.xml");
  const catalog = [
    command("compile", "compile", [...base, "testClasses"], JAVA_PARSERS.compiler, [], 20 * MINUTE),
    command(
      "test",
      "test",
      [...base, "cleanTest", "test"],
      JAVA_PARSERS.junitXml,
      testResults,
      60 * MINUTE,
    ),
    command(
      "test-filter",
      "test",
      [...base, "cleanTest", "test", "--tests", "{testFilter}"],
      JAVA_PARSERS.junitXml,
      testResults,
      60 * MINUTE,
      [GRADLE_TEST_FILTER],
    ),
    command(
      "build",
      "build",
      [...base, "cleanTest", "build"],
      JAVA_PARSERS.junitXml,
      testResults,
      90 * MINUTE,
    ),
  ];
  if (hasTool("checkstyle")) {
    catalog.push(
      command(
        "checkstyle",
        "lint",
        [...base, "cleanCheckstyleMain", "cleanCheckstyleTest", "checkstyleMain", "checkstyleTest"],
        JAVA_PARSERS.checkstyle,
        reports("**/build/reports/checkstyle/*.xml"),
        20 * MINUTE,
      ),
    );
  }
  if (hasTool("spotbugs")) {
    catalog.push(
      command(
        "spotbugs",
        "static-analysis",
        [...base, "cleanSpotbugsMain", "spotbugsMain"],
        JAVA_PARSERS.spotbugs,
        reports("**/build/reports/spotbugs/*.xml"),
        30 * MINUTE,
      ),
    );
  }
  if (hasTool("spotless")) {
    catalog.push(
      command(
        "format-check",
        "format-check",
        [...base, "spotlessCheck"],
        JAVA_PARSERS.exitCode,
        [],
        20 * MINUTE,
      ),
    );
  }
  return catalog;
}
