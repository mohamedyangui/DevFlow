import { defineAdapter, type LanguageAdapter } from "@devflowai/core";
import { analyzePythonModule } from "./analyze.js";
import { pythonCommandCatalog } from "./commands.js";
import { parsePythonResults } from "./results.js";
import { discoverPythonTests, inferPythonConventions, pythonTestAuthoringGuide } from "./tests.js";
import { ADAPTER_ID, detectPythonModules } from "./workspace.js";

/**
 * The Python language adapter (docs/specs/language-adapter.md): uv, Poetry, Pipenv and pip
 * projects, virtual environments, Django, Flask and FastAPI, pytest and unittest, Ruff,
 * flake8, mypy and Pyright. It reads project files as text (`setup.py` is never run) and its
 * commands never install anything.
 */
export const pythonAdapter: LanguageAdapter = defineAdapter({
  id: ADAPTER_ID,
  displayName: "Python (uv, Poetry, pip)",
  apiVersion: "1.0.0",
  detectModules: detectPythonModules,
  analyzeModule: analyzePythonModule,
  inferConventions: inferPythonConventions,
  discoverTests: discoverPythonTests,
  testAuthoringGuide: pythonTestAuthoringGuide,
  commandCatalog: pythonCommandCatalog,
  parseResults: parsePythonResults,
});

export { applyRule, FRAMEWORK_RULES, QUALITY_RULES, TEST_FRAMEWORK_RULES } from "./analyze.js";
export {
  PYTEST_EXPRESSION,
  PYTHON_PARSERS,
  pythonCommandCatalog,
  resolveInterpreter,
  UNITTEST_PATTERN,
  type Interpreter,
} from "./commands.js";
export { readIni, readToml, tomlString, tomlStrings } from "./config-files.js";
export {
  declaredDependencies,
  findVirtualEnv,
  installedVersions,
  normalizeName,
  readProjectFiles,
  requirementName,
  type DeclaredDependency,
  type VirtualEnv,
} from "./manifest.js";
export {
  parseFlake8Output,
  parseMypyOutput,
  parsePytestJUnitXml,
  parseRuffJson,
  parseUnittestOutput,
  type PythonCase,
} from "./results.js";
export { acceptanceMarkers, primaryTestFramework } from "./tests.js";
export { buildToolOf, detectPythonModules } from "./workspace.js";
