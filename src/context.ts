export interface CommandOwner {
  readonly marketplace: string;
  readonly plugin: string;
}

export interface CommandContext extends CommandOwner {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export type CommandProcessContext = Omit<
  CommandContext,
  "marketplace" | "plugin"
>;

export function createProcessContext(): CommandProcessContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}
