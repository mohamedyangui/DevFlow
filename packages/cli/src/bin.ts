#!/usr/bin/env node
import { ExitCode } from "./exit-codes.js";
import { processIo } from "./io.js";
import { runCli } from "./run.js";

try {
  process.exitCode = await runCli(process.argv.slice(2), processIo());
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`devflow: unexpected internal error. Please report it.\n${detail}\n`);
  process.exitCode = ExitCode.InternalError;
}
