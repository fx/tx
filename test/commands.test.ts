import { describe, expect, test } from "bun:test";
import type { Command } from "commander";

import {
  createRootProgram,
  dispatch,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  freezePluginIdentity,
  identityName,
  type PluginNamespace,
} from "../src/commands.ts";
import type { CommandProcessContext } from "../src/context.ts";
import type { PluginIdentity } from "../src/plugin.ts";
import { coreDependencies } from "../src/plugins.ts";
import { captureContext } from "./helpers.ts";

const version = coreDependencies.tx.version;

function namespace(
  name: string,
  build: (command: Command) => void,
  identity: PluginIdentity = { name },
): PluginNamespace {
  const command = new coreDependencies.commander.Command(name);
  build(command);
  return { identity, command };
}

/**
 * A namespace that reports whatever the parser handed to the plugin, writing
 * through the injected context exactly as a real plugin does.
 */
function reportingNamespace(
  context: CommandProcessContext,
  name = "notes",
): PluginNamespace {
  return namespace(name, (command) => {
    command
      .description("Take notes")
      .option("--version", "the plugin's own version flag")
      .argument("[words...]", "words to record")
      .action((words: string[], flags: Record<string, unknown>) => {
        context.stdout.write(`${JSON.stringify({ words, flags })}\n`);
      });
    command
      .command("daily")
      .description("Daily notes")
      .option("--format <format>", "output format")
      .argument("[file]", "file to open");
  });
}

describe("plugin identity", () => {
  test("joins the parent chain and freezes every level", () => {
    const identity = freezePluginIdentity({
      name: "journal",
      parent: { name: "personal", parent: { name: "marketplace" } },
    });

    expect(identityName(identity)).toBe("marketplace/personal/journal");
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.parent)).toBe(true);
    expect(Object.isFrozen(identity.parent?.parent)).toBe(true);
    expect(() => freezePluginIdentity({ name: "  " })).toThrow(
      "Plugin identity name must not be empty",
    );
  });
});

describe("root program", () => {
  test("lists every claimed namespace with its owner's description", async () => {
    const program = createRootProgram(coreDependencies, [
      namespace("notes", (command) => command.description("Take notes")),
      namespace("reports", (command) => command.description("Build reports")),
    ]);
    const context = captureContext();

    expect(await dispatch(program, ["--help"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(context.stdoutText()).toContain("Usage: tx [options] [command]");
    expect(context.stdoutText()).toMatch(/^ +notes +Take notes$/m);
    expect(context.stdoutText()).toMatch(/^ +reports +Build reports$/m);
    expect(context.stderrText()).toBe("");
  });

  test("claims no implicit help subcommand", async () => {
    const program = createRootProgram(coreDependencies, [
      namespace("notes", (command) => command.description("Take notes")),
    ]);
    const context = captureContext();

    expect(await dispatch(program, ["--help"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(context.stdoutText()).not.toContain("help [command]");
    expect(
      createRootProgram(coreDependencies).commands.map((command) =>
        command.name(),
      ),
    ).toEqual([]);
  });
});

describe("root options", () => {
  test("shows root help on standard error and fails without arguments", async () => {
    const context = captureContext();

    expect(
      await dispatch(
        createRootProgram(coreDependencies, [
          namespace("notes", (command) => command.description("Take notes")),
        ]),
        [],
        context,
      ),
    ).toEqual({ exitCode: EXIT_FAILURE });
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toContain("Usage: tx [options] [command]");
    expect(context.stderrText()).toContain("notes");
  });

  test.each([
    ["--help", []],
    ["--help", ["notes"]],
    ["-h", []],
    ["-h", ["notes", "--format", "json"]],
  ])(
    "answers %s as the first argument and ignores what follows",
    async (option, rest) => {
      const context = captureContext();

      expect(
        await dispatch(
          createRootProgram(coreDependencies, [reportingNamespace(context)]),
          [option, ...rest],
          context,
        ),
      ).toEqual({ exitCode: EXIT_SUCCESS });
      expect(context.stdoutText()).toStartWith("Usage: tx [options] [command]");
      expect(context.stderrText()).toBe("");
    },
  );

  test.each([
    ["--version", []],
    ["--version", ["extra"]],
    ["-V", []],
    ["-V", ["notes", "--format", "json"]],
  ])(
    "answers %s as the first argument and ignores what follows",
    async (option, rest) => {
      const context = captureContext();

      expect(
        await dispatch(
          createRootProgram(coreDependencies, [reportingNamespace(context)]),
          [option, ...rest],
          context,
        ),
      ).toEqual({ exitCode: EXIT_SUCCESS });
      expect(context.stdoutText()).toBe(`${version}\n`);
      expect(context.stderrText()).toBe("");
    },
  );

  test.each([[[]], [["--help"]], [["-h"]], [["--version"]], [["-V"]]])(
    "reports an unrecognized first argument followed by %p",
    async (rest) => {
      const context = captureContext();

      expect(
        await dispatch(
          createRootProgram(coreDependencies, [reportingNamespace(context)]),
          ["missing", ...rest],
          context,
        ),
      ).toEqual({ exitCode: EXIT_FAILURE });
      expect(context.stdoutText()).toBe("");
      expect(context.stderrText()).toBe(
        'Error: Unknown command "missing". Run "tx --help" for usage.\n',
      );
    },
  );
});

describe("delegation to a namespace", () => {
  test("hands every argument after the namespace to its owner", async () => {
    const context = captureContext();

    expect(
      await dispatch(
        createRootProgram(coreDependencies, [reportingNamespace(context)]),
        ["notes", "today", "tomorrow"],
        context,
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(JSON.parse(context.stdoutText())).toEqual({
      words: ["today", "tomorrow"],
      flags: {},
    });
    expect(context.stderrText()).toBe("");
  });

  test("gives the plugin an option the root itself defines", async () => {
    const context = captureContext();

    expect(
      await dispatch(
        createRootProgram(coreDependencies, [reportingNamespace(context)]),
        ["notes", "--version", "today"],
        context,
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(JSON.parse(context.stdoutText())).toEqual({
      words: ["today"],
      flags: { version: true },
    });
    expect(context.stdoutText()).not.toContain(version);
    expect(context.stderrText()).toBe("");
  });

  test("lets the plugin answer a help request for its own command", async () => {
    const context = captureContext();

    expect(
      await dispatch(
        createRootProgram(coreDependencies, [reportingNamespace(context)]),
        ["notes", "daily", "--help"],
        context,
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(context.stdoutText()).toContain("Usage: tx notes daily [options]");
    expect(context.stdoutText()).toContain("--format <format>");
    expect(context.stderrText()).toBe("");
  });

  test("hardens commands added after the root program was assembled", async () => {
    const context = captureContext();
    const contributed = reportingNamespace(context);
    const program = createRootProgram(coreDependencies, [contributed]);
    contributed.command
      .command("late")
      .description("Added after assembly")
      .option("--late <value>", "late option");

    expect(
      await dispatch(program, ["notes", "late", "--help"], context),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(context.stdoutText()).toContain("Usage: tx notes late [options]");
    expect(context.stdoutText()).toContain("--late <value>");
    expect(context.stderrText()).toBe("");
  });

  test("supports arbitrary nesting defined by the plugin", async () => {
    const context = captureContext();
    let received: readonly string[] | undefined;
    const program = createRootProgram(coreDependencies, [
      namespace("notes", (command) => {
        command
          .command("daily")
          .command("open")
          .argument("[day]")
          .action((day: string) => {
            received = [day];
          });
      }),
    ]);

    expect(
      await dispatch(program, ["notes", "daily", "open", "today"], context),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(received).toEqual(["today"]);
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toBe("");
  });

  test("awaits an asynchronous action", async () => {
    let completed = false;
    const program = createRootProgram(coreDependencies, [
      namespace("notes", (command) =>
        command.action(async () => {
          await Promise.resolve();
          completed = true;
        }),
      ),
    ]);
    const context = captureContext();

    expect(await dispatch(program, ["notes"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(completed).toBe(true);
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toBe("");
  });

  test("never terminates the host when a plugin subcommand prints help", async () => {
    const context = captureContext();
    const program = createRootProgram(coreDependencies, [
      reportingNamespace(context),
    ]);
    const realExit = process.exit;
    let terminated = false;
    process.exit = ((code?: number) => {
      terminated = true;
      throw new Error(`process.exit(${code}) escaped dispatch`);
    }) as typeof process.exit;

    try {
      expect(
        await dispatch(program, ["notes", "daily", "--help"], context),
      ).toEqual({ exitCode: EXIT_SUCCESS });
    } finally {
      process.exit = realExit;
    }

    expect(terminated).toBe(false);
    expect(context.stdoutText()).toContain("Usage: tx notes daily [options]");
    expect(context.stderrText()).toBe("");
  });
});

describe("exit-code mapping", () => {
  test.each([
    [
      "a synchronous Error",
      () => {
        throw new Error("sync failed");
      },
      "Error: sync failed\n",
    ],
    [
      "an asynchronous Error",
      async () => {
        throw new Error("async failed");
      },
      "Error: async failed\n",
    ],
    [
      "a non-Error value",
      () => {
        throw "plain failure";
      },
      "Error: plain failure\n",
    ],
  ])("fails on %s thrown by a command", async (_label, action, message) => {
    const context = captureContext();
    const program = createRootProgram(coreDependencies, [
      namespace("notes", (command) => command.action(action)),
    ]);

    expect(await dispatch(program, ["notes"], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toBe(message);
  });

  test("fails when a plugin rejects the arguments it was given", async () => {
    const context = captureContext();

    expect(
      await dispatch(
        createRootProgram(coreDependencies, [reportingNamespace(context)]),
        ["notes", "daily", "--unknown"],
        context,
      ),
    ).toEqual({ exitCode: EXIT_FAILURE });
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toContain("unknown option '--unknown'");
  });

  // The parser reports one code for help it was asked for and help it printed
  // because it could not use the arguments, so these outcomes are asserted
  // together: they must never collapse onto a single exit code again.
  test.each([
    {
      label: "a plugin's own help subcommand",
      argv: ["notes", "help"],
      exitCode: EXIT_SUCCESS,
      onStandardError: false,
      usage: "Usage: tx notes [options] [command]",
    },
    {
      label: "a plugin's own help subcommand for one of its commands",
      argv: ["notes", "help", "daily"],
      exitCode: EXIT_SUCCESS,
      onStandardError: false,
      usage: "Usage: tx notes daily [options]",
    },
    {
      label: "a help option on one of the plugin's commands",
      argv: ["notes", "daily", "--help"],
      exitCode: EXIT_SUCCESS,
      onStandardError: false,
      usage: "Usage: tx notes daily [options]",
    },
    {
      label: "a namespace invoked without one of its subcommands",
      argv: ["notes"],
      exitCode: EXIT_FAILURE,
      onStandardError: true,
      usage: "Usage: tx notes [options] [command]",
    },
  ])(
    "resolves $label by where the parser sent the help",
    async ({ argv, exitCode, onStandardError, usage }) => {
      const context = captureContext();
      const program = createRootProgram(coreDependencies, [
        namespace("notes", (command) => {
          command
            .description("Take notes")
            .command("daily")
            .description("Daily notes");
        }),
      ]);

      expect(await dispatch(program, argv, context)).toEqual({ exitCode });
      expect(
        onStandardError ? context.stderrText() : context.stdoutText(),
      ).toContain(usage);
      expect(
        onStandardError ? context.stdoutText() : context.stderrText(),
      ).toBe("");
    },
  );

  test("still shows root help on standard error and fails without arguments", async () => {
    const context = captureContext();
    const program = createRootProgram(coreDependencies, [
      namespace("notes", (command) =>
        command.description("Take notes").command("daily"),
      ),
    ]);

    expect(await dispatch(program, [], context)).toEqual({
      exitCode: EXIT_FAILURE,
    });
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toContain("Usage: tx [options] [command]");
  });

  // A command's error is a command failure however closely it resembles one
  // of the parser's own exits, which only the host's override can raise.
  test.each(["ENOENT", "commander.version", "commander.helpDisplayed"])(
    "does not mistake a command's own error code %p for a parser outcome",
    async (code) => {
      const context = captureContext();
      const program = createRootProgram(coreDependencies, [
        namespace("notes", (command) =>
          command.action(() => {
            throw Object.assign(new Error("disk missing"), { code });
          }),
        ),
      ]);

      expect(await dispatch(program, ["notes"], context)).toEqual({
        exitCode: EXIT_FAILURE,
      });
      expect(context.stdoutText()).toBe("");
      expect(context.stderrText()).toBe("Error: disk missing\n");
    },
  );
});
