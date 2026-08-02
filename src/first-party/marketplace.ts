import {
  MarketplaceManager,
  parseAddMarketplaceArguments,
  parseListMarketplaceArguments,
  parseRemoveMarketplaceArguments,
  resolveMarketplaceDirectory,
  type UserDataDirectoryOptions,
} from "../marketplaces.ts";
import type { Plugin } from "../plugin.ts";

export interface MarketplacePluginOptions {
  readonly manager?: MarketplaceManager;
  readonly userData?: UserDataDirectoryOptions;
}

export function createMarketplacePlugin(
  options: MarketplacePluginOptions = {},
): Plugin {
  const manager =
    options.manager ??
    new MarketplaceManager(resolveMarketplaceDirectory(options.userData));

  return ({ command }) => {
    command("marketplace add", async (args, context) => {
      const parsed = parseAddMarketplaceArguments(args);
      const name = await manager.add(parsed.repository, parsed.name);
      context.stdout.write(`Added marketplace "${name}".\n`);
    });

    command("marketplace list", async (args, context) => {
      parseListMarketplaceArguments(args);
      for (const marketplace of await manager.list()) {
        context.stdout.write(`${marketplace.name}\t${marketplace.source}\n`);
      }
    });

    command("marketplace remove", async (args, context) => {
      const name = parseRemoveMarketplaceArguments(args);
      await manager.remove(name);
      context.stdout.write(`Removed marketplace "${name}".\n`);
    });
  };
}

const marketplacePlugin = createMarketplacePlugin();
export default marketplacePlugin;
