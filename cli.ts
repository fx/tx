#!/usr/bin/env bun

import marketplacePlugin from "./plugins/marketplace/index.ts";
import { main } from "./src/cli.ts";
import type { PluginDefinition } from "./src/plugin.ts";

export const defaultPlugins: readonly PluginDefinition[] = Object.freeze([
  marketplacePlugin,
]);

const args = import.meta.main ? Bun.argv.slice(2) : [];
if (import.meta.main) process.exitCode = await main(args, defaultPlugins);
