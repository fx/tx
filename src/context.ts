import type { PluginIdentity } from "./plugin.ts";

export interface CommandContext {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  plugin: PluginIdentity;
}

export type CommandProcessContext = Omit<CommandContext, "plugin">;

export function createProcessContext(): CommandProcessContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}
