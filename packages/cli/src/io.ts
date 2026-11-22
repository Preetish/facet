export const CLI_VERSION = "0.1.0";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function resolveCliIO(overrides?: Partial<CliIO>): CliIO {
  return {
    stdout:
      overrides?.stdout ??
      ((text: string): void => {
        process.stdout.write(text);
      }),
    stderr:
      overrides?.stderr ??
      ((text: string): void => {
        process.stderr.write(text);
      }),
    cwd: overrides?.cwd ?? process.cwd(),
    env: overrides?.env ?? process.env,
  };
}
