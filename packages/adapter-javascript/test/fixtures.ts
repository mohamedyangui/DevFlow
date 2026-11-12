import { MemoryRepository } from "@devflow-ai/core/testing";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** An installed package: its manifest in node_modules, and its entry script. */
function installed(
  nodeModules: string,
  name: string,
  version: string,
  bin?: string | Record<string, string>,
): Record<string, string> {
  const dir = `${nodeModules}/${name}`;
  const files: Record<string, string> = {
    [`${dir}/package.json`]: json({ name, version, ...(bin === undefined ? {} : { bin }) }),
  };
  const scripts = bin === undefined ? [] : typeof bin === "string" ? [bin] : Object.values(bin);
  for (const script of scripts)
    files[`${dir}/${script.replace(/^\.\//, "")}`] = "#!/usr/bin/env node\n";
  return files;
}

/** A single TypeScript Express service with Vitest, ESLint, Prettier and an OpenAPI client. */
export function expressRepo(): MemoryRepository {
  return new MemoryRepository({
    "package.json": json({
      name: "orders-api",
      version: "1.0.0",
      type: "module",
      packageManager: "pnpm@9.12.0+sha512.abc",
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run",
        "generate:client":
          "openapi-typescript contracts/orders.openapi.yaml -o src/generated/orders.ts",
      },
      dependencies: { express: "^4.21.0" },
      devDependencies: {
        "@types/express": "^4.17.21",
        eslint: "^9.12.0",
        "openapi-typescript": "^7.4.0",
        prettier: "^3.3.3",
        supertest: "^7.0.0",
        typescript: "~5.6.2",
        vitest: "^2.1.2",
      },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "tsconfig.json": [
      "{",
      "  // Strict settings for the service",
      '  "compilerOptions": { "strict": true, "outDir": "dist", },',
      '  "include": ["src"],',
      "}",
      "",
    ].join("\n"),
    "eslint.config.js": "export default [];\n",
    ".prettierrc": "{}\n",
    "contracts/orders.openapi.yaml": "openapi: 3.1.0\ninfo:\n  title: Orders\n",
    "src/app.ts": 'import express from "express";\nexport const app = express();\n',
    "src/orders.ts": "export function page(n: number) { return n; }\n",
    "src/orders.test.ts": [
      'import { describe, expect, it } from "vitest";',
      'import { page } from "./orders";',
      "",
      'describe("orders", () => {',
      '  it("AC-1: returns the second page", () => {',
      "    expect(page(2)).toBe(2);",
      "  });",
      "});",
      "",
    ].join("\n"),
    "src/app.test.ts": [
      'import { describe, expect, it } from "vitest";',
      'import request from "supertest";',
      'import { app } from "./app";',
      "",
      'describe("AC-2", () => {',
      '  it("rejects a negative page", async () => {',
      "    expect((await request(app).get('/orders?page=-1')).status).toBe(400);",
      "  });",
      "});",
      "",
    ].join("\n"),
    "src/__tests__/helpers.ts": "export const fixture = { id: 1 };\n",
    "src/generated/orders.ts": "export interface paths {}\n",
    ...installed("node_modules", "express", "4.21.1"),
    ...installed("node_modules", "vitest", "2.1.3", { vitest: "./vitest.mjs" }),
    ...installed("node_modules", "eslint", "9.12.0", { eslint: "./bin/eslint.js" }),
    ...installed("node_modules", "typescript", "5.6.3", {
      tsc: "./bin/tsc",
      tsserver: "./bin/tsserver",
    }),
    ...installed("node_modules", "prettier", "3.3.3", "./bin/prettier.cjs"),
  });
}

/**
 * A pnpm workspace: a React and Vite app with Vitest and Playwright, a NestJS API with Jest
 * and its own test directory, and a package of Protobuf contracts with code generation. The
 * workspace root declares the shared quality tools.
 */
export function monorepoRepo(): MemoryRepository {
  return new MemoryRepository({
    "package.json": json({
      name: "shop",
      private: true,
      devDependencies: { eslint: "^9.12.0", prettier: "^3.3.3", typescript: "^5.6.2" },
    }),
    "pnpm-workspace.yaml": [
      "packages:",
      "  - 'apps/*'",
      '  - "packages/*" # libraries',
      "  - '!**/fixtures/**'",
      "",
    ].join("\n"),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "tsconfig.json": json({
      files: [],
      references: [{ path: "apps/web" }, { path: "packages/api" }],
    }),
    "eslint.config.mjs": "export default [];\n",
    "apps/web/package.json": json({
      name: "@shop/web",
      private: true,
      dependencies: { react: "^18.3.1" },
      devDependencies: { "@playwright/test": "^1.48.0", vite: "^5.4.8", vitest: "^2.1.2" },
    }),
    "apps/web/tsconfig.json": json({ extends: "../../tsconfig.base.json", include: ["src"] }),
    "apps/web/vite.config.ts": "export default {};\n",
    "apps/web/playwright.config.ts": "export default { testDir: './e2e' };\n",
    "apps/web/src/App.tsx": "export function App() { return null; }\n",
    "apps/web/src/App.test.tsx": [
      'import { expect, test } from "vitest";',
      'test("AC-1: renders the cart", () => { expect(1).toBe(1); });',
      "",
    ].join("\n"),
    "apps/web/src/Cart.spec.tsx": [
      'import { expect, test } from "vitest";',
      'test("AC-3: shows the total", () => { expect(1).toBe(1); });',
      "",
    ].join("\n"),
    "apps/web/e2e/checkout.spec.ts": [
      'import { test } from "@playwright/test";',
      'test("AC-4: checks out", async ({ page }) => { await page.goto("/"); });',
      "",
    ].join("\n"),
    "apps/web/src/legacy/package.json": json({ type: "commonjs" }),
    "apps/web/src/legacy/old.js": "module.exports = 1;\n",
    "packages/api/package.json": json({
      name: "@shop/api",
      dependencies: { "@nestjs/core": "^10.4.4", "@nestjs/common": "^10.4.4" },
      devDependencies: { jest: "^29.7.0", "ts-jest": "^29.2.5" },
      jest: { preset: "ts-jest" },
    }),
    "packages/api/tsconfig.json": json({
      compilerOptions: { strict: true },
      include: ["src", "test"],
    }),
    "packages/api/nest-cli.json": "{}\n",
    "packages/api/src/orders.service.ts": "export class OrdersService {}\n",
    "packages/api/test/orders.service.test.ts": [
      'describe("OrdersService", () => {',
      '  it("AC-1: lists orders", () => { expect(1).toBe(1); });',
      "});",
      "",
    ].join("\n"),
    "packages/api/test/orders.int.test.ts": [
      'describe("orders API", () => {',
      '  it("AC-2: pages results", () => { expect(1).toBe(1); });',
      "});",
      "",
    ].join("\n"),
    "packages/api/test/fixtures/sample/package.json": json({ name: "sample-fixture" }),
    "packages/proto/package.json": json({
      name: "@shop/proto",
      scripts: { generate: "buf generate" },
      devDependencies: { "ts-proto": "^2.2.0", "@bufbuild/buf": "^1.45.0" },
    }),
    "packages/proto/buf.gen.yaml": "version: v2\n",
    "packages/proto/proto/orders.proto": 'syntax = "proto3";\npackage shop;\n',
    ...installed("node_modules", "eslint", "9.12.0", { eslint: "./bin/eslint.js" }),
    ...installed("node_modules", "prettier", "3.3.3", "./bin/prettier.cjs"),
    ...installed("node_modules", "typescript", "5.6.3", { tsc: "./bin/tsc" }),
    ...installed("apps/web/node_modules", "react", "18.3.1"),
    ...installed("apps/web/node_modules", "vite", "5.4.8", { vite: "./bin/vite.js" }),
    ...installed("apps/web/node_modules", "vitest", "2.1.3", { vitest: "./vitest.mjs" }),
    ...installed("apps/web/node_modules", "@playwright/test", "1.48.0", { playwright: "./cli.js" }),
    ...installed("packages/api/node_modules", "jest", "29.7.0", "./bin/jest.js"),
    ...installed("packages/api/node_modules", "@nestjs/core", "10.4.4"),
  });
}

/** A JavaScript package tested with Mocha, installed with npm, no TypeScript. */
export function mochaRepo(): MemoryRepository {
  return new MemoryRepository({
    "package.json": json({
      name: "legacy-lib",
      version: "0.3.0",
      main: "index.js",
      scripts: { test: "mocha" },
      devDependencies: { mocha: "^10.7.3", chai: "^4.5.0" },
    }),
    "package-lock.json": json({ lockfileVersion: 3 }),
    ".mocharc.json": json({ spec: "test/**/*.js" }),
    "index.js": "module.exports = { sum: (a, b) => a + b };\n",
    "test/sum.js": [
      'const { expect } = require("chai");',
      'describe("sum", () => { it("AC-1: adds", () => { expect(1).to.equal(1); }); });',
      "",
    ].join("\n"),
    "test/support.js": "module.exports = {};\n",
  });
}
