import {
  fileEvidence,
  findLine,
  isWithin,
  joinRepoPath,
  readTextIfPresent,
  repoDirname,
  type RepositoryView,
} from "@devflow/core";
import type { BuildModel, ConfiguredSources, Declaration, Located } from "./model.js";
import { escapeRegExp, resolveRepoPath, unique } from "./paths.js";
import { child, childText, descendants, parseXml, path, type XmlElement } from "./xml.js";

/** A reactor larger than this is read only up to this many POMs. */
export const MAX_POMS = 500;

export interface Pom {
  readonly path: string;
  readonly dir: string;
  readonly text: string;
  /** The `<project>` element, or undefined when the file is not usable XML. */
  readonly project: XmlElement | undefined;
}

export async function readPom(repo: RepositoryView, pomPath: string): Promise<Pom | undefined> {
  const text = await readTextIfPresent(repo, pomPath);
  if (text === undefined) return undefined;
  const xml = parseXml(text);
  return {
    path: pomPath,
    dir: repoDirname(pomPath),
    text,
    project: xml?.name === "project" ? xml : undefined,
  };
}

/**
 * The POM files a POM aggregates: `<modules>` (Maven 3) and `<subprojects>` (Maven 4), also
 * inside profiles. A module names a directory, or occasionally a POM file.
 */
export function aggregatedPoms(pom: Pom): string[] {
  const entries = [
    ...path(pom.project, ["modules", "module"]),
    ...path(pom.project, ["subprojects", "subproject"]),
    ...path(pom.project, ["profiles", "profile", "modules", "module"]),
    ...path(pom.project, ["profiles", "profile", "subprojects", "subproject"]),
  ];
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.text === "") continue;
    const resolved = resolveRepoPath(pom.dir, entry.text);
    if (resolved === undefined) continue;
    out.push(/\.xml$/i.test(resolved) ? resolved : joinRepoPath(resolved, "pom.xml"));
  }
  return unique(out);
}

/** The root POM and every POM it aggregates (transitively) inside `root`, root first. */
export async function loadReactor(repo: RepositoryView, root: string): Promise<Pom[]> {
  const out: Pom[] = [];
  const seen = new Set<string>();
  const queue = [joinRepoPath(root, "pom.xml")];
  while (queue.length > 0 && out.length < MAX_POMS) {
    const pomPath = queue.shift();
    if (pomPath === undefined || seen.has(pomPath)) continue;
    seen.add(pomPath);
    const pom = await readPom(repo, pomPath);
    if (pom === undefined) continue;
    out.push(pom);
    for (const aggregated of aggregatedPoms(pom)) {
      if (isWithin(root, aggregated)) queue.push(aggregated);
    }
  }
  return out;
}

type Properties = ReadonlyMap<string, string>;

function propertiesOf(pom: Pom): Map<string, string> {
  const map = new Map<string, string>();
  for (const property of child(pom.project, "properties")?.children ?? []) {
    if (property.text !== "") map.set(property.name, property.text);
  }
  const parent = child(pom.project, "parent");
  const version = childText(pom.project, "version") ?? childText(parent, "version");
  if (version !== undefined) map.set("project.version", version);
  const groupId = childText(pom.project, "groupId") ?? childText(parent, "groupId");
  if (groupId !== undefined) map.set("project.groupId", groupId);
  const parentVersion = childText(parent, "version");
  if (parentVersion !== undefined) map.set("project.parent.version", parentVersion);
  return map;
}

/** Replaces `${name}` references; undefined when one cannot be resolved. */
function interpolate(value: string, scopes: readonly Properties[]): string | undefined {
  let current = value;
  for (let round = 0; round < 5 && current.includes("${"); round += 1) {
    current = current.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
      for (const scope of scopes) {
        const found = scope.get(name);
        if (found !== undefined) return found;
      }
      return whole;
    });
  }
  return current.includes("${") ? undefined : current;
}

/**
 * Resolves a path from POM configuration: relative to the POM's directory, with
 * `${project.basedir}` / `${basedir}` and `${maven.multiModuleProjectDirectory}` understood.
 */
function configuredPath(
  pom: Pom,
  value: string,
  reactorRoot: string,
  scopes: readonly Properties[],
): string | undefined {
  let base = pom.dir;
  let rest = value.trim();
  const rootRefs = /^\$\{(?:maven\.multiModuleProjectDirectory|session\.executionRootDirectory)\}/;
  const baseRefs = /^\$\{(?:project\.basedir|basedir)\}/;
  if (rootRefs.test(rest)) {
    base = reactorRoot;
    rest = rest.replace(rootRefs, "");
  } else if (baseRefs.test(rest)) {
    rest = rest.replace(baseRefs, "");
  }
  const resolved = interpolate(rest.replace(/^[/\\]+/, ""), scopes);
  return resolved === undefined ? undefined : resolveRepoPath(base, resolved);
}

function declarationsOf(pom: Pom, scopes: readonly Properties[]): Declaration[] {
  const out: Declaration[] = [];
  const add = (
    kind: Declaration["kind"],
    element: XmlElement,
    defaultGroup: string | undefined,
  ): void => {
    const group = childText(element, "groupId") ?? defaultGroup;
    const artifact = childText(element, "artifactId");
    if (group === undefined || artifact === undefined) return;
    const rawVersion = childText(element, "version");
    const version = rawVersion === undefined ? undefined : interpolate(rawVersion, scopes);
    const hit = findLine(
      pom.text,
      new RegExp(`<artifactId>\\s*${escapeRegExp(artifact)}\\s*</artifactId>`),
    );
    out.push({
      kind,
      group,
      artifact,
      ...(version === undefined ? {} : { version }),
      evidence: fileEvidence(
        pom.path,
        `${group}:${artifact}`,
        hit === undefined ? undefined : { line: hit.line, excerpt: hit.excerpt },
      ),
      ...(kind === "plugin" ? { element } : {}),
    });
  };
  const project = pom.project;
  const parent = child(project, "parent");
  if (parent !== undefined) add("parent", parent, undefined);
  for (const dependency of [
    ...path(project, ["dependencies", "dependency"]),
    ...path(project, ["profiles", "profile", "dependencies", "dependency"]),
  ]) {
    add("dependency", dependency, undefined);
  }
  for (const managed of path(project, ["dependencyManagement", "dependencies", "dependency"])) {
    if (childText(managed, "scope") === "import") add("bom", managed, undefined);
  }
  for (const plugin of [
    ...path(project, ["build", "plugins", "plugin"]),
    ...path(project, ["profiles", "profile", "build", "plugins", "plugin"]),
  ]) {
    add("plugin", plugin, "org.apache.maven.plugins");
  }
  return out;
}

/** Text values of configuration elements named `name` anywhere inside a plugin. */
export function pluginConfig(declaration: Declaration, name: string): string[] {
  return descendants(declaration.element, name)
    .map((element) => element.text)
    .filter((text) => text !== "");
}

const JAVA_VERSION_PROPERTIES = [
  "maven.compiler.release",
  "maven.compiler.target",
  "maven.compiler.source",
  "java.version",
];

function javaVersionOf(
  poms: readonly Pom[],
  declarations: readonly Declaration[],
  scopes: (pom: Pom) => readonly Properties[],
): Located<string> | undefined {
  for (const pom of poms) {
    const own = propertiesOf(pom);
    for (const name of JAVA_VERSION_PROPERTIES) {
      const raw = own.get(name);
      if (raw === undefined) continue;
      const value = interpolate(raw, scopes(pom));
      if (value === undefined) continue;
      const hit = findLine(pom.text, new RegExp(`<${escapeRegExp(name)}>`));
      return {
        value: normalizeJavaVersion(value),
        evidence: fileEvidence(
          pom.path,
          `Java version (${name})`,
          hit === undefined ? undefined : { line: hit.line, excerpt: hit.excerpt },
        ),
      };
    }
  }
  for (const declaration of declarations) {
    if (declaration.kind !== "plugin" || declaration.artifact !== "maven-compiler-plugin") continue;
    for (const name of ["release", "target", "source"]) {
      const value = pluginConfig(declaration, name)[0];
      if (value === undefined || value.includes("${")) continue;
      return {
        value: normalizeJavaVersion(value),
        evidence: { ...declaration.evidence, description: `Java version (compiler ${name})` },
      };
    }
  }
  return undefined;
}

/** `1.8` → `8`; other values unchanged. */
export function normalizeJavaVersion(value: string): string {
  const legacy = /^1\.(\d+)$/.exec(value.trim());
  return legacy?.[1] ?? value.trim();
}

/** The Maven version from `.mvn/wrapper/maven-wrapper.properties`. */
async function wrapperVersion(
  repo: RepositoryView,
  root: string,
): Promise<Located<string> | undefined> {
  const propertiesPath = joinRepoPath(root, ".mvn/wrapper/maven-wrapper.properties");
  const text = await readTextIfPresent(repo, propertiesPath);
  if (text === undefined) return undefined;
  const hit = findLine(
    text,
    /^\s*distributionUrl\s*=.*apache-maven-([0-9][0-9A-Za-z.+-]*?)-bin\.zip/,
  );
  const version = hit?.match[1];
  if (hit === undefined || version === undefined) return undefined;
  return {
    value: version,
    evidence: fileEvidence(propertiesPath, "Maven wrapper distribution", {
      line: hit.line,
      excerpt: hit.excerpt,
    }),
  };
}

async function firstExisting(
  repo: RepositoryView,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) if (await repo.exists(candidate)) return candidate;
  return undefined;
}

/** Reads a Maven build rooted at `root`, or undefined when there is no `pom.xml`. */
export async function loadMavenBuild(
  repo: RepositoryView,
  root: string,
): Promise<BuildModel | undefined> {
  const poms = await loadReactor(repo, root);
  const rootPom = poms[0];
  if (rootPom === undefined) return undefined;
  const rootProperties = propertiesOf(rootPom);
  const all = poms.map(propertiesOf);
  const scopes = (pom: Pom): Properties[] => [propertiesOf(pom), rootProperties, ...all];

  const declarations = poms.flatMap((pom) => declarationsOf(pom, scopes(pom)));
  const configuredSources: ConfiguredSources[] = [];
  for (const pom of poms) {
    const build = child(pom.project, "build");
    const main = childText(build, "sourceDirectory");
    const test = childText(build, "testSourceDirectory");
    const mainPath = main === undefined ? undefined : configuredPath(pom, main, root, scopes(pom));
    const testPath = test === undefined ? undefined : configuredPath(pom, test, root, scopes(pom));
    if (mainPath !== undefined || testPath !== undefined) {
      configuredSources.push({
        projectDir: pom.dir,
        ...(mainPath === undefined ? {} : { main: mainPath }),
        ...(testPath === undefined ? {} : { test: testPath }),
      });
    }
  }

  const openApiInputs: Located<string>[] = [];
  const protoRoots: string[] = [];
  for (const pom of poms) {
    for (const declaration of declarationsOf(pom, scopes(pom))) {
      if (declaration.kind !== "plugin") continue;
      if (declaration.artifact === "openapi-generator-maven-plugin") {
        for (const input of pluginConfig(declaration, "inputSpec")) {
          const resolved = configuredPath(pom, input, root, scopes(pom));
          if (resolved !== undefined) {
            openApiInputs.push({
              value: resolved,
              evidence: { ...declaration.evidence, description: "openapi-generator inputSpec" },
            });
          }
        }
      }
      if (declaration.artifact === "protobuf-maven-plugin") {
        const configured = pluginConfig(declaration, "protoSourceRoot")
          .map((value) => configuredPath(pom, value, root, scopes(pom)))
          .filter((value): value is string => value !== undefined);
        protoRoots.push(
          ...(configured.length > 0 ? configured : [joinRepoPath(pom.dir, "src/main/proto")]),
        );
      }
    }
  }

  const toolVersion = await wrapperVersion(repo, root);
  const wrapper = await firstExisting(repo, [
    joinRepoPath(root, "mvnw"),
    joinRepoPath(root, "mvnw.cmd"),
  ]);
  const javaVersion = javaVersionOf(poms, declarations, scopes);
  return {
    tool: "maven",
    root,
    primaryFile: rootPom.path,
    buildFiles: poms.map((pom) => ({ path: pom.path, text: pom.text })),
    projectDirs: unique(poms.map((pom) => pom.dir)),
    declarations,
    ...(javaVersion === undefined ? {} : { javaVersion }),
    ...(toolVersion === undefined ? {} : { toolVersion }),
    ...(wrapper === undefined ? {} : { wrapper }),
    configuredSources,
    openApiInputs: dedupeLocated(openApiInputs),
    protoRoots: unique(protoRoots),
  };
}

export function dedupeLocated<T>(items: readonly Located<T>[]): Located<T>[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
