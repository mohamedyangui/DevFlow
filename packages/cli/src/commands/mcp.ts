import { type CommandRunner, McpServer, devflowTools, serveStdio } from "@devflow/mcp";
import { ExitCode } from "../exit-codes.js";
import type { CliIo } from "../io.js";
import { readCliVersion } from "../version.js";
import { currentUser } from "../workspace.js";

const INSTRUCTIONS =
  "DevFlow organises requirements and produces verification evidence. These tools validate tasks, " +
  "analyse and plan them, show runs and reports, run already-approved verification gates and review " +
  "local changes. Every approval stays with the developer, in a terminal: plans, tests and code " +
  "changes (devflow approve / devflow reject), workspace trust (devflow trust) and commands " +
  "(--allow). Never claim a check passed unless a DevFlow result says it ran and passed. Each " +
  "result lists the next steps.";

/**
 * `devflow mcp`: serves the DevFlow tools to an MCP client over stdio (ADR 0026). stdout
 * carries protocol messages only; diagnostics go to stderr. Each tool call runs a CLI command
 * in-process with `--json`, its output captured, and without a terminal: nothing is approved
 * interactively. Decisions are recorded as the user "(via MCP)".
 */
export async function mcpCommand(
  io: CliIo,
  runCli: (args: readonly string[], io: CliIo) => Promise<ExitCode>,
): Promise<ExitCode> {
  const input = io.stdin;
  if (input === undefined) {
    io.stderr.write("devflow: `devflow mcp` needs a standard input to read MCP messages from\n");
    return ExitCode.UsageError;
  }
  const log = (message: string): void => {
    io.stderr.write(`devflow mcp: ${message}\n`);
  };
  const user = `${currentUser(io.env)} (via MCP)`;
  const run: CommandRunner = async (args, { cwd, signal }) => {
    let stdout = "";
    let stderr = "";
    const callIo: CliIo = {
      stdout: {
        write: (text) => {
          stdout += text;
        },
        isTTY: false,
      },
      stderr: {
        write: (text) => {
          stderr += text;
        },
        isTTY: false,
      },
      cwd,
      env: { ...io.env, DEVFLOW_USER: user },
      // No `prompt`: nothing can be approved interactively through MCP.
      interrupts: () => ({ signal, dispose: () => undefined }),
      ...(io.createProvider === undefined ? {} : { createProvider: io.createProvider }),
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      ...(io.gitClient === undefined ? {} : { gitClient: io.gitClient }),
    };
    const exitCode = await runCli(args, callIo);
    if (stderr.trim() !== "") log(`${args.slice(0, 2).join(" ")}: ${stderr.trim()}`);
    return { exitCode, stdout, stderr };
  };
  const server = new McpServer({
    name: "devflow",
    version: readCliVersion(),
    tools: devflowTools({ run, defaultWorkspace: io.cwd }),
    instructions: INSTRUCTIONS,
    log,
  });
  log(`serving the DevFlow tools on stdio (workspace ${io.cwd})`);
  await serveStdio(server, { input, output: io.stdout, log });
  return ExitCode.Success;
}
