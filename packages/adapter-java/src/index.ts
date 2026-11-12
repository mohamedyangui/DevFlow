import { defineAdapter, type LanguageAdapter } from "@devflow-ai/core";
import { analyzeJavaModule } from "./analyze.js";
import { ADAPTER_ID, detectJavaModules } from "./build.js";
import { javaCommandCatalog } from "./commands.js";
import { javaTestSelection } from "./selection.js";
import { parseJavaResults } from "./results.js";
import { discoverJavaTests, inferJavaConventions, javaTestAuthoringGuide } from "./tests.js";

/**
 * The Java language adapter (docs/specs/language-adapter.md): Maven and Gradle builds, Spring
 * Boot, JUnit 5 and 4, Mockito, AssertJ, Checkstyle, SpotBugs, Protobuf and OpenAPI generator
 * plugins. It reads build files as text or XML and never runs the build to learn about it.
 */
export const javaAdapter: LanguageAdapter = defineAdapter({
  id: ADAPTER_ID,
  displayName: "Java (Maven, Gradle)",
  apiVersion: "1.1.0",
  detectModules: detectJavaModules,
  analyzeModule: analyzeJavaModule,
  inferConventions: inferJavaConventions,
  discoverTests: discoverJavaTests,
  testAuthoringGuide: javaTestAuthoringGuide,
  commandCatalog: (profile) => Promise.resolve(javaCommandCatalog(profile)),
  parseResults: parseJavaResults,
  testSelection: javaTestSelection,
});

export { applyRule, FRAMEWORK_RULES, QUALITY_RULES, TEST_FRAMEWORK_RULES } from "./analyze.js";
export { buildToolAt, detectJavaModules, loadBuildModel } from "./build.js";
export {
  GRADLE_TEST_FILTER,
  JAVA_PARSERS,
  MAVEN_TEST_SELECTOR,
  javaCommandCatalog,
  supportsNoTransferProgress,
} from "./commands.js";
export { gradleIncludes } from "./gradle.js";
export { javaTestSelection } from "./selection.js";
export { aggregatedPoms, loadReactor } from "./maven.js";
export type { BuildModel, BuildToolId, Declaration } from "./model.js";
export {
  acceptanceMarkers,
  parseCheckstyleXml,
  parseCompilerOutput,
  parseJUnitXml,
  parseSpotBugsXml,
  type JUnitCase,
  type SpotBugsFinding,
} from "./results.js";
export { MAVEN_TEST_PATTERNS } from "./tests.js";
export { parseXml, type XmlElement } from "./xml.js";
