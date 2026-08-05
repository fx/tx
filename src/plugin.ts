/// <reference types="node" />

import type { CommandContext } from "./context.ts";

export type { Command } from "commander";
export type { CommandContext } from "./context.ts";

export type CommandHandler = (
  args: string[],
  context: CommandContext,
) => void | Promise<void>;

export interface PluginIdentity {
  readonly name: string;
  readonly parent?: PluginIdentity;
}

export interface CoreDependencies {
  readonly tx: {
    readonly version: string;
  };
  readonly react: typeof import("react");
  readonly ink: typeof import("ink");
  readonly commander: typeof import("commander");
  readonly versions: {
    readonly react: string;
    readonly ink: string;
    readonly commander: string;
  };
}

export interface PluginDefinition {
  readonly identity: PluginIdentity;
  load(): Plugin | Promise<Plugin>;
}

export interface PluginAPI {
  readonly identity: PluginIdentity;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dependencies: CoreDependencies;
  command(path: string | readonly string[], handler: CommandHandler): void;
  plugin(definition: PluginDefinition): void;
}

export type Plugin = (api: PluginAPI) => void | Promise<void>;
