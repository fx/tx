import type { CommandOwner, CommandProcessContext } from "./context.ts";
import type { CommandContext, CommandHandler } from "./plugin.ts";

export type { CommandHandler } from "./plugin.ts";

export type CommandPath = string | readonly string[];

export interface Command {
  readonly path: readonly string[];
  readonly owner: CommandOwner;
  readonly handler: CommandHandler;
}

export interface CommandRegistration {
  readonly path: CommandPath;
  readonly owner: CommandOwner;
  readonly handler: CommandHandler;
}

interface CommandNode {
  command?: Command;
  children: Map<string, CommandNode>;
}

export interface DispatchResult {
  exitCode: number;
  command?: Command;
}

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

function ownerName(owner: CommandOwner): string {
  return `${owner.marketplace}/${owner.plugin}`;
}

export function normalizeCommandPath(path: CommandPath): readonly string[] {
  const segments =
    typeof path === "string" ? path.trim().split(/\s+/) : Array.from(path);

  if (segments.length === 0) {
    throw new Error("Command path must contain one or more non-empty segments");
  }

  const normalized: string[] = [];
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.trim().length === 0) {
      throw new Error(
        "Command path must contain one or more non-empty segments",
      );
    }
    normalized.push(segment.trim());
  }

  return Object.freeze(normalized);
}

export class CommandRegistry {
  readonly #root: CommandNode;

  constructor() {
    this.#root = { children: new Map() };
  }

  register(
    path: CommandPath,
    owner: CommandOwner,
    handler: CommandHandler,
  ): Command {
    return this.registerBatch([{ path, owner, handler }])[0] as Command;
  }

  registerBatch(
    registrations: readonly CommandRegistration[],
  ): readonly Command[] {
    const commands = registrations.map(({ path, owner, handler }) =>
      Object.freeze({
        path: normalizeCommandPath(path),
        owner: Object.freeze({ ...owner }),
        handler,
      }),
    );
    const pending = new Map<string, Command>();

    for (const command of commands) {
      const key = JSON.stringify(command.path);
      const conflicting = this.#find(command.path) ?? pending.get(key);
      if (conflicting) {
        throw new Error(
          `Command "${command.path.join(" ")}" is already registered by ${ownerName(conflicting.owner)}; cannot register it for ${ownerName(command.owner)}`,
        );
      }
      pending.set(key, command);
    }

    for (const command of commands) {
      let node = this.#root;
      for (const segment of command.path) {
        let child = node.children.get(segment);
        if (!child) {
          child = { children: new Map() };
          node.children.set(segment, child);
        }
        node = child;
      }
      node.command = command;
    }

    return Object.freeze(commands);
  }

  #find(path: readonly string[]): Command | undefined {
    let node = this.#root;
    for (const segment of path) {
      const child = node.children.get(segment);
      if (!child) return undefined;
      node = child;
    }
    return node.command;
  }

  resolve(argv: readonly string[]): Command | undefined {
    let node = this.#root;
    let match: Command | undefined;

    for (const segment of argv) {
      const child = node.children.get(segment);
      if (!child) break;
      node = child;
      match = node.command ?? match;
    }

    return match;
  }

  resolveHelpPath(argv: readonly string[]): readonly string[] | undefined {
    let node = this.#root;
    const path: string[] = [];
    let commandPath: readonly string[] | undefined;

    for (const segment of argv) {
      const child = node.children.get(segment);
      if (!child) return commandPath;
      node = child;
      path.push(segment);
      if (node.command) commandPath = [...path];
    }

    return path;
  }

  help(path: readonly string[] = []): string | undefined {
    let node = this.#root;

    for (const segment of path) {
      const child = node.children.get(segment);
      if (!child) return undefined;
      node = child;
    }

    const children = [...node.children.keys()].sort();
    const usage = path.length === 0 ? "tx" : `tx ${path.join(" ")}`;
    const hasCommandSlot = path.length === 0 || children.length > 0;
    const lines = [`Usage: ${usage}${hasCommandSlot ? " <command>" : ""}`];

    if (children.length > 0) {
      lines.push("", "Commands:");
      for (const child of children) lines.push(`  ${child}`);
    }

    return `${lines.join("\n")}\n`;
  }
}

function writeError(stderr: NodeJS.WriteStream, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`Error: ${message}\n`);
}

export async function dispatch(
  registry: CommandRegistry,
  argv: readonly string[],
  processContext: CommandProcessContext,
): Promise<DispatchResult> {
  const helpIndex = argv.indexOf("--help");
  if (argv.length === 0 || helpIndex !== -1) {
    const requestedPath = helpIndex === -1 ? [] : argv.slice(0, helpIndex);
    const helpPath = registry.resolveHelpPath(requestedPath);
    const help = helpPath ? registry.help(helpPath) : undefined;

    if (!help) {
      processContext.stderr.write(
        `Error: Unknown command "${requestedPath.join(" ")}". Run "tx --help" for usage.\n`,
      );
      return { exitCode: EXIT_USAGE };
    }

    processContext.stdout.write(help);
    return { exitCode: EXIT_SUCCESS };
  }

  const command = registry.resolve(argv);
  if (!command) {
    processContext.stderr.write(
      `Error: Unknown command "${argv.join(" ")}". Run "tx --help" for usage.\n`,
    );
    return { exitCode: EXIT_USAGE };
  }

  const context: CommandContext = { ...processContext, ...command.owner };
  const args = argv.slice(command.path.length);

  try {
    await command.handler(args, context);
    return { exitCode: EXIT_SUCCESS, command };
  } catch (error) {
    writeError(processContext.stderr, error);
    return { exitCode: EXIT_FAILURE, command };
  }
}
