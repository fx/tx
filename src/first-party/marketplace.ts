import {
  type MarketplaceListing,
  MarketplaceManager,
  parseAddMarketplaceArguments,
  parseListMarketplaceArguments,
  parseRemoveMarketplaceArguments,
  resolveMarketplaceDirectory,
  type UserDataDirectoryOptions,
} from "../marketplaces.ts";
import type { Plugin } from "../plugin.ts";

export interface MarketplaceOperations {
  add(repository: string, requestedName?: string): Promise<string>;
  list(): Promise<readonly MarketplaceListing[]>;
  remove(name: string): Promise<void>;
}

export interface MarketplacePluginOptions {
  readonly manager?: MarketplaceOperations;
  readonly userData?: UserDataDirectoryOptions;
}

export function createMarketplacePlugin(
  options: MarketplacePluginOptions = {},
): Plugin {
  let manager = options.manager;
  const managerForOperation = (): MarketplaceOperations => {
    manager ??= new MarketplaceManager(
      resolveMarketplaceDirectory(options.userData),
    );
    return manager;
  };

  return ({ command }) => {
    command("marketplace add", async (args, context) => {
      const parsed = parseAddMarketplaceArguments(args);
      const name = await managerForOperation().add(
        parsed.repository,
        parsed.name,
      );
      context.stdout.write(`Added marketplace "${name}".\n`);
    });

    command("marketplace list", async (args, context) => {
      parseListMarketplaceArguments(args);
      for (const marketplace of await managerForOperation().list()) {
        context.stdout.write(`${marketplace.name}\t${marketplace.source}\n`);
      }
    });

    command("marketplace remove", async (args, context) => {
      const name = parseRemoveMarketplaceArguments(args);
      await managerForOperation().remove(name);
      context.stdout.write(`Removed marketplace "${name}".\n`);
    });
  };
}

const marketplacePlugin = createMarketplacePlugin();
export default marketplacePlugin;
