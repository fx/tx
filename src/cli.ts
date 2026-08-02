#!/usr/bin/env bun

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
): Promise<void> {
  void argv;
}

if (import.meta.main) await main();
