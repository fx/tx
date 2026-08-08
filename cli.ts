#!/usr/bin/env bun

import marketplacePlugin from "./plugins/marketplace/index.ts";
import updatePlugin from "./plugins/update/index.ts";
import { main } from "./src/cli.ts";
import type { PluginDefinition } from "./src/plugin.ts";

/**
 * Composition order fixes update participant order: the update plugin comes
 * after the marketplace plugin, so a participant the marketplace contributes
 * is gathered and applied before anything composed after it.
 */
export const defaultPlugins: readonly PluginDefinition[] = Object.freeze([
  marketplacePlugin,
  updatePlugin,
]);

const args = import.meta.main ? Bun.argv.slice(2) : [];
if (import.meta.main) process.exitCode = await main(args, defaultPlugins);
