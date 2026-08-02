import { describe, expect, test } from "bun:test";

import {
  type CommandHandler,
  CommandRegistry,
  dispatch,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  normalizeCommandPath,
} from "../src/commands.ts";
import type { CommandOwner, CommandProcessContext } from "../src/context.ts";

const coreOwner: CommandOwner = { marketplace: "core", plugin: "notes" };
const externalOwner: CommandOwner = {
  marketplace: "personal",
  plugin: "journal",
};

function outputContext(): CommandProcessContext & {
  stdoutText(): string;
  stderrText(): string;
} {
  let stdout = "";
  let stderr = "";

  return {
    cwd: "/work",
    env: { TX_TEST: "yes" },
    stdin: {} as NodeJS.ReadStream,
    stdout: {
      write(value: string) {
        stdout += value;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write(value: string) {
        stderr += value;
        return true;
      },
    } as NodeJS.WriteStream,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function registerNoop(
  registry: CommandRegistry,
  path: string | readonly string[],
  owner: CommandOwner = coreOwner,
  handler: CommandHandler = () => {},
) {
  return registry.register(path, owner, handler);
}

describe("command path normalization", () => {
  test("splits and trims string paths", () => {
    expect(normalizeCommandPath("  notes   daily open  ")).toEqual([
      "notes",
      "daily",
      "open",
    ]);
  });

  test("preserves array segment boundaries while trimming", () => {
    const normalized = normalizeCommandPath([" notes ", "daily open"]);

    expect(normalized).toEqual(["notes", "daily open"]);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  test.each([
    ["an empty string", ""],
    ["a whitespace string", "   "],
    ["an empty array", []],
    ["an empty array segment", ["notes", ""]],
    ["a whitespace array segment", ["notes", "  "]],
    ["a non-string array segment", ["notes", 3] as unknown as string[]],
  ])("rejects %s", (_label, path) => {
    expect(() => normalizeCommandPath(path)).toThrow(
      "Command path must contain one or more non-empty segments",
    );
  });
});

describe("CommandRegistry", () => {
  test("registers commands from string and array paths", () => {
    const registry = new CommandRegistry();
    const first = registerNoop(registry, "notes list");
    const second = registerNoop(registry, ["marketplace", "add"]);

    expect(first.path).toEqual(["notes", "list"]);
    expect(first.owner).toEqual(coreOwner);
    expect(first.owner).not.toBe(coreOwner);
    expect(registry.resolve(["notes", "list"])).toBe(first);
    expect(registry.resolve(["marketplace", "add"])).toBe(second);
  });

  test("snapshots and freezes command path and owner metadata", async () => {
    const registry = new CommandRegistry();
    const path = ["notes"];
    const owner = { marketplace: "original", plugin: "journal" };
    let received:
      | { args: string[]; marketplace: string; plugin: string }
      | undefined;
    const command = registry.register(path, owner, (args, context) => {
      received = {
        args,
        marketplace: context.marketplace,
        plugin: context.plugin,
      };
    });

    path[0] = "changed";
    owner.marketplace = "changed";
    owner.plugin = "changed";

    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.path)).toBe(true);
    expect(Object.isFrozen(command.owner)).toBe(true);
    expect(() => ((command.path as string[])[0] = "changed")).toThrow();
    expect(
      () =>
        ((command.owner as { marketplace: string }).marketplace = "changed"),
    ).toThrow();

    expect(
      await dispatch(registry, ["notes", "today"], outputContext()),
    ).toEqual({ exitCode: EXIT_SUCCESS, command });
    expect(received).toEqual({
      args: ["today"],
      marketplace: "original",
      plugin: "journal",
    });
    expect(() => registerNoop(registry, "notes", externalOwner)).toThrow(
      'Command "notes" is already registered by original/journal; cannot register it for personal/journal',
    );
  });

  test("allows command prefixes to coexist in either registration order", () => {
    const descendantsFirst = new CommandRegistry();
    const nested = registerNoop(descendantsFirst, "notes daily open");
    const parent = registerNoop(descendantsFirst, "notes");
    const parentsFirst = new CommandRegistry();
    const otherParent = registerNoop(parentsFirst, "notes");
    const otherNested = registerNoop(parentsFirst, "notes daily open");

    expect(descendantsFirst.resolve(["notes", "daily", "open"])).toBe(nested);
    expect(descendantsFirst.resolve(["notes"])).toBe(parent);
    expect(parentsFirst.resolve(["notes"])).toBe(otherParent);
    expect(parentsFirst.resolve(["notes", "daily", "open"])).toBe(otherNested);
  });

  test("reports exact collisions with the command and both owners", () => {
    const registry = new CommandRegistry();
    registerNoop(registry, "notes list", coreOwner);

    expect(() =>
      registerNoop(registry, ["notes", "list"], externalOwner),
    ).toThrow(
      'Command "notes list" is already registered by core/notes; cannot register it for personal/journal',
    );
  });

  test("resolves the longest registered prefix", () => {
    const registry = new CommandRegistry();
    const parent = registerNoop(registry, "notes");
    const nested = registerNoop(registry, "notes daily open");

    expect(registry.resolve(["notes", "daily", "open", "today"])).toBe(nested);
    expect(registry.resolve(["notes", "other"])).toBe(parent);
    expect(registry.resolve(["unknown"])).toBeUndefined();
  });

  test("renders deterministic root, nested, and leaf help from the tree", () => {
    const registry = new CommandRegistry();
    registerNoop(registry, "zebra");
    registerNoop(registry, "notes daily open");
    registerNoop(registry, "notes list");
    registerNoop(registry, "alpha");

    expect(registry.help()).toBe(
      "Usage: tx <command>\n\nCommands:\n  alpha\n  notes\n  zebra\n",
    );
    expect(registry.help(["notes"])).toBe(
      "Usage: tx notes <command>\n\nCommands:\n  daily\n  list\n",
    );
    expect(registry.help(["notes", "daily", "open"])).toBe(
      "Usage: tx notes daily open\n",
    );
    expect(registry.help(["missing"])).toBeUndefined();
  });
});

describe("dispatch", () => {
  test("shows root help when argv is empty", async () => {
    const registry = new CommandRegistry();
    registerNoop(registry, "notes");
    const context = outputContext();

    expect(await dispatch(registry, [], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(context.stdoutText()).toContain("Commands:\n  notes");
    expect(context.stderrText()).toBe("");
  });

  test("shows root, nested, and leaf help for --help", async () => {
    const registry = new CommandRegistry();
    registerNoop(registry, "notes daily open");

    for (const [argv, usage] of [
      [["--help"], "Usage: tx <command>"],
      [["notes", "--help"], "Usage: tx notes <command>"],
      [["notes", "today", "--help"], "Usage: tx notes <command>"],
      [
        ["notes", "daily", "today", "--help"],
        "Usage: tx notes daily <command>",
      ],
      [["notes", "daily", "open", "--help"], "Usage: tx notes daily open"],
    ] as const) {
      const context = outputContext();
      const result = await dispatch(registry, argv, context);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(context.stdoutText()).toStartWith(usage);
      expect(context.stderrText()).toBe("");
    }
  });

  test("reports unknown commands and unknown help paths", async () => {
    const registry = new CommandRegistry();

    for (const [argv, command] of [
      [["not-a-command", "value"], "not-a-command value"],
      [["not-a-command", "--help"], "not-a-command"],
    ] as const) {
      const context = outputContext();
      expect(await dispatch(registry, argv, context)).toEqual({
        exitCode: EXIT_USAGE,
      });
      expect(context.stdoutText()).toBe("");
      expect(context.stderrText()).toBe(
        `Error: Unknown command "${command}". Run "tx --help" for usage.\n`,
      );
    }
  });

  test("passes exact remaining argv and selected-owner context", async () => {
    const registry = new CommandRegistry();
    const context = outputContext();
    let received:
      | {
          args: string[];
          marketplace: string;
          plugin: string;
          sameCwd: boolean;
        }
      | undefined;
    const command = registerNoop(
      registry,
      "notes daily open",
      externalOwner,
      (args, handlerContext) => {
        received = {
          args,
          marketplace: handlerContext.marketplace,
          plugin: handlerContext.plugin,
          sameCwd: handlerContext.cwd === context.cwd,
        };
      },
    );

    expect(
      await dispatch(
        registry,
        ["notes", "daily", "open", "today", "--json"],
        context,
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS, command });
    expect(received).toEqual({
      args: ["today", "--json"],
      marketplace: "personal",
      plugin: "journal",
      sameCwd: true,
    });
  });

  test("awaits asynchronous handlers", async () => {
    const registry = new CommandRegistry();
    let completed = false;
    registerNoop(registry, "async", coreOwner, async () => {
      await Promise.resolve();
      completed = true;
    });

    const result = await dispatch(registry, ["async"], outputContext());
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(completed).toBe(true);
  });

  test.each([
    [
      "synchronous Error",
      () => {
        throw new Error("sync failed");
      },
      "Error: sync failed\n",
    ],
    [
      "asynchronous Error",
      async () => {
        throw new Error("async failed");
      },
      "Error: async failed\n",
    ],
    [
      "non-Error value",
      () => {
        throw "plain failure";
      },
      "Error: plain failure\n",
    ],
  ])(
    "reports a %s with an explicit failure exit code",
    async (_label, handler, message) => {
      const registry = new CommandRegistry();
      const context = outputContext();
      const command = registerNoop(registry, "fail", coreOwner, handler);

      expect(await dispatch(registry, ["fail"], context)).toEqual({
        exitCode: EXIT_FAILURE,
        command,
      });
      expect(context.stderrText()).toBe(message);
      expect(context.stdoutText()).toBe("");
    },
  );
});
