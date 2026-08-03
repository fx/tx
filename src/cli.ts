import packageMetadata from "../package.json" with { type: "json" };
import {
  CommandRegistry,
  dispatch,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  identityName,
} from "./commands.ts";
import { type CommandProcessContext, createProcessContext } from "./context.ts";
import type { PluginDefinition } from "./plugin.ts";
import { initializePlugins } from "./plugins.ts";

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  definitions: readonly PluginDefinition[] = [],
  registry = new CommandRegistry(),
  context: CommandProcessContext = createProcessContext(),
): Promise<number> {
  if (argv.length === 1 && argv[0] === "--version") {
    context.stdout.write(`${packageMetadata.version}\n`);
    return EXIT_SUCCESS;
  }

  const failures = await initializePlugins(registry, definitions, {
    env: context.env,
  });
  for (const failure of failures) {
    context.stderr.write(
      `Error loading plugin ${identityName(failure.identity)}: ${failure.message}\n`,
    );
  }

  const result = await dispatch(registry, argv, context);
  return result.exitCode === EXIT_SUCCESS && failures.length > 0
    ? EXIT_FAILURE
    : result.exitCode;
}
