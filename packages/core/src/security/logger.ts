import type { SecretRedactor } from "./secrets.js";

/**
 * A small structured logger. Every message and field is redacted before it reaches the sink,
 * so diagnostics can never leak a secret that the redactor recognizes.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A logger that adds `fields` to every record. */
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  readonly sink: (record: LogRecord) => void;
  readonly redactor: SecretRedactor;
  readonly level?: LogLevel;
  readonly clock?: () => Date;
}

export function createLogger(
  options: LoggerOptions,
  bindings: Record<string, unknown> = {},
): Logger {
  const minimum = LEVEL_ORDER[options.level ?? "info"];
  const log =
    (level: LogLevel) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      if (LEVEL_ORDER[level] < minimum) return;
      options.sink({
        level,
        time: (options.clock?.() ?? new Date()).toISOString(),
        message: options.redactor.redactText(message),
        fields: options.redactor.redactValue({ ...bindings, ...fields }),
      });
    };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (fields) => createLogger(options, { ...bindings, ...fields }),
  };
}

/** A logger that discards everything. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
