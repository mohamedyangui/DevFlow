import { z } from "zod";
import { Confidence, Evidence, ModuleId, RepoGlob, RepoPath } from "./primitives.js";
import { TestLevel } from "./verification.js";

/**
 * Data produced by language adapters (docs/specs/language-adapter.md). Every detection
 * carries evidence, so a human can check why DevFlow believes something about a project.
 */

export const Detection = z.strictObject({
  /** Stable identifier, e.g. `maven`, `spring-boot`, `junit5`, `vitest`. */
  id: z.string().min(1),
  version: z.string().min(1).optional(),
  confidence: Confidence,
  evidence: z.array(Evidence).min(1),
});
export type Detection = z.infer<typeof Detection>;

/** A project root that an adapter can handle. */
export const ModuleCandidate = z.strictObject({
  adapterId: z.string().min(1),
  root: RepoPath,
  confidence: Confidence,
  evidence: z.array(Evidence).min(1),
});
export type ModuleCandidate = z.infer<typeof ModuleCandidate>;

export const ContractKind = z.enum(["openapi", "protobuf"]);
export type ContractKind = z.infer<typeof ContractKind>;

/**
 * How a module relates to a shared contract file (ADR 0017):
 * - `defines`: the contract file lives in, and is owned by, this module;
 * - `generates-code-from`: the module's build generates code from the contract
 *   (e.g. protobuf-maven-plugin, ts-proto, openapi-generator);
 * - `consumes-generated-code`: the module imports code generated from the contract by
 *   another module or a shared package.
 */
export const ContractRelation = z.strictObject({
  kind: ContractKind,
  path: RepoPath,
  role: z.enum(["defines", "generates-code-from", "consumes-generated-code"]),
  evidence: z.array(Evidence).min(1),
});
export type ContractRelation = z.infer<typeof ContractRelation>;

export const ModuleProfile = z.strictObject({
  moduleId: ModuleId,
  adapterId: z.string().min(1),
  root: RepoPath,
  languages: z.array(Detection),
  buildTool: Detection.extend({ wrapper: RepoPath.optional() }).optional(),
  frameworks: z.array(Detection),
  testFrameworks: z.array(Detection),
  qualityTools: z.array(Detection),
  sourceRoots: z.array(RepoPath),
  testRoots: z.array(RepoPath),
  contracts: z.array(ContractRelation),
});
export type ModuleProfile = z.infer<typeof ModuleProfile>;

/** A convention inferred from existing code, e.g. "37/40 controller tests use @WebMvcTest". */
export const InferredConvention = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  appliesTo: z.array(RepoGlob),
  confidence: Confidence,
  evidence: z.array(Evidence).min(1),
});
export type InferredConvention = z.infer<typeof InferredConvention>;

export const TestInventory = z.strictObject({
  moduleId: ModuleId,
  files: z.array(
    z.strictObject({
      path: RepoPath,
      framework: z.string().min(1),
      level: TestLevel.optional(),
    }),
  ),
  namingPatterns: z.array(z.string()),
});
export type TestInventory = z.infer<typeof TestInventory>;

/**
 * How to write a test that fits the module, including where to put the acceptance-criterion
 * marker so traceability survives in machine-readable test reports (ADR 0015).
 */
export const TestAuthoringGuide = z.strictObject({
  framework: z.string().min(1),
  testRoot: RepoPath,
  /** e.g. `{name}Test.java` or `{name}.test.ts`. */
  fileNamePattern: z.string().min(1),
  acMarker: z.strictObject({
    style: z.enum(["title-prefix", "method-name-prefix"]),
    example: z.string().min(1),
  }),
  notes: z.array(z.string()),
});
export type TestAuthoringGuide = z.infer<typeof TestAuthoringGuide>;
