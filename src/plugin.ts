import type { CommandContext } from "./context.ts";

export type { CommandContext } from "./context.ts";

export type CommandHandler = (
  args: string[],
  context: CommandContext,
) => void | Promise<void>;

export interface CoreDependencies {
  readonly tx: {
    readonly version: string;
  };
  readonly react: typeof import("react");
  readonly ink: typeof import("ink");
  readonly versions: {
    readonly react: string;
    readonly ink: string;
  };
}

export interface PluginAPI {
  command(path: string | readonly string[], handler: CommandHandler): void;
  readonly dependencies: CoreDependencies;
}

export type Plugin = (api: PluginAPI) => void | Promise<void>;
