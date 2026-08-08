import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPlugins } from "../cli.ts";
import packageMetadata from "../package.json" with { type: "json" };
import { main } from "../src/cli.ts";
import { createProcessContext } from "../src/context.ts";
import type { PluginDefinition } from "../src/plugin.ts";
import { captureContext, temporaryDirectory } from "./helpers.ts";

function failingDefinition(): PluginDefinition {
  return {
    identity: { name: "broken" },
    load() {
      throw new Error("boom");
    },
  };
}

function writingDefinition(
  name: string,
  text: string,
  exitCode = 0,
): PluginDefinition {
  return {
    identity: { name },
    load: () => (api) => {
      api.command((namespace) =>
        namespace.description(`${name} commands`).action(() => {
          api.context.stdout.write(text);
          if (exitCode !== 0) throw new Error("handler failed");
        }),
      );
    },
  };
}

describe("root version fast path", () => {
  test.each([
    ["--version", []],
    ["--version", ["extra"]],
    ["-V", []],
    ["-V", ["marketplace", "list"]],
  ])(
    "reports the package version for %s before plugin initialization",
    async (option, rest) => {
      const context = captureContext();
      let loaded = false;

      expect(
        await main(
          [option, ...rest],
          [
            {
              identity: { name: "must-not-load" },
              load() {
                loaded = true;
                throw new Error("unexpected plugin load");
              },
            },
          ],
          context,
        ),
      ).toBe(0);
      expect(loaded).toBe(false);
      expect(context.stdoutText()).toBe(`${packageMetadata.version}\n`);
      expect(context.stderrText()).toBe("");
    },
  );

  test("does not claim a version option that follows a plugin namespace", async () => {
    const context = captureContext();

    expect(
      await main(
        ["notes", "--version"],
        [
          {
            identity: { name: "notes" },
            load: () => (api) => {
              api.command((namespace) =>
                namespace
                  .option("--version", "the plugin's own version flag")
                  .action((flags: Record<string, unknown>) => {
                    api.context.stdout.write(`${JSON.stringify(flags)}\n`);
                  }),
              );
            },
          },
        ],
        context,
      ),
    ).toBe(0);
    expect(context.stdoutText()).toBe('{"version":true}\n');
    expect(context.stderrText()).toBe("");
  });
});

describe("main", () => {
  // The tests below that bootstrap the bundled plugins discover marketplaces
  // from the data directory their context supplies, which falls back to the
  // real user data directory when the context supplies none. Pointing it at an
  // empty one keeps their stream assertions about dispatch rather than about
  // whatever the machine running the suite happens to have installed.
  let emptyDataHome = "";

  beforeAll(async () => {
    emptyDataHome = await temporaryDirectory("tx-cli-main-");
  });

  afterAll(async () => {
    await rm(emptyDataHome, { recursive: true, force: true });
  });

  test("returns the dispatched command's exit code with injected process wiring", async () => {
    const context = captureContext();

    expect(
      await main(["fail"], [writingDefinition("fail", "ran\n", 1)], context),
    ).toBe(1);
    expect(context.stdoutText()).toBe("ran\n");
    expect(context.stderrText()).toBe("Error: handler failed\n");
  });

  test("bootstraps the plugins it is given and nothing else", async () => {
    const bundled = captureContext({ XDG_DATA_HOME: emptyDataHome });
    expect(await main(["marketplace", "--help"], defaultPlugins, bundled)).toBe(
      0,
    );
    expect(bundled.stdoutText()).toContain("Usage: tx marketplace");
    expect(bundled.stdoutText()).toContain("add [options] <source>");
    expect(bundled.stderrText()).toBe("");

    const bare = captureContext();
    expect(await main([], [], bare)).toBe(1);
    expect(bare.stdoutText()).toBe("");
    expect(bare.stderrText()).toStartWith("Usage: tx [options]\n");
    expect(bare.stderrText()).not.toContain("marketplace");
  });

  test("composes the executable plugin after every other default plugin", () => {
    // Composition order is the order participants are gathered and applied in,
    // and the executable goes last so that whatever the others own is updated
    // before the running binary is replaced. `tx update` itself is not
    // dispatched here: gathering the executable item contacts the release
    // host, which the executable plugin's own suite drives through an injected
    // fetch instead.
    expect(defaultPlugins.map((plugin) => plugin.identity.name)).toEqual([
      "marketplace",
      "update",
      "executable",
    ]);
  });

  // The bundled plugin keeps the parser's implicit help subcommand, so these
  // three outcomes are user-reachable today and must stay distinct.
  test.each([
    {
      label: "the bundled plugin's help subcommand",
      argv: ["marketplace", "help"],
      exitCode: 0,
      onStandardError: false,
      usage: "Usage: tx marketplace",
    },
    {
      label: "the bundled plugin's help subcommand for one of its commands",
      argv: ["marketplace", "help", "add"],
      exitCode: 0,
      onStandardError: false,
      usage: "Usage: tx marketplace add",
    },
    {
      label: "the bundled namespace with no subcommand",
      argv: ["marketplace"],
      exitCode: 1,
      onStandardError: true,
      usage: "Usage: tx marketplace",
    },
  ])("answers $label", async ({ argv, exitCode, onStandardError, usage }) => {
    const context = captureContext({ XDG_DATA_HOME: emptyDataHome });

    expect(await main(argv, defaultPlugins, context)).toBe(exitCode);
    expect(
      onStandardError ? context.stderrText() : context.stdoutText(),
    ).toContain(usage);
    expect(onStandardError ? context.stdoutText() : context.stderrText()).toBe(
      "",
    );
  });

  test("reports ordered load errors without changing the dispatched exit code", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "tx-cli-plugins-"));
    const marketplaceRoot = join(dataHome, "tx", "marketplaces");
    try {
      for (const name of ["alpha", "beta", "gamma", "delta"]) {
        await mkdir(join(marketplaceRoot, name, ".tx"), { recursive: true });
      }
      await writeFile(
        join(marketplaceRoot, "alpha", "command.ts"),
        'export default ({ command, context }) => command((namespace) => namespace.action(() => context.stdout.write("dispatched\\n")));\n',
      );
      await writeFile(
        join(marketplaceRoot, "alpha", ".tx/config.json"),
        '{"plugins":[{"name":"healthy","entry":"command.ts"}]}',
      );
      await writeFile(
        join(marketplaceRoot, "beta", "broken.ts"),
        "export default 42;\n",
      );
      await writeFile(
        join(marketplaceRoot, "beta", ".tx/config.json"),
        '{"plugins":[{"name":"broken","entry":"broken.ts"}]}',
      );
      await writeFile(
        join(marketplaceRoot, "gamma", "throwing.ts"),
        'export default () => { throw "plain failure"; };\n',
      );
      await writeFile(
        join(marketplaceRoot, "gamma", ".tx/config.json"),
        '{"plugins":[{"name":"throwing","entry":"throwing.ts"}]}',
      );
      await writeFile(join(marketplaceRoot, "delta", ".tx/config.json"), "{}");

      const context = captureContext({ XDG_DATA_HOME: dataHome });

      expect(await main(["healthy"], defaultPlugins, context)).toBe(0);
      expect(context.stdoutText()).toBe("dispatched\n");
      expect(context.stderrText()).toBe(
        [
          'Error loading plugin marketplace/installed/delta: Marketplace "delta" failed: .tx/config.json must contain a plugins array. Run "tx marketplace remove delta" to remove it.',
          'Error loading plugin marketplace/installed/beta/broken: Marketplace "beta" plugin "broken" failed: Plugin broken must default-export a function. Run "tx marketplace remove beta" to remove it.',
          'Error loading plugin marketplace/installed/gamma/throwing: Marketplace "gamma" plugin "throwing" failed: plain failure. Run "tx marketplace remove gamma" to remove it.',
          "",
        ].join("\n"),
      );
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  test("keeps a committed namespace when a later plugin claims the same name", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "tx-cli-collision-"));
    const checkout = join(dataHome, "tx", "marketplaces", "personal");
    try {
      await mkdir(join(checkout, ".tx"), { recursive: true });
      await writeFile(
        join(checkout, "collision.test.ts"),
        'export default ({ command }) => command((namespace) => namespace.command("list"));\n',
      );
      await writeFile(
        join(checkout, ".tx/config.json"),
        '{"plugins":[{"name":"marketplace","entry":"collision.test.ts"}]}',
      );
      const context = captureContext({ XDG_DATA_HOME: dataHome });

      expect(await main(["marketplace", "list"], defaultPlugins, context)).toBe(
        0,
      );
      expect(context.stdoutText()).toBe(`personal\t<unknown>\n`);
      expect(context.stderrText()).toContain(
        'Error loading plugin marketplace/installed/personal/marketplace: Namespace "marketplace" is already claimed by marketplace; cannot claim it for marketplace/installed/personal/marketplace',
      );
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  test("keeps a failing handler's exit code alongside a plugin load failure", async () => {
    const context = captureContext();

    expect(
      await main(
        ["fail"],
        [writingDefinition("fail", "", 1), failingDefinition()],
        context,
      ),
    ).toBe(1);
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toBe(
      "Error loading plugin broken: boom\nError: handler failed\n",
    );
  });

  test("resolves a namespace a failed plugin would have owned as unknown", async () => {
    const context = captureContext();

    expect(await main(["broken"], [failingDefinition()], context)).toBe(1);
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toBe(
      [
        "Error loading plugin broken: boom",
        'Error: Unknown command "broken". Run "tx --help" for usage.',
        "",
      ].join("\n"),
    );
  });
});

describe("entrypoint", () => {
  // These spawns run the real CLI, which discovers marketplaces from the
  // ambient data directory. Pointing it at an empty one keeps the exact
  // stream assertions below about the entrypoint rather than about whatever
  // the machine running the suite happens to have installed.
  let dataHome = "";
  const isolatedEnvironment = () => ({
    ...process.env,
    XDG_DATA_HOME: dataHome,
  });

  beforeAll(async () => {
    dataHome = await temporaryDirectory("tx-cli-entrypoint-");
  });

  afterAll(async () => {
    await rm(dataHome, { recursive: true, force: true });
  });

  test("reflects the current process in the default context", () => {
    const context = createProcessContext();

    expect(context.cwd).toBe(process.cwd());
    expect(context.env).toBe(process.env);
    expect(context.stdin).toBe(process.stdin);
    expect(context.stdout).toBe(process.stdout);
    expect(context.stderr).toBe(process.stderr);
  });

  test("does not invoke main on import", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        'Bun.argv.slice = () => { throw new Error("main invoked during import"); }; await import("./cli.ts");',
      ],
      { cwd: `${import.meta.dir}/..`, env: isolatedEnvironment() },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });

  test("retains import.meta.main wiring for root help", () => {
    const result = Bun.spawnSync(
      [process.execPath, "run", "cli.ts", "--help"],
      { cwd: `${import.meta.dir}/..`, env: isolatedEnvironment() },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage: tx [options] [command]");
    expect(result.stdout.toString()).toContain("marketplace");
    expect(result.stderr.toString()).toBe("");
  });

  test("exposes usage failures as process exit codes", () => {
    const result = Bun.spawnSync(
      [process.execPath, "run", "cli.ts", "unknown"],
      { cwd: `${import.meta.dir}/..`, env: isolatedEnvironment() },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      'Error: Unknown command "unknown". Run "tx --help" for usage.\n',
    );
  });
});
