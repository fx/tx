#!/usr/bin/env bun

import {
  CommandRegistry,
  dispatch,
  EXIT_FAILURE,
  EXIT_SUCCESS,
} from "./commands.ts";
import { type CommandProcessContext, createProcessContext } from "./context.ts";
import { resolveMarketplaceDirectory } from "./marketplaces.ts";
import {
  initializeFirstPartyPlugins,
  initializeMarketplacePlugins,
  type PluginLoadFailure,
} from "./plugins.ts";

function reportPluginLoadFailure(
  context: CommandProcessContext,
  failure: PluginLoadFailure,
): void {
  const owner =
    failure.kind === "plugin"
      ? `plugin ${failure.marketplace}/${failure.plugin}`
      : `marketplace ${failure.marketplace}`;
  context.stderr.write(`Error loading ${owner}: ${failure.message}\n`);
}

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  registry?: CommandRegistry,
  context: CommandProcessContext = createProcessContext(),
): Promise<number> {
  const activeRegistry = registry ?? new CommandRegistry();
  let loadFailures: readonly PluginLoadFailure[] = [];
  if (registry === undefined) {
    await initializeFirstPartyPlugins(activeRegistry);
    loadFailures = await initializeMarketplacePlugins(
      activeRegistry,
      resolveMarketplaceDirectory({ env: context.env }),
    );
    for (const failure of loadFailures) {
      reportPluginLoadFailure(context, failure);
    }
  }

  const result = await dispatch(activeRegistry, argv, context);
  return result.exitCode === EXIT_SUCCESS && loadFailures.length > 0
    ? EXIT_FAILURE
    : result.exitCode;
}

if (import.meta.main) process.exitCode = await main();
