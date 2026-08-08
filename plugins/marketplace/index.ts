import type { Plugin, PluginDefinition, PluginIdentity } from "@fx/tx/plugin";

import { MarketplaceManager, type MarketplaceOperations } from "./manager.ts";
import { importPluginEntry } from "./module.ts";
import {
  discoverInstalledMarketplaces,
  type MarketplaceCheckout,
  readMarketplaceManifest,
  resolveMarketplaceDirectory,
  validateMarketplaceName,
} from "./storage.ts";
import { MarketplaceUpdater } from "./updater.ts";

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

function discoveryError(root: string, error: unknown): Error {
  return new Error(
    `Marketplace discovery failed: ${errorMessage(error)}. Check that marketplace storage at "${root}" is readable, then retry.`,
  );
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
        const source = (await importPluginEntry(entryPath)) as PluginModule;
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
      let marketplaces: readonly MarketplaceCheckout[];
      try {
        marketplaces = await discoverInstalledMarketplaces(root);
      } catch (error) {
        throw discoveryError(root, error);
      }
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
      return ({ command, context, env, plugin, update }) => {
        const root = resolveMarketplaceDirectory({ env });
        const manager =
          options.manager ??
          new MarketplaceManager(root, { env, cwd: context.cwd });

        command((namespace) => {
          namespace.description("Manage installed plugin marketplaces");

          namespace
            .command("add")
            .description(
              "Install a marketplace from a Git repository, or reference a local directory",
            )
            .argument(
              "<source>",
              "Git clone source, bare owner/repository GitHub shorthand, or an existing local directory referenced live, optionally with an @<ref> version",
            )
            .option(
              "--name <name>",
              "Local marketplace name, instead of one derived from the source",
            )
            .action(async (source: string, flags: { name?: string }) => {
              const requested =
                flags.name === undefined
                  ? undefined
                  : validateMarketplaceName(flags.name);
              const name = await manager.add(source, requested);
              context.stdout.write(`Added marketplace "${name}".\n`);
            });

          namespace
            .command("list")
            .description(
              "List installed marketplaces, their versions, and their sources",
            )
            .action(async () => {
              for (const marketplace of await manager.list()) {
                context.stdout.write(
                  `${marketplace.name}\t${marketplace.version}\t${marketplace.source}\n`,
                );
              }
            });

          namespace
            .command("pin")
            .description(
              "Pin an installed marketplace to a version its remote publishes",
            )
            .argument("<name>", "Local marketplace name")
            .argument("<ref>", "Tag, branch, or commit the remote publishes")
            .action(async (name: string, ref: string) => {
              const version = await manager.pin(
                validateMarketplaceName(name),
                ref,
              );
              context.stdout.write(
                `Pinned marketplace "${name}" to "${ref}"; the next "tx update" applies ${version}.\n`,
              );
            });

          namespace
            .command("unpin")
            .description(
              "Clear an installed marketplace's pin, tracking its remote's default branch again",
            )
            .argument("<name>", "Local marketplace name")
            .action(async (name: string) => {
              await manager.unpin(validateMarketplaceName(name));
              context.stdout.write(
                `Unpinned marketplace "${name}"; it tracks its remote's default branch again.\n`,
              );
            });

          namespace
            .command("remove")
            .description("Remove an installed marketplace")
            .argument("<name>", "Local marketplace name")
            .action(async (name: string) => {
              await manager.remove(validateMarketplaceName(name));
              context.stdout.write(`Removed marketplace "${name}".\n`);
            });
        });

        // Contributed by the root plugin and reading storage directly, so a
        // marketplace whose current commit fails to load — which is exactly
        // the one an update fixes — is still gathered and still applied.
        update(new MarketplaceUpdater(root, { env }));

        plugin(discoveryDefinition(root, identity));
      };
    },
  });
}

const marketplacePlugin = createMarketplacePlugin();
export default marketplacePlugin;
