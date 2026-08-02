import type { MarketplaceCapabilities, Plugin } from "tx/plugin";

import {
  MarketplaceManager,
  type MarketplaceOperations,
  parseAddMarketplaceArguments,
  parseListMarketplaceArguments,
  parseRemoveMarketplaceArguments,
} from "./manager.ts";

export type { MarketplaceOperations } from "./manager.ts";

export interface MarketplacePluginOptions {
  readonly manager?: MarketplaceOperations;
}

export function createMarketplacePlugin(
  options: MarketplacePluginOptions = {},
): Plugin {
  return ({ command, dependencies }) => {
    const capabilities: MarketplaceCapabilities = dependencies.marketplace;
    const managerForOperation = (
      env: Readonly<Record<string, string | undefined>>,
    ): MarketplaceOperations =>
      options.manager ??
      new MarketplaceManager(
        capabilities.resolveDirectory({ env }),
        capabilities,
      );

    command("marketplace add", async (args, context) => {
      const parsed = parseAddMarketplaceArguments(
        args,
        capabilities.validateName,
      );
      const name = await managerForOperation(context.env).add(
        parsed.repository,
        parsed.name,
      );
      context.stdout.write(`Added marketplace "${name}".\n`);
    });

    command("marketplace list", async (args, context) => {
      parseListMarketplaceArguments(args);
      for (const marketplace of await managerForOperation(context.env).list()) {
        context.stdout.write(`${marketplace.name}\t${marketplace.source}\n`);
      }
    });

    command("marketplace remove", async (args, context) => {
      const name = parseRemoveMarketplaceArguments(
        args,
        capabilities.validateName,
      );
      await managerForOperation(context.env).remove(name);
      context.stdout.write(`Removed marketplace "${name}".\n`);
    });
  };
}

const marketplacePlugin = createMarketplacePlugin();
export default marketplacePlugin;
