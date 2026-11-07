import { createInterface } from "node:readline/promises";
import { createColors } from "picocolors";

export interface CliOutput {
  write(text: string): void;
  readonly isTTY?: boolean;
}

/** Everything the CLI touches in its environment, injectable for tests. */
export interface CliIo {
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Asks the user a question and resolves with the answer. Absent when there is no interactive
   * terminal (CI, pipes): commands that need a confirmation then require an explicit flag.
   */
  readonly prompt?: (question: string) => Promise<string>;
}

export function processIo(): CliIo {
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  return {
    stdout: { write: (text) => process.stdout.write(text), isTTY: process.stdout.isTTY },
    stderr: { write: (text) => process.stderr.write(text), isTTY: process.stderr.isTTY },
    cwd: process.cwd(),
    env: process.env,
    ...(interactive ? { prompt: askOnTerminal } : {}),
  };
}

/** Prompts on stderr so that stdout stays usable for the command's own output. */
async function askOnTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

export type Colors = ReturnType<typeof createColors>;

/** Colors only for interactive terminals, honouring NO_COLOR, FORCE_COLOR and TERM=dumb. */
export function colorsFor(output: CliOutput, env: CliIo["env"]): Colors {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  const disabled = env.NO_COLOR !== undefined || env.TERM === "dumb";
  return createColors(forced || (output.isTTY === true && !disabled));
}
