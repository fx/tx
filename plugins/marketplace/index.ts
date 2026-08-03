import { pathToFileURL } from "node:url";
import type { Plugin, PluginDefinition, PluginIdentity } from "tx/plugin";

import {
  MarketplaceManager,
  type MarketplaceOperations,
  parseAddMarketplaceArguments,
  parseListMarketplaceArguments,
  parseRemoveMarketplaceArguments,
} from "./manager.ts";
import {
  discoverInstalledMarketplaces,
  readMarketplaceManifest,
  resolveMarketplaceDirectory,
} from "./storage.ts";

export type { MarketplaceOperations } from "./manager.ts";

export interface MarketplacePluginOptions {
  readonly manager?: MarketplaceOperations;
}

interface PluginModule {
  readonly default?: unknown;
}

function childIdentity(name: string, parent: PluginIdentity): PluginIdentity {
  return Object.freeze({ name, parent });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryError(
  marketplace: string,
  plugin: string | undefined,
  error: unknown,
): Error {
  const subject = plugin
    ? `Marketplace "${marketplace}" plugin "${plugin}"`
    : `Marketplace "${marketplace}"`;
  return new Error(
    `${subject} failed: ${errorMessage(error)}. Run "tx marketplace remove ${marketplace}" to remove it.`,
  );
}

function entryDefinition(
  marketplace: string,
  name: string,
  entryPath: string,
  parent: PluginIdentity,
): PluginDefinition {
  return Object.freeze({
    identity: childIdentity(name, parent),
    async load(): Promise<Plugin> {
      try {
        const source: PluginModule = await import(
          pathToFileURL(entryPath).href
        );
        if (typeof source.default !== "function") {
          throw new Error(`Plugin ${name} must default-export a function`);
        }
        const loaded = source.default as Plugin;
        return async (api) => {
          try {
            await loaded(api);
          } catch (error) {
            throw recoveryError(marketplace, name, error);
          }
        };
      } catch (error) {
        throw recoveryError(marketplace, name, error);
      }
    },
  });
}

function marketplaceDefinition(
  name: string,
  checkout: string,
  parent: PluginIdentity,
): PluginDefinition {
  const identity = childIdentity(name, parent);
  return Object.freeze({
    identity,
    async load(): Promise<Plugin> {
      try {
        const manifest = await readMarketplaceManifest(checkout);
        return ({ plugin }) => {
          for (const entry of manifest.plugins) {
            plugin(
              entryDefinition(name, entry.name, entry.entryPath, identity),
            );
          }
        };
      } catch (error) {
        throw recoveryError(name, undefined, error);
      }
    },
  });
}

function discoveryDefinition(
  root: string,
  parent: PluginIdentity,
): PluginDefinition {
  const identity = childIdentity("installed", parent);
  return Object.freeze({
    identity,
    async load(): Promise<Plugin> {
      const marketplaces = await discoverInstalledMarketplaces(root);
      return ({ plugin }) => {
        for (const marketplace of marketplaces) {
          plugin(
            marketplaceDefinition(
              marketplace.name,
              marketplace.checkout,
              identity,
            ),
          );
        }
      };
    },
  });
}

export function createMarketplacePlugin(
  options: MarketplacePluginOptions = {},
): PluginDefinition {
  const identity: PluginIdentity = Object.freeze({ name: "marketplace" });
  return Object.freeze({
    identity,
    load(): Plugin {
      return ({ command, env, plugin }) => {
        const root = resolveMarketplaceDirectory({ env });
        const manager =
          options.manager ?? new MarketplaceManager(root, { env });

        command("marketplace add", async (args, context) => {
          const parsed = parseAddMarketplaceArguments(args);
          const name = await manager.add(parsed.repository, parsed.name);
          context.stdout.write(`Added marketplace "${name}".\n`);
        });

        command("marketplace list", async (args, context) => {
          parseListMarketplaceArguments(args);
          for (const marketplace of await manager.list()) {
            context.stdout.write(
              `${marketplace.name}\t${marketplace.source}\n`,
            );
          }
        });

        command("marketplace remove", async (args, context) => {
          const name = parseRemoveMarketplaceArguments(args);
          await manager.remove(name);
          context.stdout.write(`Removed marketplace "${name}".\n`);
        });

        plugin(discoveryDefinition(root, identity));
      };
    },
  });
}

const marketplacePlugin = createMarketplacePlugin();
export default marketplacePlugin;
