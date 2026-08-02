#!/usr/bin/env bun

import { CommandRegistry, dispatch } from "./commands.ts";
import { type CommandProcessContext, createProcessContext } from "./context.ts";
import { initializeFirstPartyPlugins } from "./plugins.ts";

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  registry?: CommandRegistry,
  context: CommandProcessContext = createProcessContext(),
): Promise<number> {
  const activeRegistry = registry ?? new CommandRegistry();
  if (registry === undefined) await initializeFirstPartyPlugins(activeRegistry);
  const result = await dispatch(activeRegistry, argv, context);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main();
