import { extensionOf } from "./discover.js";
import type { ContextModule, FileRole } from "./schemas.js";

const LANGUAGES: Readonly<Record<string, string>> = {
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  groovy: "groovy",
  gradle: "groovy",
  scala: "scala",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "vue",
  svelte: "svelte",
  py: "python",
  go: "go",
  rs: "rust",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  proto: "protobuf",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  properties: "properties",
  md: "markdown",
  mdx: "markdown",
  adoc: "asciidoc",
  rst: "rst",
  html: "html",
  css: "css",
  scss: "scss",
  sh: "shell",
  ps1: "powershell",
};

const CODE_LANGUAGES = new Set([
  "java",
  "kotlin",
  "groovy",
  "scala",
  "typescript",
  "javascript",
  "vue",
  "svelte",
  "python",
  "go",
  "rust",
  "csharp",
  "ruby",
  "php",
  "swift",
  "c",
  "cpp",
  "sql",
  "graphql",
  "html",
  "css",
  "scss",
  "shell",
  "powershell",
]);

const CONFIGURATION_NAMES = new Set([
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "pnpm-workspace.yaml",
  "dockerfile",
  "makefile",
  ".editorconfig",
  ".nvmrc",
  "buf.yaml",
  "buf.gen.yaml",
  "buf.work.yaml",
]);

const TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)src\/(test|it|integrationTest|testFixtures)\//,
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e)\//,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/,
  /(Test|Tests|IT|Spec)\.(java|kt|groovy|scala)$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(go|py)$/,
];

const GENERATED_PATTERNS: readonly RegExp[] = [
  /(^|\/)(generated|generated-sources|generated-test-sources|gen)\//,
  /\.pb\.(go|cc|h)$/,
  /_pb2(_grpc)?\.py$/,
  /_pb\.(js|d\.ts|ts)$/,
  /\.generated\.[a-z]+$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
];

export function languageOf(relative: string): string | null {
  const name = relative.slice(relative.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  return LANGUAGES[extensionOf(relative)] ?? null;
}

export function isInstructionFile(relative: string): boolean {
  const name = relative.slice(relative.lastIndexOf("/") + 1);
  if (name === "AGENTS.md") return true;
  return relative.startsWith(".devflow/rules/") && relative.endsWith(".md");
}

/**
 * The role of a file, from its path. Contract detection that needs the content (an OpenAPI
 * document with an unusual name) is applied on top by the engine.
 */
export function roleOf(relative: string): FileRole {
  if (isInstructionFile(relative)) return "instructions";
  const name = relative.slice(relative.lastIndexOf("/") + 1).toLowerCase();
  const language = languageOf(relative);
  if (language === "protobuf" || isOpenApiFileName(name)) return "contract";
  if (GENERATED_PATTERNS.some((pattern) => pattern.test(relative))) return "generated";
  if (TEST_PATTERNS.some((pattern) => pattern.test(relative))) return "test";
  if (CONFIGURATION_NAMES.has(name) || /^tsconfig.*\.json$/.test(name)) return "configuration";
  if (relative === ".devflow/config.yaml" || name.startsWith(".")) return "configuration";
  if (language === "markdown" || language === "asciidoc" || language === "rst") {
    return "documentation";
  }
  if (name.endsWith(".txt") || relative.startsWith("docs/")) return "documentation";
  if (language !== null && CODE_LANGUAGES.has(language)) return "source";
  if (language === "json" || language === "yaml" || language === "toml") return "configuration";
  if (language === "xml" || language === "properties") return "configuration";
  return "other";
}

export function isOpenApiFileName(name: string): boolean {
  return /^(openapi|swagger)(\.[a-z0-9-]+)*\.(ya?ml|json)$/i.test(name);
}

/** The module owning a path: the module with the longest root that contains it. */
export function moduleOf(relative: string, modules: readonly ContextModule[]): string | null {
  const depth = (root: string): number => (root === "." ? 0 : root.length);
  let best: ContextModule | undefined;
  for (const module of modules) {
    const inside =
      module.root === "." || relative === module.root || relative.startsWith(`${module.root}/`);
    if (inside && (best === undefined || depth(module.root) > depth(best.root))) best = module;
  }
  return best?.id ?? null;
}
