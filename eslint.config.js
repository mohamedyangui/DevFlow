// @ts-check
import { readFileSync } from "node:fs";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * The npm scope (ADR 0016) and the allowed workspace dependencies per package (ADR 0003) are
 * declared once, in the root package.json under "devflow". tests/repo/packages.test.ts checks
 * the package manifests and build references against the same table.
 * @type {{ npmScope: string, packageBoundaries: Record<string, string[] | "*"> }}
 */
const settings = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).devflow;
const scope = settings.npmScope;
const internalDependencies = Object.fromEntries(
  Object.entries(settings.packageBoundaries).map(([pkg, allowed]) => [
    pkg,
    allowed === "*" ? null : allowed,
  ]),
);

const processModules = ["child_process", "node:child_process"];
const fsModules = ["fs", "node:fs", "fs/promises", "node:fs/promises"];
const networkModules = ["net", "http", "https", "http2", "tls", "dgram"].flatMap((m) => [
  m,
  `node:${m}`,
]);

/**
 * @param {string[]} names
 * @param {string} message
 */
function restricted(names, message) {
  return names.map((name) => ({ name, message }));
}

/** The one file allowed to start processes: the executor's launcher (ADR 0003, ADR 0018). */
const processLauncher = "packages/core/src/security/process-launcher.ts";

/**
 * @param {string} pkg
 * @param {string[] | null} allowed
 * @param {{ allowProcesses?: boolean }} [options]
 */
function boundaryConfig(pkg, allowed, options = {}) {
  const isAdapter = pkg.startsWith("adapter-");
  const paths = [
    ...(options.allowProcesses === true
      ? []
      : restricted(
          processModules,
          "Processes may only be started by the policy-gated executor in core (ADR 0006, ADR 0014).",
        )),
    ...(isAdapter
      ? [
          ...restricted(
            fsModules,
            "Adapters read the repository only through RepositoryView (ADR 0003).",
          ),
          ...restricted(networkModules, "Adapters must not perform network access (ADR 0003)."),
        ]
      : []),
  ];
  const patterns =
    allowed === null
      ? []
      : [
          {
            group: [`${scope}/*`, ...allowed.map((dep) => `!${scope}/${dep}`)],
            message: `${scope}/${pkg} may only depend on: ${
              allowed.length > 0 ? allowed.map((dep) => `${scope}/${dep}`).join(", ") : "nothing"
            } (ADR 0003).`,
          },
        ];
  return {
    files: [`packages/${pkg}/src/**/*.ts`],
    rules: { "no-restricted-imports": ["error", { paths, patterns }] },
  };
}

export default defineConfig(
  // The example repositories are projects of their own, with their own tools.
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "dist-npm/",
    "coverage/",
    "schemas/",
    "examples/",
    // Local agent worktrees: full copies of the repository, never committed.
    ".claude/",
  ]),
  {
    files: ["**/*.{ts,js,mjs}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // `const { omitted, ...rest } = value` is the idiomatic way to drop a property.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Scripts are small CLI utilities; console output is their interface.
    files: ["scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  ...Object.entries(internalDependencies).map(([pkg, allowed]) => boundaryConfig(pkg, allowed)),
  {
    // The single reviewed exception to the process rule; tests/repo/process-boundary.test.ts
    // checks that no other source file imports child_process.
    ...boundaryConfig("core", internalDependencies.core ?? [], { allowProcesses: true }),
    files: [processLauncher],
  },
);
