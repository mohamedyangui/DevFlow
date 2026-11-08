/**
 * Engineering context engine (docs/specs/context-engine.md): repository discovery, file
 * classification (including OpenAPI and Protobuf contract files), project instructions,
 * relevance ranking and context packing.
 */
export {
  ContextModule,
  ContextPack,
  ContractSummary,
  FileRole,
  Instruction,
  OpenApiSummary,
  PackedFile,
  ProtobufSummary,
  SkipReason,
} from "./schemas.js";
export { buildContext, DEFAULT_CONTEXT_BUDGET_TOKENS, type BuildContextOptions } from "./engine.js";
export {
  ALWAYS_EXCLUDED_DIRECTORIES,
  discoverFiles,
  type DiscoverOptions,
  type DiscoveredFile,
  type DiscoveryResult,
} from "./discover.js";
export { isInstructionFile, languageOf, moduleOf, roleOf } from "./classify.js";
export { looksLikeOpenApi, scanOpenApi, scanProtobuf } from "./contracts.js";
export {
  declarationLines,
  importsOf,
  outlineOf,
  regexImports,
  resolveImports,
  suffixIndexOf,
  type DeclarationLine,
} from "./outline.js";
export {
  FallbackSourceParser,
  TreeSitterSourceParser,
  grammarFor,
  regexParse,
  renderOutline,
} from "./source-parser.js";
export { Bm25Index, tokenize, type Bm25Document, type Bm25Match } from "./bm25.js";
export {
  rankFiles,
  taskIdentifiers,
  taskQueryItems,
  type QueryItem,
  type RankCandidate,
  type RankedFile,
  type TaskIdentifier,
} from "./rank.js";
export { loadInstructions, type LoadInstructionsOptions } from "./instructions.js";
export { packFiles, type PackOptions } from "./pack.js";
export { estimateTokens, readTextForPrompt, type LoadedText } from "./files.js";
export { WorkspaceRepository, type WorkspaceRepositoryOptions } from "./repository.js";
