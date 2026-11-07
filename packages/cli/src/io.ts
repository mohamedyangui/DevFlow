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
}

export function processIo(): CliIo {
  return {
    stdout: { write: (text) => process.stdout.write(text), isTTY: process.stdout.isTTY },
    stderr: { write: (text) => process.stderr.write(text), isTTY: process.stderr.isTTY },
    cwd: process.cwd(),
    env: process.env,
  };
}

export type Colors = ReturnType<typeof createColors>;

/** Colors only for interactive terminals, honouring NO_COLOR, FORCE_COLOR and TERM=dumb. */
export function colorsFor(output: CliOutput, env: CliIo["env"]): Colors {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  const disabled = env.NO_COLOR !== undefined || env.TERM === "dumb";
  return createColors(forced || (output.isTTY === true && !disabled));
}
