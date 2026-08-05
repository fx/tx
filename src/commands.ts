import type { Command, CommanderError } from "commander";
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
 * Parser outcomes that answer a help request. The parser reports the same code
 * whether it printed help because the user asked for it or because it could not
 * make sense of the arguments, so the code alone does not settle the exit
 * status; the stream it printed on does. Everything the parser reports outside
 * these codes and `commander.version` is a failure. Mapping by code keeps the
 * CLI's contract independent of the parser's own exit numbers.
 */
const helpParserCodes = new Set(["commander.help", "commander.helpDisplayed"]);

/** What the parser reported during one dispatch. */
interface ParserSignals {
  /**
   * The exits the parser raised in place of terminating the process. Only
   * these are parser outcomes; an error a command threw is a command failure
   * however closely it resembles one.
   */
  readonly exits: WeakSet<object>;
  /**
   * Whether the parser sent the help it printed last to standard error. It
   * answers a request on standard output and rejects arguments it could not
   * use on standard error, which is the signal the shared code lacks.
   */
  helpOnStandardError: boolean;
}

/**
 * The signals the newest hardening pass installed on each command. The parser
 * accumulates help hooks rather than replacing them, so a command may only ever
 * be given one recorder; the recorder reads its signals from here so that
 * hardening the same tree again retargets it at the dispatch in flight instead
 * of leaving another closure behind.
 */
const helpRecorders = new WeakMap<Command, { signals: ParserSignals }>();

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
 * Route output to the injected streams, replace process termination with a
 * thrown outcome, and record which stream each command sends its help to, for
 * every command reachable in the assembled tree. Attaching a pre-built command
 * propagates none of it, so the pass has to be recursive and has to run after
 * every plugin has contributed. The recorder contributes no help text of its
 * own; it only observes the destination the parser chose. Running the pass over
 * a command it already covers retargets what is there rather than layering
 * another recorder onto it.
 */
function hardenCommandTree(
  command: Command,
  context: CommandProcessContext,
  signals: ParserSignals,
): void {
  command.exitOverride((exit: CommanderError) => {
    signals.exits.add(exit);
    // The parser reports a spawned executable subcommand's failure from an
    // event handler, where throwing would have nowhere to land; the default
    // override skips it and so does this one.
    if (exit.code !== "commander.executeSubCommandAsync") throw exit;
  });
  command.configureOutput({
    writeOut(value: string) {
      context.stdout.write(value);
    },
    writeErr(value: string) {
      context.stderr.write(value);
    },
  });
  const recorder = helpRecorders.get(command);
  if (recorder) {
    recorder.signals = signals;
  } else {
    const installed = { signals };
    helpRecorders.set(command, installed);
    command.addHelpText("before", ({ error }) => {
      installed.signals.helpOnStandardError = error;
      return "";
    });
  }
  for (const child of command.commands) {
    hardenCommandTree(child, context, signals);
  }
}

function parserExit(
  error: unknown,
  signals: ParserSignals,
): CommanderError | undefined {
  return typeof error === "object" && error !== null && signals.exits.has(error)
    ? (error as CommanderError)
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
  const signals: ParserSignals = {
    exits: new WeakSet(),
    helpOnStandardError: false,
  };
  hardenCommandTree(program, context, signals);

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
    const exit = parserExit(error, signals);
    if (!exit) {
      writeError(context.stderr, error);
      return { exitCode: EXIT_FAILURE };
    }
    if (exit.code === "commander.version") return { exitCode: EXIT_SUCCESS };
    if (helpParserCodes.has(exit.code) && !signals.helpOnStandardError) {
      return { exitCode: EXIT_SUCCESS };
    }
    return { exitCode: EXIT_FAILURE };
  }
}
