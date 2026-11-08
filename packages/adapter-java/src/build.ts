import {
  fileEvidence,
  isWithin,
  joinRepoPath,
  repoDirname,
  type ModuleCandidate,
  type RepositoryView,
} from "@devflow/core";
import { BUILD_FILES, SETTINGS_FILES, loadGradleBuild } from "./gradle.js";
import { aggregatedPoms, loadMavenBuild, readPom, type Pom } from "./maven.js";
import type { BuildModel, BuildToolId } from "./model.js";
import { baseName, unique } from "./paths.js";

export const ADAPTER_ID = "java";

/**
 * Build files inside source sets are fixtures or resources (Maven plugin integration tests,
 * archetypes), not builds of their own.
 */
const FIXTURE_PATH =
  /(^|\/)src\/(test|it|main|testFixtures|integrationTest|functionalTest|intTest)\//;

async function anyExists(repo: RepositoryView, paths: readonly string[]): Promise<boolean> {
  for (const path of paths) if (await repo.exists(path)) return true;
  return false;
}

/**
 * The build tool of the build rooted at `root`. A directory with both a POM and Gradle files
 * is read as Maven, unless only Gradle has a wrapper there.
 */
export async function buildToolAt(
  repo: RepositoryView,
  root: string,
): Promise<BuildToolId | undefined> {
  const maven = await repo.exists(joinRepoPath(root, "pom.xml"));
  const gradle = await anyExists(
    repo,
    [...SETTINGS_FILES, ...BUILD_FILES].map((name) => joinRepoPath(root, name)),
  );
  if (maven && gradle) {
    const mavenWrapper = await anyExists(
      repo,
      ["mvnw", "mvnw.cmd"].map((n) => joinRepoPath(root, n)),
    );
    const gradleWrapper = await anyExists(
      repo,
      ["gradlew", "gradlew.bat"].map((n) => joinRepoPath(root, n)),
    );
    return gradleWrapper && !mavenWrapper ? "gradle" : "maven";
  }
  if (maven) return "maven";
  return gradle ? "gradle" : undefined;
}

/** Reads the build rooted at `root`, or undefined when there is none. */
export async function loadBuildModel(
  repo: RepositoryView,
  root: string,
): Promise<BuildModel | undefined> {
  const tool = await buildToolAt(repo, root);
  if (tool === "maven") return loadMavenBuild(repo, root);
  if (tool === "gradle") return loadGradleBuild(repo, root);
  return undefined;
}

/**
 * Finds Java builds. A module is one build: a Maven POM that no other POM aggregates, the
 * outermost directory with a Gradle settings file, or a Gradle build file outside every
 * settings directory. Modules of a multi-module build belong to its root.
 */
export async function detectJavaModules(repo: RepositoryView): Promise<ModuleCandidate[]> {
  const found = (
    await repo.glob(["**/pom.xml", ...[...SETTINGS_FILES, ...BUILD_FILES].map((f) => `**/${f}`)])
  )
    .filter((path) => !FIXTURE_PATH.test(path))
    .slice()
    .sort();
  const pomPaths = found.filter((path) => baseName(path) === "pom.xml");
  const settingsPaths = found.filter((path) => SETTINGS_FILES.includes(baseName(path)));
  const buildPaths = found.filter((path) => BUILD_FILES.includes(baseName(path)));

  const candidates = new Map<string, ModuleCandidate>();

  const aggregated = new Set<string>();
  const poms: Pom[] = [];
  for (const pomPath of pomPaths) {
    const pom = await readPom(repo, pomPath);
    if (pom === undefined) continue;
    poms.push(pom);
    for (const child of aggregatedPoms(pom)) aggregated.add(child);
  }
  for (const pom of poms) {
    if (aggregated.has(pom.path)) continue;
    const modules = aggregatedPoms(pom).length;
    candidates.set(pom.dir, {
      adapterId: ADAPTER_ID,
      root: pom.dir,
      confidence: pom.project === undefined ? 0.5 : 0.95,
      evidence: [
        fileEvidence(
          pom.path,
          pom.project === undefined
            ? "pom.xml (not readable as a Maven project)"
            : modules > 0
              ? `Maven build aggregating ${String(modules)} module(s)`
              : "Maven project (pom.xml)",
        ),
      ],
    });
  }

  const settingsDirs = unique(settingsPaths.map(repoDirname));
  const gradleRoots = settingsDirs.filter(
    (dir) => !settingsDirs.some((other) => other !== dir && isWithin(other, dir)),
  );
  for (const dir of gradleRoots) {
    if (candidates.has(dir) && (await buildToolAt(repo, dir)) === "maven") continue;
    const settings = settingsPaths.find((path) => repoDirname(path) === dir) ?? dir;
    candidates.set(dir, {
      adapterId: ADAPTER_ID,
      root: dir,
      confidence: 0.95,
      evidence: [fileEvidence(settings, "Gradle build (settings file)")],
    });
  }
  const gradleBuildDirs = new Set<string>();
  for (const buildPath of buildPaths) {
    const dir = repoDirname(buildPath);
    if (settingsDirs.some((settingsDir) => isWithin(settingsDir, dir))) continue;
    if (gradleBuildDirs.has(dir)) continue;
    if (candidates.has(dir) && (await buildToolAt(repo, dir)) === "maven") continue;
    gradleBuildDirs.add(dir);
    candidates.set(dir, {
      adapterId: ADAPTER_ID,
      root: dir,
      confidence: 0.9,
      evidence: [fileEvidence(buildPath, "Gradle build file")],
    });
  }

  return [...candidates.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}
