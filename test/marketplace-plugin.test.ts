import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMarketplacePlugin,
  type MarketplaceOperations,
} from "../plugins/marketplace/index.ts";
import updatePlugin from "../plugins/update/index.ts";
import {
  createRootProgram,
  dispatch,
  EXIT_FAILURE,
  EXIT_SUCCESS,
} from "../src/commands.ts";
import type { CommandProcessContext } from "../src/context.ts";
import { coreDependencies, initializePlugins } from "../src/plugins.ts";
import {
  captureContext as captureCommandContext,
  createGitRepository,
  fixtureGit,
  temporaryDirectory,
} from "./helpers.ts";

const missingDataHome = "/definitely/missing/tx-marketplace-plugin-tests";

/** Keep plugin discovery independent of marketplaces installed for the user
 * running the suite; tests that need storage pass their own data directory. */
function captureContext(
  env: Record<string, string | undefined> = {
    XDG_DATA_HOME: missingDataHome,
  },
) {
  return captureCommandContext(env);
}

class RecordingManager implements MarketplaceOperations {
  readonly calls: unknown[][] = [];
  listings = [
    { name: "alpha", version: "v1.4.0", source: "ssh://example/alpha.git" },
    { name: "broken", version: "<unknown>", source: "<unknown>" },
  ];

  async add(repository: string, name?: string): Promise<string> {
    this.calls.push(["add", repository, name]);
    return name ?? "derived";
  }

  async list() {
    this.calls.push(["list"]);
    return this.listings;
  }

  async pin(name: string, ref: string): Promise<string> {
    this.calls.push(["pin", name, ref]);
    return "v1.4.0";
  }

  async remove(name: string): Promise<void> {
    this.calls.push(["remove", name]);
  }

  async unpin(name: string): Promise<void> {
    this.calls.push(["unpin", name]);
  }
}

let emptyDataHome = "";

beforeAll(async () => {
  emptyDataHome = await temporaryDirectory("tx-marketplace-plugin-empty-");
});

afterAll(async () => {
  await rm(emptyDataHome, { recursive: true, force: true });
});

async function setup(
  context: CommandProcessContext,
  manager = new RecordingManager(),
) {
  const { namespaces, failures } = await initializePlugins(
    [createMarketplacePlugin({ manager })],
    {
      context: {
        ...context,
        env: { ...context.env, XDG_DATA_HOME: emptyDataHome },
      },
    },
  );
  expect(failures).toEqual([]);
  return {
    manager,
    program: createRootProgram(coreDependencies, namespaces),
  };
}

describe("first-party marketplace plugin", () => {
  test("declares its namespace, subcommands, arguments, and options", async () => {
    const context = captureContext();
    const { program } = await setup(context);

    expect(await dispatch(program, ["--help"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(context.stdoutText()).toMatch(
      /^ +marketplace +Manage installed plugin marketplaces$/m,
    );

    const namespaceHelp = captureContext();
    expect(
      await dispatch(program, ["marketplace", "--help"], namespaceHelp),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(namespaceHelp.stdoutText()).toContain(
      "Usage: tx marketplace [options] [command]",
    );
    expect(namespaceHelp.stdoutText()).toContain("add [options] <source>");
    expect(namespaceHelp.stdoutText()).toContain("list ");
    expect(namespaceHelp.stdoutText()).toContain("pin <name> <ref>");
    expect(namespaceHelp.stdoutText()).toContain("unpin <name>");
    expect(namespaceHelp.stdoutText()).toContain("remove <name>");
    expect(namespaceHelp.stderrText()).toBe("");

    const addHelp = captureContext();
    expect(
      await dispatch(program, ["marketplace", "add", "--help"], addHelp),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(addHelp.stdoutText()).toContain(
      "Usage: tx marketplace add [options] <source>",
    );
    expect(addHelp.stdoutText()).toContain("--name <name>");
    expect(addHelp.stderrText()).toBe("");
  });

  test.each([
    ["a derived name", ["repository"], ["add", "repository", undefined]],
    [
      "an explicit name before the repository",
      ["--name", "personal", "repository"],
      ["add", "repository", "personal"],
    ],
    [
      "an explicit name after the repository",
      ["repository", "--name", "personal"],
      ["add", "repository", "personal"],
    ],
  ])("adds with %s", async (_label, args, call) => {
    const context = captureContext();
    const { manager, program } = await setup(context);

    expect(
      await dispatch(program, ["marketplace", "add", ...args], context),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(manager.calls).toEqual([call]);
    expect(context.stdoutText()).toBe(
      `Added marketplace "${call[2] ?? "derived"}".\n`,
    );
    expect(context.stderrText()).toBe("");
  });

  test("lists manager results including unknown sources", async () => {
    const context = captureContext();
    const { manager, program } = await setup(context);

    expect(await dispatch(program, ["marketplace", "list"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(manager.calls).toEqual([["list"]]);
    expect(context.stdoutText()).toBe(
      "alpha\tv1.4.0\tssh://example/alpha.git\nbroken\t<unknown>\t<unknown>\n",
    );
    expect(context.stderrText()).toBe("");
  });

  test("pins through the manager and reports what the next update applies", async () => {
    const context = captureContext();
    const { manager, program } = await setup(context);

    expect(
      await dispatch(
        program,
        ["marketplace", "pin", "personal", "1.4.0"],
        context,
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(manager.calls).toEqual([["pin", "personal", "1.4.0"]]);
    expect(context.stdoutText()).toBe(
      'Pinned marketplace "personal" to "1.4.0"; the next "tx update" applies v1.4.0.\n',
    );
    expect(context.stderrText()).toBe("");
  });

  test("unpins through the manager and reports what it tracks again", async () => {
    const context = captureContext();
    const { manager, program } = await setup(context);

    expect(
      await dispatch(program, ["marketplace", "unpin", "personal"], context),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(manager.calls).toEqual([["unpin", "personal"]]);
    expect(context.stdoutText()).toBe(
      'Unpinned marketplace "personal"; it tracks its remote\'s default branch again.\n',
    );
    expect(context.stderrText()).toBe("");
  });

  test("removes through the manager and reports success", async () => {
    const context = captureContext();
    const { manager, program } = await setup(context);

    expect(
      await dispatch(program, ["marketplace", "remove", "personal"], context),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(manager.calls).toEqual([["remove", "personal"]]);
    expect(context.stdoutText()).toBe('Removed marketplace "personal".\n');
    expect(context.stderrText()).toBe("");
  });

  test.each([
    ["add", [], "missing required argument 'source'"],
    ["add", ["one", "two"], "too many arguments"],
    [
      "add",
      ["repository", "--name"],
      "option '--name <name>' argument missing",
    ],
    ["add", ["repository", "--unknown"], "unknown option '--unknown'"],
    ["list", ["extra"], "too many arguments"],
    ["pin", ["personal"], "missing required argument 'ref'"],
    ["pin", ["one", "two", "three"], "too many arguments"],
    ["unpin", [], "missing required argument 'name'"],
    ["unpin", ["one", "two"], "too many arguments"],
    ["remove", [], "missing required argument 'name'"],
    ["remove", ["one", "two"], "too many arguments"],
  ])("reports declared %s usage errors", async (command, args, message) => {
    const context = captureContext();
    const { manager, program } = await setup(context);

    expect(
      await dispatch(program, ["marketplace", command, ...args], context),
    ).toEqual({ exitCode: EXIT_FAILURE });
    expect(manager.calls).toEqual([]);
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toContain(message);
  });

  test.each([
    ["add", ["repository", "--name", "../escape"]],
    ["pin", ["../escape", "v1.4.0"]],
    ["unpin", ["../escape"]],
    ["remove", ["../escape"]],
  ])(
    "keeps rejecting unsafe %s names through its own namespace",
    async (command, args) => {
      const context = captureContext();
      const { manager, program } = await setup(context);

      expect(
        await dispatch(program, ["marketplace", command, ...args], context),
      ).toEqual({ exitCode: EXIT_FAILURE });
      expect(manager.calls).toEqual([]);
      expect(context.stdoutText()).toBe("");
      expect(context.stderrText()).toBe(
        'Error: Invalid marketplace name "../escape"; expected one safe path component\n',
      );
    },
  );

  test("maps discovery storage failures without disabling management commands", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-discovery-");
    const dataHome = join(temporaryRoot, "data");
    const storage = join(dataHome, "tx", "marketplaces");
    try {
      await mkdir(join(dataHome, "tx"), { recursive: true });
      await writeFile(storage, "not a directory");
      const context = captureContext({ XDG_DATA_HOME: dataHome });

      const { namespaces, failures } = await initializePlugins(
        [createMarketplacePlugin({ manager: new RecordingManager() })],
        { context },
      );

      expect(failures).toHaveLength(1);
      expect(failures[0]?.identity).toEqual({
        name: "installed",
        parent: { name: "marketplace" },
      });
      expect(failures[0]?.message).toStartWith(
        "Marketplace discovery failed: ENOTDIR",
      );
      expect(failures[0]?.message).toEndWith(
        `Check that marketplace storage at "${storage}" is readable, then retry.`,
      );
      expect(failures[0]?.message).not.toContain("marketplace remove");

      expect(
        await dispatch(
          createRootProgram(coreDependencies, namespaces),
          ["marketplace", "list"],
          context,
        ),
      ).toEqual({ exitCode: EXIT_SUCCESS });
      expect(context.stdoutText()).toBe(
        "alpha\tv1.4.0\tssh://example/alpha.git\nbroken\t<unknown>\t<unknown>\n",
      );
      expect(context.stderrText()).toBe("");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("diagnoses degraded references while a healthy one still dispatches", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-stale-");
    const dataHome = join(temporaryRoot, "data");
    const storage = join(dataHome, "tx", "marketplaces");
    try {
      const source = join(temporaryRoot, "source");
      await Promise.all([
        mkdir(join(source, ".tx"), { recursive: true }),
        mkdir(storage, { recursive: true }),
        writeFile(join(temporaryRoot, "replacement.txt"), "not a checkout"),
      ]);
      await Promise.all([
        writeFile(
          join(source, "plugin.ts"),
          `export default ({ command, context }) => {
            command((namespace) => namespace
              .command("run")
              .action(() => context.stdout.write("linked\\n")));
          };\n`,
        ),
        writeFile(
          join(source, ".tx/config.json"),
          '{"plugins":[{"name":"linked","entry":"plugin.ts"}]}',
        ),
      ]);
      await Promise.all([
        symlink(source, join(storage, "healthy")),
        symlink(join(temporaryRoot, "moved-away"), join(storage, "dangling")),
        symlink(
          join(temporaryRoot, "replacement.txt"),
          join(storage, "replaced"),
        ),
      ]);
      const context = captureContext({ XDG_DATA_HOME: dataHome });

      const { namespaces, failures } = await initializePlugins(
        [createMarketplacePlugin({ manager: new RecordingManager() })],
        { context },
      );

      const installed = { name: "installed", parent: { name: "marketplace" } };
      expect(failures.map(({ identity }) => identity)).toEqual([
        { name: "dangling", parent: installed },
        { name: "replaced", parent: installed },
      ]);
      expect(failures[0]?.message).toBe(
        'Marketplace "dangling" failed: Missing .tx/config.json. Run "tx marketplace remove dangling" to remove it.',
      );
      expect(failures[1]?.message).toStartWith(
        'Marketplace "replaced" failed: Unable to read .tx/config.json',
      );
      expect(failures[1]?.message).toEndWith(
        'Run "tx marketplace remove replaced" to remove it.',
      );

      expect(
        await dispatch(
          createRootProgram(coreDependencies, namespaces),
          ["linked", "run"],
          context,
        ),
      ).toEqual({ exitCode: EXIT_SUCCESS });
      expect(context.stdoutText()).toBe("linked\n");
      expect(context.stderrText()).toBe("");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("contributes an update participant covering installed storage", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-updates-");
    const dataHome = join(temporaryRoot, "data");
    try {
      const remote = await createGitRepository(temporaryRoot, "remote", {
        ".tx/config.json": '{"plugins":[{"name":"tools","entry":"plugin.ts"}]}',
        "plugin.ts": "export default () => {};\n",
      });
      fixtureGit(remote, ["tag", "v1.0.0"]);
      fixtureGit(temporaryRoot, [
        "clone",
        "--quiet",
        "--",
        pathToFileURL(remote).href,
        join(dataHome, "tx", "marketplaces", "tools"),
      ]);
      const context = captureContext({ XDG_DATA_HOME: dataHome });

      const { namespaces, failures } = await initializePlugins(
        [createMarketplacePlugin(), updatePlugin],
        { context },
      );
      expect(failures).toEqual([]);

      // Through the driver, so the participant really was committed: a dry run
      // reports the marketplace and applies nothing.
      expect(
        await dispatch(
          createRootProgram(coreDependencies, namespaces),
          ["update", "--dry-run"],
          context,
        ),
      ).toEqual({ exitCode: EXIT_SUCCESS });
      expect(context.stdoutText()).toBe("tools\tv1.0.0\tup to date\n");
      expect(context.stderrText()).toBe("");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("resolves marketplace storage from its initialization context", async () => {
    const context = captureContext();
    const { namespaces, failures } = await initializePlugins(
      [createMarketplacePlugin()],
      { context },
    );

    expect(failures).toEqual([]);
    expect(
      await dispatch(
        createRootProgram(coreDependencies, namespaces),
        ["marketplace", "list"],
        context,
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toBe("");
  });
});
