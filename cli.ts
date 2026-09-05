#!/usr/bin/env bun

import configPlugin from "./plugins/config/index.ts";
import dialogsPlugin from "./plugins/dialogs/index.ts";
import executablePlugin from "./plugins/executable/index.ts";
import marketplacePlugin from "./plugins/marketplace/index.ts";
import themePlugin from "./plugins/theme/index.ts";
import updatePlugin from "./plugins/update/index.ts";
import { main } from "./src/cli.ts";
import type { PluginDefinition } from "./src/plugin.ts";

/**
 * Composition order fixes the order of update participants among the plugins
 * that contribute them: a participant contributed here is gathered and applied
 * before one contributed by anything listed after it. The update plugin's own
 * position is not part of that — it contributes no participant, and it reads
 * the committed ones when its command runs rather than when it initializes, so
 * it sees every participant wherever it sits in this array.
 *
 * The executable plugin comes last for exactly that reason: its participant
 * owns the running `tx` binary, so it is applied after everything the other
 * default plugins own has already been updated.
 *
 * The theme plugin comes before the surfaces that draw. Ordering is not what
 * makes that correct — a consumer resolves a theme when its command runs, by
 * which point every plugin has committed — but composing a provider ahead of
 * its consumers is what this ordered list is for, and an override contributed
 * by anything after it still applies.
 */
export const defaultPlugins: readonly PluginDefinition[] = Object.freeze([
  marketplacePlugin,
  updatePlugin,
  themePlugin,
  dialogsPlugin,
  configPlugin,
  executablePlugin,
]);

const args = import.meta.main ? Bun.argv.slice(2) : [];
if (import.meta.main) process.exitCode = await main(args, defaultPlugins);
