import { defineAdapter, type LanguageAdapter } from "@devflowai/core";
import { analyzeJavaScriptModule } from "./analyze.js";
import { javaScriptCommandCatalog } from "./commands.js";
import { parseJavaScriptResults } from "./results.js";
import {
  discoverJavaScriptTests,
  inferJavaScriptConventions,
  javaScriptTestAuthoringGuide,
} from "./tests.js";
import { ADAPTER_ID, detectJavaScriptModules } from "./workspace.js";

/**
 * The JavaScript and TypeScript language adapter (docs/specs/language-adapter.md): npm, pnpm,
 * Yarn and Bun projects and workspaces, Express, NestJS, React, Next.js and Vite, Vitest, Jest,
 * Mocha and Playwright, ESLint, Prettier and tsc, Protobuf and OpenAPI generators. It reads
 * manifests and configuration files as text and never runs a package script.
 */
export const javascriptAdapter: LanguageAdapter = defineAdapter({
  id: ADAPTER_ID,
  displayName: "JavaScript and TypeScript (npm, pnpm, Yarn)",
  apiVersion: "1.0.0",
  detectModules: detectJavaScriptModules,
  analyzeModule: analyzeJavaScriptModule,
  inferConventions: inferJavaScriptConventions,
  discoverTests: discoverJavaScriptTests,
  testAuthoringGuide: javaScriptTestAuthoringGuide,
  commandCatalog: (profile, _toolchain, repo) => javaScriptCommandCatalog(profile, repo),
  parseResults: parseJavaScriptResults,
});

export { applyRule, FRAMEWORK_RULES, QUALITY_RULES, TEST_FRAMEWORK_RULES } from "./analyze.js";
export {
  isSolutionStyleTsconfig,
  JAVASCRIPT_PARSERS,
  javaScriptCommandCatalog,
  resolveBin,
  TEST_NAME_PATTERN,
  testRunnerOf,
  TOOL_BINS,
} from "./commands.js";
export { parseJsonc } from "./jsonc.js";
export {
  installedPackage,
  manifestWorkspaces,
  pnpmWorkspacePackages,
  type InstalledPackage,
  type PackageManifest,
} from "./manifest.js";
export { pathFrom } from "./paths.js";
export {
  acceptanceMarkers,
  failureOutcome,
  parseEslintJson,
  parseJestJson,
  parseTscOutput,
  stripAnsi,
  type JestReport,
} from "./results.js";
export { primaryTestFramework, UNIT_RUNNERS } from "./tests.js";
export {
  detectJavaScriptModules,
  packageManagerOf,
  workspaceIncludes,
  workspaceOf,
} from "./workspace.js";
