import type { ActionRegistry, JsonSchema } from "./index.js";

/** Exit codes are part of the CLI contract; changing one is breaking. */
export declare const EXIT: {
  readonly ok: 0;
  readonly error: 1;
  readonly usage: 2;
  readonly input: 3;
  readonly refused: 4;
  readonly conflict: 5;
  readonly not_found: 6;
  readonly timeout: 7;
};

export interface CliRunnerOptions {
  /** Program name shown in help. Defaults to the application ID. */
  name?: string;
  version?: string;
  /** The Surface ID this CLI reports as. Defaults to "cli". */
  surface?: string;
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
}

export declare class CliRunner {
  constructor(registry: ActionRegistry, options?: CliRunnerOptions);
  /** Resolve with the exit code. Never throws for user error. */
  run(argv?: string[]): Promise<number>;
  /** Run and assign `process.exitCode`. */
  main(argv?: string[]): Promise<number>;
  helpText(actionId?: string | null): string;
}

export declare function createCliRunner(
  registry: ActionRegistry,
  options?: CliRunnerOptions
): CliRunner;

export declare function parseFlags(
  schema: JsonSchema,
  args: string[]
): { value: Record<string, unknown>; error?: undefined } | { error: string; value?: undefined };
