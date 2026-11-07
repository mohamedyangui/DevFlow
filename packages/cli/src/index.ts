/**
 * Programmatic entry point of the DevFlow CLI, used by tests and by tools that want to embed
 * the command line. The executable entry point is `bin.ts`.
 */
export { runCli } from "./run.js";
export { ExitCode } from "./exit-codes.js";
export { processIo, type CliIo, type CliOutput } from "./io.js";
