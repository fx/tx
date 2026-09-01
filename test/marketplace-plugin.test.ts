import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginDefinition } from "@fx/tx/plugin";
import {
  createMarketplacePlugin,
  type MarketplaceAddOptions,
  type MarketplaceOperations,
} from "../plugins/marketplace/index.ts";
import { MarketplaceAlreadyInstalledError } from "../plugins/marketplace/manager.ts";
import updatePlugin from "../plugins/update/index.ts";
import {
  createRootProgram,
  dispatch,
  EXIT_FAILURE,
  EXIT_SUCCESS,
} from "../src/commands.ts";
import { coreDependencies, initializePlugins } from "../src/plugins.ts";
import {
  type CapturedContext,
  captureContext as captureCommandContext,
  createGitRepository,
  fixtureGit,
  temporaryDirectory,
} from "./helpers.ts";

interface MarketplaceTestContext extends CapturedContext {
  readonly marketplaceRoot: string;
}

let isolatedMarketplaceRoot = "";

/** Give every plugin constructed from this context an explicit temporary
 * discovery root, independent of every platform's real user-data location. */
function captureContext(
  marketplaceRoot = isolatedMarketplaceRoot,
  env: Record<string, string | undefined> = {},
): MarketplaceTestContext {
  return Object.assign(captureCommandContext(env), { marketplaceRoot });
}

function marketplacePlugin(
  context: MarketplaceTestContext,
  manager?: MarketplaceOperations,
) {
  const root = context.marketplaceRoot;
  return createMarketplacePlugin(
    manager === undefined ? { root } : { manager, root },
  );
}

class RecordingManager implements MarketplaceOperations {
  readonly calls: unknown[][] = [];
  readonly addFailures = new Map<string, unknown>();
  readonly resolvedNames = new Map<string, string>();
  listings = [
    { name: "alpha", version: "v1.4.0", source: "ssh://example/alpha.git" },
    { name: "broken", version: "<unknown>", source: "<unknown>" },
  ];

  async resolve(source: string, name?: string) {
    this.calls.push(["resolve", source, name]);
    return {
      name: name ?? this.resolvedNames.get(source) ?? source,
      source,
    };
  }

  async add(
    repository: string,
    name?: string,
    options?: MarketplaceAddOptions,
  ) {
    this.calls.push([
      "add",
      repository,
      name,
      ...(options === undefined ? [] : [options]),
    ]);
    const failure = this.addFailures.get(repository);
    if (failure !== undefined) throw failure;
    return {
      name: name ?? this.resolvedNames.get(repository) ?? "derived",
      source: repository,
    };
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

type ConfigValidator<T> = (value: unknown) => value is T;

class RecordingConfig {
  readonly calls: unknown[][] = [];
  value: unknown = undefined;
  guard: ConfigValidator<unknown> | undefined;
  defineFailure: unknown = undefined;
  readFailure: unknown = undefined;
  writeFailure: unknown = undefined;

  define<T>(key: string, guard: ConfigValidator<T>): void {
    this.calls.push(["define", key]);
    if (this.defineFailure !== undefined) throw this.defineFailure;
    this.guard = guard as ConfigValidator<unknown>;
  }

  async read<T>(key: string): Promise<T | undefined> {
    this.calls.push(["read", key]);
    if (this.readFailure !== undefined) throw this.readFailure;
    if (this.value !== undefined && !this.guard?.(this.value)) {
      throw new Error(`Persisted value for config key "${key}" is invalid`);
    }
    return this.value as T | undefined;
  }

  async write<T>(key: string, value: T): Promise<void> {
    this.calls.push(["write", key, value]);
    if (this.writeFailure !== undefined) throw this.writeFailure;
    this.value = value;
  }
}

function configProvider(config: RecordingConfig): PluginDefinition {
  return {
    identity: { name: "test-config" },
    load:
      () =>
      ({ register }) =>
        register("config", config),
  };
}

beforeAll(async () => {
  isolatedMarketplaceRoot = await temporaryDirectory(
    "tx-marketplace-plugin-empty-",
  );
});

afterAll(async () => {
  await rm(isolatedMarketplaceRoot, { recursive: true, force: true });
});

async function setup(
  context: MarketplaceTestContext,
  manager = new RecordingManager(),
  config = new RecordingConfig(),
) {
  const { namespaces, failures } = await initializePlugins(
    [marketplacePlugin(context, manager), configProvider(config)],
    { context },
  );
  expect(failures).toEqual([]);
  return {
    manager,
    config,
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
    expect(namespaceHelp.stdoutText()).toContain("install ");
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
    expect(addHelp.stdoutText()).toContain("--full");
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
    [
      "a full-tree request",
      ["repository", "--full"],
      ["add", "repository", undefined, { full: true }],
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
    const { config, manager, program } = await setup(context);

    expect(await dispatch(program, ["marketplace", "list"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(manager.calls).toEqual([["list"]]);
    expect(context.stdoutText()).toBe(
      "alpha\tv1.4.0\tssh://example/alpha.git\nbroken\t<unknown>\t<unknown>\n",
    );
    expect(context.stderrText()).toBe("");
    expect(config.calls).toEqual([]);
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

  test("writes add and remove mutations back under the exact config key", async () => {
    const addContext = captureContext();
    const addConfig = new RecordingConfig();
    addConfig.value = [{ source: "old", name: "derived" }];
    const added = await setup(addContext, new RecordingManager(), addConfig);

    expect(
      await dispatch(
        added.program,
        ["marketplace", "add", "repository"],
        addContext,
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(addConfig.value).toEqual([
      { source: "repository", name: "derived" },
    ]);
    expect(addConfig.calls.map((call) => call[0])).toEqual([
      "define",
      "read",
      "write",
    ]);

    const removeContext = captureContext();
    const removeConfig = new RecordingConfig();
    removeConfig.value = [
      { source: "seeded" },
      { source: "keep", name: "keep" },
    ];
    const removeManager = new RecordingManager();
    removeManager.resolvedNames.set("seeded", "personal");
    const removed = await setup(removeContext, removeManager, removeConfig);

    expect(
      await dispatch(
        removed.program,
        ["marketplace", "remove", "personal"],
        removeContext,
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(removeConfig.value).toEqual([{ source: "keep", name: "keep" }]);
    expect(removeManager.calls).toEqual([
      ["remove", "personal"],
      ["resolve", "seeded", undefined],
    ]);
  });

  test.each(["define", "read", "write"])(
    "reports a config %s failure without failing or undoing a successful add",
    async (operation) => {
      const context = captureContext();
      const config = new RecordingConfig();
      Reflect.set(
        config,
        `${operation}Failure`,
        new Error(`${operation} failed`),
      );
      const { manager, program } = await setup(
        context,
        new RecordingManager(),
        config,
      );

      expect(
        await dispatch(program, ["marketplace", "add", "repository"], context),
      ).toEqual({ exitCode: EXIT_SUCCESS });
      expect(manager.calls[0]).toEqual(["add", "repository", undefined]);
      expect(context.stdoutText()).toBe('Added marketplace "derived".\n');
      expect(context.stderrText()).toBe(
        `Marketplace "derived" was added, but config synchronization failed: ${operation} failed\n`,
      );
    },
  );

  test("reports config failure without failing a successful removal", async () => {
    const context = captureContext();
    const config = new RecordingConfig();
    config.readFailure = new Error("cannot read config");
    const { manager, program } = await setup(
      context,
      new RecordingManager(),
      config,
    );

    expect(
      await dispatch(program, ["marketplace", "remove", "personal"], context),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(manager.calls).toEqual([["remove", "personal"]]);
    expect(context.stdoutText()).toBe('Removed marketplace "personal".\n');
    expect(context.stderrText()).toContain(
      'Marketplace "personal" was removed, but config synchronization failed: cannot read config',
    );
  });

  test("installs only missing configured entries in order without writing config", async () => {
    const temporaryRoot = await temporaryDirectory("tx-configured-install-");
    try {
      const marketplaceRoot = join(temporaryRoot, "marketplaces");
      await mkdir(join(marketplaceRoot, "installed", ".tx"), {
        recursive: true,
      });
      await Promise.all([
        writeFile(
          join(marketplaceRoot, "installed", ".tx/config.json"),
          '{"plugins":[{"name":"installed-fixture","entry":"plugin.ts"}]}',
        ),
        writeFile(
          join(marketplaceRoot, "installed", "plugin.ts"),
          "export default () => {};\n",
        ),
      ]);
      const context = captureContext(marketplaceRoot);
      const config = new RecordingConfig();
      config.value = [
        { source: "installed-source", name: "installed" },
        { source: "missing-source", name: "missing" },
        { source: "seeded-source" },
      ];
      const manager = new RecordingManager();
      manager.resolvedNames.set("seeded-source", "seeded");
      const { program } = await setup(context, manager, config);

      expect(
        await dispatch(program, ["marketplace", "install"], context),
      ).toEqual({ exitCode: EXIT_SUCCESS });
      expect(manager.calls).toEqual([
        ["resolve", "installed-source", "installed"],
        ["resolve", "missing-source", "missing"],
        ["resolve", "seeded-source", undefined],
        ["add", "missing-source", "missing"],
        ["add", "seeded-source", undefined],
      ]);
      expect(context.stdoutText()).toBe(
        'Added marketplace "missing".\nAdded marketplace "seeded".\n',
      );
      expect(context.stderrText()).toBe("");
      expect(config.calls.some((call) => call[0] === "write")).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("tolerates an already-installed race, reports failures, and keeps going", async () => {
    const temporaryRoot = await temporaryDirectory("tx-configured-failures-");
    try {
      const context = captureContext(join(temporaryRoot, "marketplaces"));
      const config = new RecordingConfig();
      config.value = [
        { source: "race", name: "race" },
        { source: "broken", name: "broken" },
        { source: "healthy", name: "healthy" },
      ];
      const manager = new RecordingManager();
      manager.addFailures.set(
        "race",
        new MarketplaceAlreadyInstalledError("race"),
      );
      manager.addFailures.set("broken", new Error("clone broke"));
      const { program } = await setup(context, manager, config);

      expect(
        await dispatch(program, ["marketplace", "install"], context),
      ).toEqual({ exitCode: EXIT_FAILURE });
      expect(manager.calls.filter((call) => call[0] === "add")).toEqual([
        ["add", "race", "race"],
        ["add", "broken", "broken"],
        ["add", "healthy", "healthy"],
      ]);
      expect(context.stdoutText()).toBe('Added marketplace "healthy".\n');
      expect(context.stderrText()).toContain(
        'Failed to install configured marketplace "broken": clone broke\n',
      );
      expect(context.stderrText()).toContain(
        "Error: One or more configured marketplaces failed to install\n",
      );
      expect(context.stderrText()).not.toContain(
        'Failed to install configured marketplace "race"',
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test.each([
    [
      "explicit duplicates",
      [
        { source: "one", name: "same" },
        { source: "two", name: "same" },
      ],
    ],
    ["derived collision", [{ source: "one" }, { source: "two", name: "same" }]],
  ])("rejects a configured %s before any mutation", async (_label, entries) => {
    const temporaryRoot = await temporaryDirectory("tx-configured-collision-");
    try {
      const context = captureContext(join(temporaryRoot, "marketplaces"));
      const config = new RecordingConfig();
      config.value = entries;
      const manager = new RecordingManager();
      manager.resolvedNames.set("one", "same");
      const { program } = await setup(context, manager, config);

      expect(
        await dispatch(program, ["marketplace", "install"], context),
      ).toEqual({ exitCode: EXIT_FAILURE });
      expect(manager.calls.some((call) => call[0] === "add")).toBe(false);
      expect(context.stdoutText()).toBe("");
      expect(context.stderrText()).toContain(
        'Configured marketplace name "same" appears more than once',
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
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
    ["install", ["extra"], "too many arguments"],
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
      const context = captureContext(storage);

      const { namespaces, failures } = await initializePlugins(
        [marketplacePlugin(context, new RecordingManager())],
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
      const context = captureContext(storage);

      const { namespaces, failures } = await initializePlugins(
        [marketplacePlugin(context, new RecordingManager())],
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
      const context = captureContext(join(dataHome, "tx", "marketplaces"));

      const { namespaces, failures } = await initializePlugins(
        [marketplacePlugin(context), updatePlugin],
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

  test("uses an explicitly injected root instead of real user storage", async () => {
    const context = captureContext(isolatedMarketplaceRoot, {
      ...process.env,
    });
    const { namespaces, failures } = await initializePlugins(
      [marketplacePlugin(context)],
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
