#!/usr/bin/env bun

import { CommandRegistry, dispatch } from "./commands.ts";
import { type CommandProcessContext, createProcessContext } from "./context.ts";

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  registry: CommandRegistry = new CommandRegistry(),
  context: CommandProcessContext = createProcessContext(),
): Promise<number> {
  const result = await dispatch(registry, argv, context);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main();
