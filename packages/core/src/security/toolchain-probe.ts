import type { ToolAvailability, ToolchainProbe } from "../ports/language-adapter.js";
import { findOnPath } from "./invocation.js";

/** Tool names a probe may look up: bare names, no paths, no shell syntax. */
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/**
 * Answers "is this tool on PATH?" for adapters, without starting any process. Relative PATH
 * entries are ignored (see `findOnPath`), so a repository cannot make a tool appear available
 * by shipping a file with its name. Versions are not probed: finding one would mean running
 * the tool. Results are cached for the lifetime of the probe.
 */
export class PathToolchainProbe implements ToolchainProbe {
  readonly platform: NodeJS.Platform;
  private readonly env: Readonly<Record<string, string>>;
  private readonly cache = new Map<string, Promise<ToolAvailability>>();

  constructor(
    options: {
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly platform?: NodeJS.Platform;
    } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env ?? process.env)) {
      if (value !== undefined) env[name] = value;
    }
    this.env = env;
  }

  probe(tool: string): Promise<ToolAvailability> {
    if (!TOOL_NAME.test(tool)) return Promise.resolve({ available: false });
    const key = this.platform === "win32" ? tool.toLowerCase() : tool;
    let result = this.cache.get(key);
    if (result === undefined) {
      result = findOnPath(tool, this.env, this.platform).then((found) => ({
        available: found !== undefined,
      }));
      this.cache.set(key, result);
    }
    return result;
  }
}

/**
 * The probe of the container backend (ADR 0020): tools come from the image, which DevFlow
 * cannot inspect without running it, so every valid tool name is reported as available and
 * the platform is Linux. A tool the image lacks makes the container fail to start, and the
 * gate is reported as not executed, never as passed.
 */
export class ContainerToolchainProbe implements ToolchainProbe {
  readonly platform: NodeJS.Platform = "linux";

  probe(tool: string): Promise<ToolAvailability> {
    return Promise.resolve({ available: TOOL_NAME.test(tool) });
  }
}

/** A probe with a fixed answer per tool, for tests and dry runs. */
export class StaticToolchainProbe implements ToolchainProbe {
  readonly platform: NodeJS.Platform;
  private readonly tools: ReadonlyMap<string, ToolAvailability>;

  constructor(
    available: readonly string[] | Readonly<Record<string, ToolAvailability>>,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.platform = platform;
    const tools = new Map<string, ToolAvailability>();
    if (isToolList(available)) {
      for (const tool of available) tools.set(tool, { available: true });
    } else {
      for (const [tool, availability] of Object.entries(available)) tools.set(tool, availability);
    }
    this.tools = tools;
  }

  probe(tool: string): Promise<ToolAvailability> {
    return Promise.resolve(this.tools.get(tool) ?? { available: false });
  }
}

function isToolList(
  value: readonly string[] | Readonly<Record<string, ToolAvailability>>,
): value is readonly string[] {
  return Array.isArray(value);
}
