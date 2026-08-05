import packageMetadata from "../package.json" with { type: "json" };
import {
  createRootProgram,
  dispatch,
  EXIT_SUCCESS,
  identityName,
} from "./commands.ts";
import { type CommandProcessContext, createProcessContext } from "./context.ts";
import type { CoreDependencies, PluginDefinition } from "./plugin.ts";
import { coreDependencies, initializePlugins } from "./plugins.ts";

const versionOptions = new Set(["--version", "-V"]);

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  definitions: readonly PluginDefinition[] = [],
  context: CommandProcessContext = createProcessContext(),
  dependencies: CoreDependencies = coreDependencies,
): Promise<number> {
  const first = argv[0];
  if (first !== undefined && versionOptions.has(first)) {
    context.stdout.write(`${packageMetadata.version}\n`);
    return EXIT_SUCCESS;
  }

  const { namespaces, failures } = await initializePlugins(definitions, {
    context,
    dependencies,
  });
  for (const failure of failures) {
    context.stderr.write(
      `Error loading plugin ${identityName(failure.identity)}: ${failure.message}\n`,
    );
  }

  const result = await dispatch(
    createRootProgram(dependencies, namespaces),
    argv,
    context,
  );
  return result.exitCode;
}
