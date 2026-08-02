import * as ink from "ink";
import * as react from "react";

import type { CommandRegistration, CommandRegistry } from "./commands.ts";
import type { CommandOwner } from "./context.ts";
import type {
  CommandHandler,
  CoreDependencies,
  Plugin,
  PluginAPI,
} from "./plugin.ts";

const TX_VERSION = "0.0.0";
const REACT_VERSION = "19.2.8";
const INK_VERSION = "7.1.1";

export const coreDependencies: CoreDependencies = Object.freeze({
  tx: Object.freeze({ version: TX_VERSION }),
  react,
  ink,
  versions: Object.freeze({
    react: REACT_VERSION,
    ink: INK_VERSION,
  }),
});

export type PluginModule = Readonly<Record<string, unknown>> & {
  readonly default?: unknown;
};

export type PluginSource = Plugin | PluginModule;

function pluginName(owner: CommandOwner): string {
  return `${owner.marketplace}/${owner.plugin}`;
}

function resolvePlugin(source: PluginSource, owner: CommandOwner): Plugin {
  const candidate = typeof source === "function" ? source : source.default;
  if (typeof candidate !== "function") {
    throw new Error(
      `Plugin ${pluginName(owner)} must default-export a function`,
    );
  }
  return candidate as Plugin;
}

export async function initializePlugin(
  registry: CommandRegistry,
  owner: CommandOwner,
  source: PluginSource,
): Promise<void> {
  const scopedOwner = Object.freeze({ ...owner });
  const plugin = resolvePlugin(source, scopedOwner);
  const registrations: CommandRegistration[] = [];
  const api: PluginAPI = Object.freeze({
    command(path: string | readonly string[], handler: CommandHandler) {
      registrations.push({ path, owner: scopedOwner, handler });
    },
    dependencies: coreDependencies,
  });

  await plugin(api);
  registry.registerBatch(registrations);
}
