/// <reference types="node" />

import type { CommandContext } from "./context.ts";

export type { CommandContext } from "./context.ts";

export type CommandHandler = (
  args: string[],
  context: CommandContext,
) => void | Promise<void>;

export interface UserDataDirectoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
}

export interface MarketplaceCheckout {
  readonly name: string;
  readonly checkout: string;
}

export interface MarketplaceCapabilities {
  resolveDirectory(options?: UserDataDirectoryOptions): string;
  validateName(name: string): string;
  discover(root: string): Promise<readonly MarketplaceCheckout[]>;
  prepare(checkout: string): Promise<void>;
}

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
  readonly marketplace: MarketplaceCapabilities;
}

export interface PluginAPI {
  command(path: string | readonly string[], handler: CommandHandler): void;
  readonly dependencies: CoreDependencies;
}

export type Plugin = (api: PluginAPI) => void | Promise<void>;
