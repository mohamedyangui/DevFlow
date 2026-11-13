import { ModuleId, RepoPath, Sha256 } from "@devflowai/core";
import { z } from "zod";

/**
 * Data produced by the context engine. The context pack is persisted as a run artifact
 * (`artifacts/context.json`), so every selection can be inspected and explained afterwards.
 */

/** What a file is for. `contract` covers Protobuf and OpenAPI files (ADR 0017). */
export const FileRole = z.enum([
  "source",
  "test",
  "configuration",
  "documentation",
  "generated",
  "contract",
  "instructions",
  "other",
]);
export type FileRole = z.infer<typeof FileRole>;

/** Why a discovered file was not considered for a prompt. */
export const SkipReason = z.enum(["too-large", "binary", "sensitive", "symlink", "unreadable"]);
export type SkipReason = z.infer<typeof SkipReason>;

export const ProtobufSummary = z.strictObject({
  kind: z.literal("protobuf"),
  path: RepoPath,
  syntax: z.string().nullable(),
  package: z.string().nullable(),
  imports: z.array(z.string()),
  javaPackage: z.string().nullable(),
  javaOuterClassname: z.string().nullable(),
  messages: z.array(z.string()),
  enums: z.array(z.string()),
  services: z.array(z.string()),
});
export type ProtobufSummary = z.infer<typeof ProtobufSummary>;

export const OpenApiSummary = z.strictObject({
  kind: z.literal("openapi"),
  path: RepoPath,
  specVersion: z.string().nullable(),
  title: z.string().nullable(),
  paths: z.array(z.string()),
  operationIds: z.array(z.string()),
});
export type OpenApiSummary = z.infer<typeof OpenApiSummary>;

export const ContractSummary = z.discriminatedUnion("kind", [ProtobufSummary, OpenApiSummary]);
export type ContractSummary = z.infer<typeof ContractSummary>;

export const ContextModule = z.strictObject({
  id: ModuleId,
  root: RepoPath,
  adapter: z.string().min(1),
  /** `config`: declared in `.devflow/config.yaml`; `adapter`: detected; `default`: the root. */
  source: z.enum(["config", "adapter", "default"]),
});
export type ContextModule = z.infer<typeof ContextModule>;

/**
 * A project instruction file, tagged with its precedence rank (docs/specs/context-engine.md,
 * section 4). `trusted-config` marks project rules of a workspace the user has trusted;
 * everything else is repository content and never grants permissions.
 */
export const Instruction = z.strictObject({
  path: RepoPath,
  kind: z.enum(["project-rules", "agents", "readme"]),
  rank: z.union([z.literal(4), z.literal(5), z.literal(7)]),
  trust: z.enum(["trusted-config", "repository"]),
  text: z.string(),
  truncated: z.boolean(),
  sha256: Sha256,
});
export type Instruction = z.infer<typeof Instruction>;

export const PackedFile = z.strictObject({
  path: RepoPath,
  role: FileRole,
  language: z.string().nullable(),
  module: ModuleId.nullable(),
  /** `full`: the content; `outline`: declarations only; `listed`: the path only. */
  mode: z.enum(["full", "outline", "listed"]),
  score: z.number().nonnegative(),
  reasons: z.array(z.string()),
  /** Estimated tokens of `content` (0 for listed files). */
  tokens: z.int().nonnegative(),
  /** Redacted content or outline; absent for listed files. */
  content: z.string().optional(),
  /** Number of secrets redacted from this file's content. */
  redactions: z.int().nonnegative(),
});
export type PackedFile = z.infer<typeof PackedFile>;

export const ContextPack = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  budgetTokens: z.int().positive(),
  usedTokens: z.int().nonnegative(),
  modules: z.array(ContextModule),
  files: z.array(PackedFile),
  instructions: z.array(Instruction),
  contracts: z.array(ContractSummary),
  stats: z.strictObject({
    discovered: z.int().nonnegative(),
    considered: z.int().nonnegative(),
    skipped: z.record(SkipReason, z.int().nonnegative()),
    /** True when discovery stopped at the file limit. */
    truncated: z.boolean(),
  }),
  warnings: z.array(z.string()),
});
export type ContextPack = z.infer<typeof ContextPack>;
