import type { Evidence } from "@devflow-ai/core";
import type { XmlElement } from "./xml.js";

export type BuildToolId = "maven" | "gradle";

/**
 * Something a build declares: a dependency, a plugin, a parent POM, an imported BOM, or an
 * entry of a Gradle version catalog. For Gradle plugins, `group` holds the plugin id and
 * `artifact` is empty.
 */
export interface Declaration {
  readonly kind: "dependency" | "plugin" | "parent" | "bom" | "catalog-library" | "catalog-plugin";
  readonly group: string;
  readonly artifact: string;
  readonly version?: string;
  /** Points at the build file, at the declaring line when it could be found. */
  readonly evidence: Evidence;
  /** The Maven `<plugin>` element, for reading its configuration. */
  readonly element?: XmlElement;
}

export interface BuildFile {
  readonly path: string;
  readonly text: string;
}

export interface Located<T> {
  readonly value: T;
  readonly evidence: Evidence;
}

/** Source directories a project configures explicitly (Maven `<sourceDirectory>`). */
export interface ConfiguredSources {
  readonly projectDir: string;
  readonly main?: string;
  readonly test?: string;
}

/**
 * What DevFlow reads from one build (a Maven reactor or a Gradle build with its settings):
 * the build files, the project directories that belong to the build, and what they declare.
 * A module is one build, so a multi-module build is one DevFlow module.
 */
export interface BuildModel {
  readonly tool: BuildToolId;
  readonly root: string;
  /** The root build file (pom.xml, settings.gradle(.kts) or build.gradle(.kts)). */
  readonly primaryFile: string;
  readonly buildFiles: readonly BuildFile[];
  /** The root directory and every project directory of the build, root first. */
  readonly projectDirs: readonly string[];
  readonly declarations: readonly Declaration[];
  readonly javaVersion?: Located<string>;
  /** The build tool version, from the wrapper properties. */
  readonly toolVersion?: Located<string>;
  /** The wrapper script in the root directory, when there is one. */
  readonly wrapper?: string;
  readonly configuredSources: readonly ConfiguredSources[];
  /** OpenAPI documents named by generator plugin configuration. */
  readonly openApiInputs: readonly Located<string>[];
  /** Directories that hold `.proto` files for code generation. */
  readonly protoRoots: readonly string[];
  /** Gradle `useJUnitPlatform()` / `useJUnitJupiter()`. */
  readonly junitPlatform?: Evidence;
}

/** True for a declaration with this group (exact or prefix match) and artifact. */
export function matches(
  declaration: Declaration,
  group: string | RegExp,
  artifact?: string | RegExp,
): boolean {
  const groupOk =
    typeof group === "string" ? declaration.group === group : group.test(declaration.group);
  if (!groupOk) return false;
  if (artifact === undefined) return true;
  return typeof artifact === "string"
    ? declaration.artifact === artifact
    : artifact.test(declaration.artifact);
}
