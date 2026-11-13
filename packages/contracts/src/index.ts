/**
 * @devflowai/contracts: contract compatibility verification (Phase 6, ADR 0021).
 *
 * OpenAPI 3.x and Protobuf parsers written in-house, built-in breaking-change rules, and the
 * optional `oasdiff` and `buf` integration through the command policy. Compatibility is
 * decided by rules or tools, never by a model.
 */
export {
  ContractChange,
  ContractCompatibility,
  ContractDecider,
  ContractDiff,
  ContractLocation,
  summarize,
} from "./schemas.js";
export {
  compareContract,
  compareContractBuiltin,
  contractKindOf,
  externalRefs,
  looksLikeOpenApi,
  type CompareInput,
  type ToolInput,
} from "./compare.js";
export {
  BUF_ANNOTATIONS_EXIT_CODE,
  BUF_COMMAND,
  BufAnnotation,
  CONTRACT_PATH_PATTERN,
  OASDIFF_COMMAND,
  OasdiffEntry,
  parseBufOutput,
  parseOasdiffOutput,
  runContractTool,
  type ContractTool,
  type ContractToolset,
  type ToolRun,
} from "./tools.js";
export {
  HTTP_METHODS,
  OpenApiDocument,
  operationKey,
  type OpenApiOperation,
  type OpenApiParameter,
  type Resolved,
} from "./openapi/document.js";
export { OpenApiComparison } from "./openapi/diff.js";
export {
  MAX_ENUM_NUMBER,
  MAX_FIELD_NUMBER,
  ProtoParseError,
  parseProto,
  tokenize,
  type ProtoEnum,
  type ProtoEnumValue,
  type ProtoField,
  type ProtoFile,
  type ProtoLabel,
  type ProtoMessage,
  type ProtoRange,
  type ProtoReserved,
  type ProtoRpc,
  type ProtoService,
} from "./protobuf/parse.js";
export { ProtobufComparison } from "./protobuf/diff.js";
export {
  ConsumerIndex,
  MAX_CONSUMERS_PER_CHANGE,
  contractImpact,
  findConsumers,
  matchEndpoint,
  type ConsumerRepository,
  type ConsumerSearch,
  type ConsumerSource,
} from "./impact/find.js";
export { pathSegments, scanFile, type HttpEndpoint, type ScannedFile } from "./impact/scan.js";
export { protoTarget, protocCamelCase, type ProtoTarget } from "./impact/protobuf.js";
export { ConsumerRef, ContractImpact } from "@devflowai/core";
