import {
  fileEvidence,
  findLine,
  findLines,
  isWithin,
  joinRepoPath,
  readTextIfPresent,
  repoDirname,
  type Evidence,
  type RepositoryView,
} from "@devflow/core";
import { dedupeLocated, normalizeJavaVersion } from "./maven.js";
import type { BuildFile, BuildModel, Declaration, Located } from "./model.js";
import { baseName, resolveRepoPath, unique } from "./paths.js";

/**
 * Gradle builds are read as text: DevFlow never evaluates a build script. The patterns below
 * cover the common declarative forms of the Groovy and Kotlin DSLs and of version catalogs;
 * what they miss is simply not detected (and so never claimed).
 */

export const SETTINGS_FILES = ["settings.gradle.kts", "settings.gradle"];
export const BUILD_FILES = ["build.gradle.kts", "build.gradle"];
/** Build logic outside the projects' own build files. */
const BUILD_LOGIC_GLOBS = [
  "buildSrc/**/*.gradle.kts",
  "buildSrc/**/*.gradle",
  "build-logic/**/*.gradle.kts",
  "build-logic/**/*.gradle",
  "gradle/*.gradle.kts",
  "gradle/*.gradle",
];
const MAX_BUILD_LOGIC_FILES = 100;

/** Blanks out comments, keeping line numbers. */
export function stripComments(text: string): string {
  const blocks = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return blocks.replace(/(^|[\s;])\/\/.*$/gm, "$1");
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Project paths named by `include` statements of a settings file, e.g. `["app", "lib:core"]`. */
export function gradleIncludes(settingsText: string): string[] {
  const text = stripComments(settingsText);
  const out: string[] = [];
  for (const match of text.matchAll(/\binclude\b\s*\(?/g)) {
    let end = text.indexOf("\n", match.index);
    if (end === -1) end = text.length;
    let statement = text.slice(match.index, end);
    while (
      end < text.length &&
      (statement.trimEnd().endsWith(",") || count(statement, "(") > count(statement, ")"))
    ) {
      let next = text.indexOf("\n", end + 1);
      if (next === -1) next = text.length;
      statement += text.slice(end, next);
      end = next;
    }
    for (const quoted of statement.matchAll(/["']([^"'\s]+)["']/g)) {
      const name = quoted[1];
      if (name !== undefined) out.push(name.replace(/^:/, ""));
    }
  }
  return unique(out.filter((name) => name !== ""));
}

/** `project(":api").projectDir = file("services/api")` overrides. */
function projectDirOverrides(settingsText: string): Map<string, string> {
  const map = new Map<string, string>();
  const text = stripComments(settingsText);
  const pattern =
    /project\s*\(\s*["']:?([^"']+)["']\s*\)\.projectDir\s*=\s*(?:new\s+File\s*\(\s*(?:settingsDir|rootDir)\s*,\s*["']([^"']+)["']\s*\)|file\s*\(\s*["']([^"']+)["']\s*\))/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    const dir = match[2] ?? match[3];
    if (name !== undefined && dir !== undefined) map.set(name, dir);
  }
  return map;
}

/** Dependency coordinates in a string: `"group:artifact[:version]"`. */
const COORDINATE = /["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::([^"'\s]*))?["']/;
const GROUP_NAME =
  /\bgroup\s*[:=]\s*["']([A-Za-z0-9_.-]+)["']\s*,\s*name\s*[:=]\s*["']([A-Za-z0-9_.-]+)["'](?:\s*,\s*version\s*[:=]\s*["']([^"']+)["'])?/;
const PLUGIN_ID =
  /\bid\s*\(?\s*["']([A-Za-z0-9_.-]+)["']\s*\)?(?:\s*version\s*\(?\s*["']([^"']+)["'])?/;
const APPLY_PLUGIN = /\bapply\s*\(?\s*plugin\s*[:=]\s*["']([A-Za-z0-9_.-]+)["']/;
const KOTLIN_PLUGIN =
  /\bkotlin\s*\(\s*["']([A-Za-z0-9_.-]+)["']\s*\)(?:\s*version\s*["']([^"']+)["'])?/;
const CATALOG_ALIAS = /\balias\s*\(\s*libs\.plugins\.([A-Za-z0-9_.]+)\s*\)/;
const CATALOG_LIBRARY = /\blibs\.(?!plugins\.|bundles\.|versions\.)([A-Za-z0-9_.]+)/;
const CORE_PLUGIN =
  /^\s*`?(java|java-library|application|checkstyle|jacoco|pmd|groovy|war|java-test-fixtures)`?\s*$/;
const PLAIN_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

/** Line numbers (1-based) inside `plugins { ... }` blocks. */
function pluginsBlockLines(text: string): Set<number> {
  const lines = new Set<number>();
  let depth = 0;
  let inside = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (!inside && /^\s*plugins\s*\{/.test(line)) {
      inside = true;
      depth = 0;
    }
    if (inside) {
      lines.add(index + 1);
      depth += count(line, "{") - count(line, "}");
      if (depth <= 0) inside = false;
    }
  });
  return lines;
}

interface Catalog {
  readonly path: string;
  readonly libraries: Map<string, Declaration>;
  readonly plugins: Map<string, Declaration>;
}

/** Catalog keys are referenced with dots: `spring-boot` is `libs.plugins.spring.boot`. */
function catalogKey(key: string): string {
  return key.replace(/[-_]/g, ".");
}

async function readCatalog(repo: RepositoryView, root: string): Promise<Catalog | undefined> {
  const catalogPath = joinRepoPath(root, "gradle/libs.versions.toml");
  const text = await readTextIfPresent(repo, catalogPath);
  if (text === undefined) return undefined;
  const versions = new Map<string, string>();
  const libraries = new Map<string, Declaration>();
  const plugins = new Map<string, Declaration>();
  let section = "";
  const lines = text.split(/\r?\n/);
  // Versions first, so that `version.ref` can be resolved wherever the section appears.
  for (const line of lines) {
    const header = /^\s*\[([A-Za-z]+)\]\s*$/.exec(line);
    if (header !== null) {
      section = header[1] ?? "";
      continue;
    }
    const entry = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"\s*(?:#.*)?$/.exec(line);
    if (section === "versions" && entry?.[1] !== undefined && entry[2] !== undefined) {
      versions.set(entry[1], entry[2]);
    }
  }
  section = "";
  lines.forEach((line, index) => {
    const header = /^\s*\[([A-Za-z]+)\]\s*$/.exec(line);
    if (header !== null) {
      section = header[1] ?? "";
      return;
    }
    const keyMatch = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
    const key = keyMatch?.[1];
    if (key === undefined) return;
    const evidence = fileEvidence(catalogPath, `version catalog entry ${key}`, {
      line: index + 1,
      excerpt: line,
    });
    const ref = /\bversion\.ref\s*=\s*"([^"]+)"/.exec(line)?.[1];
    const literal = /\bversion\s*=\s*"([^"]+)"/.exec(line)?.[1];
    const version = literal ?? (ref === undefined ? undefined : versions.get(ref));
    if (section === "libraries") {
      const coordinate = COORDINATE.exec(line);
      const groupName = /\bgroup\s*=\s*"([^"]+)"\s*,\s*name\s*=\s*"([^"]+)"/.exec(line);
      const group = coordinate?.[1] ?? groupName?.[1];
      const artifact = coordinate?.[2] ?? groupName?.[2];
      if (group === undefined || artifact === undefined) return;
      const inline = coordinate?.[3];
      const resolved = inline !== undefined && PLAIN_VERSION.test(inline) ? inline : version;
      libraries.set(catalogKey(key), {
        kind: "catalog-library",
        group,
        artifact,
        ...(resolved === undefined ? {} : { version: resolved }),
        evidence,
      });
    } else if (section === "plugins") {
      const id = /\bid\s*=\s*"([^"]+)"/.exec(line)?.[1];
      const short = /=\s*"([A-Za-z0-9_.-]+):([^"]+)"/.exec(line);
      const pluginId = id ?? short?.[1];
      if (pluginId === undefined) return;
      const pluginVersion = id === undefined ? short?.[2] : version;
      plugins.set(catalogKey(key), {
        kind: "catalog-plugin",
        group: pluginId,
        artifact: "",
        ...(pluginVersion === undefined ? {} : { version: pluginVersion }),
        evidence,
      });
    }
  });
  return { path: catalogPath, libraries, plugins };
}

/** `libs.junit.jupiter` (also followed by `.get()`) names the catalog library `junit-jupiter`. */
function catalogLibrary(catalog: Catalog | undefined, reference: string): Declaration | undefined {
  const parts = reference.split(".");
  for (let length = parts.length; length > 0; length -= 1) {
    const found = catalog?.libraries.get(parts.slice(0, length).join("."));
    if (found !== undefined) return found;
  }
  return undefined;
}

function declarationsOf(file: BuildFile, catalog: Catalog | undefined): Declaration[] {
  const text = stripComments(file.text);
  const out: Declaration[] = [];
  // Settings files declare plugin versions (pluginManagement) and settings plugins; neither
  // applies a plugin to a project.
  const settings = SETTINGS_FILES.includes(baseName(file.path));
  const evidence = (line: number, excerpt: string, what: string) =>
    fileEvidence(file.path, what, { line, excerpt });
  for (const hit of findLines(text, COORDINATE)) {
    const [, group, artifact, version] = hit.match;
    if (group === undefined || artifact === undefined) continue;
    out.push({
      kind: "dependency",
      group,
      artifact,
      ...(version !== undefined && PLAIN_VERSION.test(version) ? { version } : {}),
      evidence: evidence(hit.line, hit.excerpt, `${group}:${artifact}`),
    });
  }
  for (const hit of findLines(text, GROUP_NAME)) {
    const [, group, artifact, version] = hit.match;
    if (group === undefined || artifact === undefined) continue;
    out.push({
      kind: "dependency",
      group,
      artifact,
      ...(version === undefined ? {} : { version }),
      evidence: evidence(hit.line, hit.excerpt, `${group}:${artifact}`),
    });
  }
  for (const hit of findLines(text, CATALOG_LIBRARY)) {
    const entry = hit.match[1] === undefined ? undefined : catalogLibrary(catalog, hit.match[1]);
    if (entry === undefined) continue;
    out.push({
      ...entry,
      kind: "dependency",
      evidence: evidence(hit.line, hit.excerpt, `${entry.group}:${entry.artifact}`),
    });
  }
  const plugin = (id: string, version: string | undefined, line: number, excerpt: string) => {
    // `id("x") version "1" apply false` only puts the plugin on the build classpath.
    if (settings || /\bapply\s*\(?\s*false\b/.test(excerpt)) return;
    out.push({
      kind: "plugin",
      group: id,
      artifact: "",
      ...(version === undefined ? {} : { version }),
      evidence: evidence(line, excerpt, `Gradle plugin ${id}`),
    });
  };
  for (const hit of findLines(text, PLUGIN_ID)) {
    if (hit.match[1] !== undefined) plugin(hit.match[1], hit.match[2], hit.line, hit.excerpt);
  }
  for (const hit of findLines(text, APPLY_PLUGIN)) {
    if (hit.match[1] !== undefined) plugin(hit.match[1], undefined, hit.line, hit.excerpt);
  }
  for (const hit of findLines(text, KOTLIN_PLUGIN)) {
    if (hit.match[1] !== undefined) {
      plugin(`org.jetbrains.kotlin.${hit.match[1]}`, hit.match[2], hit.line, hit.excerpt);
    }
  }
  const block = pluginsBlockLines(text);
  for (const hit of findLines(text, CORE_PLUGIN)) {
    if (block.has(hit.line) && hit.match[1] !== undefined) {
      plugin(hit.match[1], undefined, hit.line, hit.excerpt);
    }
  }
  for (const hit of findLines(text, CATALOG_ALIAS)) {
    const key = hit.match[1];
    const entry = key === undefined ? undefined : catalog?.plugins.get(catalogKey(key));
    if (entry !== undefined) {
      plugin(entry.group, entry.version, hit.line, hit.excerpt);
    }
  }
  return out;
}

const JAVA_VERSION_PATTERNS: readonly RegExp[] = [
  /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/,
  /\bjvmToolchain\s*\(\s*(\d+)\s*\)/,
  /\b(?:source|target)Compatibility\s*=\s*JavaVersion\.VERSION_(\d+(?:_\d+)?)/,
  /\b(?:source|target)Compatibility\s*=\s*["']?(\d+(?:\.\d+)?)["']?/,
  /\boptions\.release\s*(?:=|\.set\s*\()\s*(\d+)/,
];

function javaVersionOf(files: readonly BuildFile[]): Located<string> | undefined {
  for (const pattern of JAVA_VERSION_PATTERNS) {
    for (const file of files) {
      const hit = findLine(stripComments(file.text), pattern);
      const raw = hit?.match[1];
      if (hit === undefined || raw === undefined) continue;
      return {
        value: normalizeJavaVersion(raw.replace("_", ".")),
        evidence: fileEvidence(file.path, "Java version", { line: hit.line, excerpt: hit.excerpt }),
      };
    }
  }
  return undefined;
}

async function wrapperVersion(
  repo: RepositoryView,
  root: string,
): Promise<Located<string> | undefined> {
  const propertiesPath = joinRepoPath(root, "gradle/wrapper/gradle-wrapper.properties");
  const text = await readTextIfPresent(repo, propertiesPath);
  if (text === undefined) return undefined;
  const hit = findLine(
    text,
    /^\s*distributionUrl\s*=.*gradle-([0-9][0-9A-Za-z.+-]*?)-(?:bin|all)\.zip/,
  );
  const version = hit?.match[1];
  if (hit === undefined || version === undefined) return undefined;
  return {
    value: version,
    evidence: fileEvidence(propertiesPath, "Gradle wrapper distribution", {
      line: hit.line,
      excerpt: hit.excerpt,
    }),
  };
}

/** Resolves `$rootDir/...`, `$projectDir/...` and relative paths from a build script. */
function scriptPath(value: string, projectDir: string, root: string): string | undefined {
  const rootRef = /^\$\{?(?:rootDir|rootProject\.projectDir)\}?/;
  const projectRef = /^\$\{?(?:projectDir|project\.projectDir)\}?/;
  if (rootRef.test(value))
    return resolveRepoPath(root, value.replace(rootRef, "").replace(/^\/+/, ""));
  if (projectRef.test(value)) {
    return resolveRepoPath(projectDir, value.replace(projectRef, "").replace(/^\/+/, ""));
  }
  if (value.includes("$")) return undefined;
  return resolveRepoPath(projectDir, value);
}

async function firstExisting(
  repo: RepositoryView,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) if (await repo.exists(candidate)) return candidate;
  return undefined;
}

/** Reads a Gradle build rooted at `root`, or undefined when it has no settings or build file. */
export async function loadGradleBuild(
  repo: RepositoryView,
  root: string,
): Promise<BuildModel | undefined> {
  const settingsPath = await firstExisting(
    repo,
    SETTINGS_FILES.map((name) => joinRepoPath(root, name)),
  );
  const rootBuild = await firstExisting(
    repo,
    BUILD_FILES.map((name) => joinRepoPath(root, name)),
  );
  if (settingsPath === undefined && rootBuild === undefined) return undefined;
  const settingsText =
    settingsPath === undefined ? undefined : await readTextIfPresent(repo, settingsPath);

  const projectDirs = [root];
  if (settingsText !== undefined) {
    const overrides = projectDirOverrides(settingsText);
    for (const name of gradleIncludes(settingsText)) {
      const dir = resolveRepoPath(root, overrides.get(name) ?? name.replace(/:/g, "/"));
      if (dir !== undefined && isWithin(root, dir) && (await repo.exists(dir)))
        projectDirs.push(dir);
    }
  }

  const buildFiles: BuildFile[] = [];
  if (settingsPath !== undefined && settingsText !== undefined) {
    buildFiles.push({ path: settingsPath, text: settingsText });
  }
  for (const dir of unique(projectDirs)) {
    const file = await firstExisting(
      repo,
      BUILD_FILES.map((name) => joinRepoPath(dir, name)),
    );
    const text = file === undefined ? undefined : await readTextIfPresent(repo, file);
    if (file !== undefined && text !== undefined) buildFiles.push({ path: file, text });
  }
  const logic = (await repo.glob(BUILD_LOGIC_GLOBS, { cwd: root }))
    .slice()
    .sort()
    .slice(0, MAX_BUILD_LOGIC_FILES);
  for (const file of logic) {
    if (buildFiles.some((existing) => existing.path === file)) continue;
    const text = await readTextIfPresent(repo, file);
    if (text !== undefined) buildFiles.push({ path: file, text });
  }

  const catalog = await readCatalog(repo, root);
  const declarations = [
    ...buildFiles.flatMap((file) => declarationsOf(file, catalog)),
    ...(catalog === undefined ? [] : [...catalog.libraries.values()]),
  ];

  const openApiInputs: Located<string>[] = [];
  const protoRoots: string[] = [];
  let junitPlatform: Evidence | undefined;
  for (const file of buildFiles) {
    const text = stripComments(file.text);
    const projectDir = repoDirname(file.path);
    for (const hit of findLines(
      text,
      /\binputSpec\s*(?:=|\.set\s*\()\s*(?:file\s*\(\s*)?["']([^"']+)["']/,
    )) {
      const value = hit.match[1];
      const resolved = value === undefined ? undefined : scriptPath(value, projectDir, root);
      if (resolved !== undefined) {
        openApiInputs.push({
          value: resolved,
          evidence: fileEvidence(file.path, "openapi-generator inputSpec", {
            line: hit.line,
            excerpt: hit.excerpt,
          }),
        });
      }
    }
    const appliesProtobuf = declarationsOf(file, catalog).some(
      (declaration) => declaration.kind === "plugin" && declaration.group === "com.google.protobuf",
    );
    if (appliesProtobuf && projectDirs.includes(projectDir)) {
      protoRoots.push(joinRepoPath(projectDir, "src/main/proto"));
      for (const hit of findLines(text, /\bsrcDirs?\s*\(?\s*["']([^"']*proto[^"']*)["']/)) {
        const value = hit.match[1];
        const resolved = value === undefined ? undefined : scriptPath(value, projectDir, root);
        if (resolved !== undefined) protoRoots.push(resolved);
      }
    }
    if (junitPlatform === undefined) {
      const hit = findLine(text, /\buseJUnit(?:Platform|Jupiter)\s*\(/);
      if (hit !== undefined) {
        junitPlatform = fileEvidence(file.path, "tests run on the JUnit Platform", {
          line: hit.line,
          excerpt: hit.excerpt,
        });
      }
    }
  }

  const toolVersion = await wrapperVersion(repo, root);
  const wrapper = await firstExisting(repo, [
    joinRepoPath(root, "gradlew"),
    joinRepoPath(root, "gradlew.bat"),
  ]);
  const javaVersion = javaVersionOf(buildFiles);
  return {
    tool: "gradle",
    root,
    primaryFile: settingsPath ?? rootBuild ?? joinRepoPath(root, "build.gradle"),
    buildFiles,
    projectDirs: unique(projectDirs),
    declarations,
    ...(javaVersion === undefined ? {} : { javaVersion }),
    ...(toolVersion === undefined ? {} : { toolVersion }),
    ...(wrapper === undefined ? {} : { wrapper }),
    configuredSources: [],
    openApiInputs: dedupeLocated(openApiInputs),
    protoRoots: unique(protoRoots),
    ...(junitPlatform === undefined ? {} : { junitPlatform }),
  };
}
