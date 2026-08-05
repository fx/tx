import type { Command } from "commander";
import type { CommandProcessContext } from "./context.ts";
import type { CoreDependencies, PluginIdentity } from "./plugin.ts";

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;

/**
 * The root options the host owns. They are recognized only as the first
 * argument; anything after a plugin namespace belongs to that plugin.
 */
const rootOptions = new Set(["--help", "-h", "--version", "-V"]);

/**
 * Parser outcomes that resolve to success. Everything else the parser reports
 * — including a namespace invoked without a subcommand, which the parser
 * answers with usage on standard error — is a failure. Mapping by code keeps
 * the CLI's contract independent of the parser's own exit numbers.
 */
const successfulParserCodes = new Set([
  "commander.helpDisplayed",
  "commander.version",
]);

export interface PluginNamespace {
  readonly identity: PluginIdentity;
  readonly command: Command;
}

export interface DispatchResult {
  readonly exitCode: number;
}

export function identityName(identity: PluginIdentity): string {
  const names: string[] = [];
  let current: PluginIdentity | undefined = identity;
  while (current) {
    names.push(current.name);
    current = current.parent;
  }
  return names.reverse().join("/");
}

export function freezePluginIdentity(identity: PluginIdentity): PluginIdentity {
  if (!identity.name.trim())
    throw new Error("Plugin identity name must not be empty");
  const parent = identity.parent
    ? freezePluginIdentity(identity.parent)
    : undefined;
  return Object.freeze(
    parent ? { name: identity.name, parent } : { name: identity.name },
  );
}

export function createRootProgram(
  dependencies: CoreDependencies,
  namespaces: readonly PluginNamespace[] = [],
): Command {
  const program = new dependencies.commander.Command("tx")
    .description("Extensible command-line toolbox")
    .version(dependencies.tx.version)
    .helpCommand(false)
    .enablePositionalOptions();

  for (const namespace of namespaces) program.addCommand(namespace.command);

  return program;
}

/**
 * Route output to the injected streams and replace process termination with a
 * thrown outcome, for every command reachable in the assembled tree. Attaching
 * a pre-built command propagates neither setting, so the pass has to be
 * recursive and has to run after every plugin has contributed.
 */
function hardenCommandTree(
  command: Command,
  context: CommandProcessContext,
): void {
  command.exitOverride();
  command.configureOutput({
    writeOut(value: string) {
      context.stdout.write(value);
    },
    writeErr(value: string) {
      context.stderr.write(value);
    },
  });
  for (const child of command.commands) hardenCommandTree(child, context);
}

function parserErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code } = error as Error & { code?: unknown };
  return typeof code === "string" && code.startsWith("commander.")
    ? code
    : undefined;
}

function writeError(stderr: NodeJS.WriteStream, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`Error: ${message}\n`);
}

export async function dispatch(
  program: Command,
  argv: readonly string[],
  context: CommandProcessContext,
): Promise<DispatchResult> {
  hardenCommandTree(program, context);

  const first = argv[0];
  if (first === undefined) {
    program.outputHelp({ error: true });
    return { exitCode: EXIT_FAILURE };
  }

  if (
    !rootOptions.has(first) &&
    !program.commands.some((command) => command.name() === first)
  ) {
    context.stderr.write(
      `Error: Unknown command "${first}". Run "tx --help" for usage.\n`,
    );
    return { exitCode: EXIT_FAILURE };
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return { exitCode: EXIT_SUCCESS };
  } catch (error) {
    const code = parserErrorCode(error);
    if (code === undefined) {
      writeError(context.stderr, error);
      return { exitCode: EXIT_FAILURE };
    }
    return {
      exitCode: successfulParserCodes.has(code) ? EXIT_SUCCESS : EXIT_FAILURE,
    };
  }
}
