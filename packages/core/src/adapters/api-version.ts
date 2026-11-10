import { DevflowError, ErrorCode } from "../errors.js";
import { ADAPTER_API_VERSION } from "../ports/language-adapter.js";

/**
 * Adapter API versioning (docs/specs/language-adapter.md, section 12; ADR 0023). An adapter
 * declares the API version it targets; this DevFlow can use it when the major versions are
 * equal and the adapter's minor version is not above the host's. The patch version never
 * matters: it only fixes documentation or behaviour without changing the interface.
 */

export interface ApiVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/** Parses `major.minor.patch` (no pre-release or build suffix), or returns undefined. */
export function parseApiVersion(value: unknown): ApiVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = SEMVER.exec(value);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Why an adapter targeting `version` cannot run on a host implementing `host`, or undefined
 * when it can.
 */
export function apiVersionProblem(
  version: unknown,
  host: string = ADAPTER_API_VERSION,
): string | undefined {
  const hostVersion = parseApiVersion(host);
  if (hostVersion === undefined) return `the host API version ${host} is not valid`;
  const shown = typeof version === "string" ? version : JSON.stringify(version);
  const target = parseApiVersion(version);
  if (target === undefined) {
    return `API version ${shown} is not a version of the form major.minor.patch (this DevFlow implements ${host})`;
  }
  if (target.major !== hostVersion.major) {
    return `API version ${shown} is not supported: this DevFlow implements ${host}, and only adapters for major version ${String(hostVersion.major)} can run`;
  }
  if (target.minor > hostVersion.minor) {
    return `API version ${shown} is newer than this DevFlow (${host}); update DevFlow to use this adapter`;
  }
  return undefined;
}

/** Throws `ADAPTER_API_INCOMPATIBLE` unless an adapter targeting `version` can run here. */
export function checkApiVersion(adapterId: string, version: unknown): void {
  const problem = apiVersionProblem(version);
  if (problem === undefined) return;
  throw new DevflowError(
    ErrorCode.AdapterApiIncompatible,
    `adapter "${adapterId}" cannot be used: ${problem}`,
    { details: { adapter: adapterId, apiVersion: version, hostApiVersion: ADAPTER_API_VERSION } },
  );
}
