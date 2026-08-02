import * as ink from "ink";
import * as react from "react";
import packageMetadata from "../package.json" with { type: "json" };

import type { CommandRegistration, CommandRegistry } from "./commands.ts";
import type { CommandOwner } from "./context.ts";
import marketplacePlugin from "./first-party/marketplace.ts";
import type {
  CommandHandler,
  CoreDependencies,
  Plugin,
  PluginAPI,
} from "./plugin.ts";

export const coreDependencies: CoreDependencies = Object.freeze({
  tx: Object.freeze({ version: packageMetadata.version }),
  react,
  ink,
  versions: Object.freeze({
    react: packageMetadata.dependencies.react,
    ink: packageMetadata.dependencies.ink,
  }),
});

export interface PluginModule {
  readonly default?: unknown;
}

export type PluginSource = Plugin | PluginModule;

function pluginName(owner: CommandOwner): string {
  return `${owner.marketplace}/${owner.plugin}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  const valueType = typeof value;
  return (
    value !== null &&
    (valueType === "object" || valueType === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
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

export async function initializeFirstPartyPlugins(
  registry: CommandRegistry,
): Promise<void> {
  await initializePlugin(
    registry,
    { marketplace: "core", plugin: "marketplace" },
    marketplacePlugin,
  );
}

export async function initializePlugin(
  registry: CommandRegistry,
  owner: CommandOwner,
  source: PluginSource,
): Promise<void> {
  const scopedOwner = Object.freeze({ ...owner });
  const plugin = resolvePlugin(source, scopedOwner);
  let registrations: CommandRegistration[] | undefined = [];
  const api: PluginAPI = Object.freeze({
    command(path: string | readonly string[], handler: CommandHandler) {
      if (!registrations) {
        throw new Error(
          `Plugin ${pluginName(scopedOwner)} cannot register commands after initialization`,
        );
      }
      registrations.push({ path, owner: scopedOwner, handler });
    },
    dependencies: coreDependencies,
  });

  let batch: CommandRegistration[] = [];
  try {
    const result = plugin(api);
    if (isPromiseLike(result)) await result;
  } finally {
    batch = registrations ?? [];
    registrations = undefined;
  }

  registry.registerBatch(batch);
}
