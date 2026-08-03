import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPlugins } from "../cli.ts";
import { main } from "../src/cli.ts";
import { CommandRegistry } from "../src/commands.ts";
import {
  type CommandProcessContext,
  createProcessContext,
} from "../src/context.ts";

function quietContext(): CommandProcessContext {
  return {
    cwd: "/work",
    env: {},
    stdin: {} as NodeJS.ReadStream,
    stdout: { write: () => true } as unknown as NodeJS.WriteStream,
    stderr: { write: () => true } as unknown as NodeJS.WriteStream,
  };
}

function capturedContext(env: Record<string, string | undefined> = {}): {
  readonly context: CommandProcessContext;
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    context: {
      ...quietContext(),
      env,
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
    },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

test("main returns the dispatcher exit code with injected process wiring", async () => {
  const registry = new CommandRegistry();
  registry.register("fail", { name: "test", parent: { name: "core" } }, () => {
    throw new Error("failed");
  });

  expect(await main(["fail"], [], registry, quietContext())).toBe(1);
});

test("main bootstraps bundled plugins only for its default registry", async () => {
  let stdout = "";
  const context = {
    ...quietContext(),
    stdout: {
      write(value: string) {
        stdout += value;
        return true;
      },
    } as NodeJS.WriteStream,
  };

  expect(
    await main(
      ["marketplace", "--help"],
      defaultPlugins,
      new CommandRegistry(),
      context,
    ),
  ).toBe(0);
  expect(stdout).toBe(
    "Usage: tx marketplace <command>\n\nCommands:\n  add\n  list\n  remove\n",
  );

  stdout = "";
  expect(await main([], [], new CommandRegistry(), context)).toBe(0);
  expect(stdout).toBe("Usage: tx <command>\n");
});

test("default startup dispatches healthy plugins but returns failure for ordered load errors", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "tx-cli-plugins-"));
  const marketplaceRoot = join(dataHome, "tx", "marketplaces");
  try {
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      await mkdir(join(marketplaceRoot, name), { recursive: true });
    }
    await writeFile(
      join(marketplaceRoot, "alpha", "command.ts"),
      'export default ({ command }) => command("healthy", (_args, context) => context.stdout.write("dispatched\\n"));\n',
    );
    await writeFile(
      join(marketplaceRoot, "alpha", "tx.marketplace.json"),
      '{"plugins":[{"name":"command","entry":"command.ts"}]}',
    );
    await writeFile(
      join(marketplaceRoot, "beta", "broken.ts"),
      "export default 42;\n",
    );
    await writeFile(
      join(marketplaceRoot, "beta", "tx.marketplace.json"),
      '{"plugins":[{"name":"broken","entry":"broken.ts"}]}',
    );
    await writeFile(
      join(marketplaceRoot, "gamma", "throwing.ts"),
      'export default () => { throw "plain failure"; };\n',
    );
    await writeFile(
      join(marketplaceRoot, "gamma", "tx.marketplace.json"),
      '{"plugins":[{"name":"throwing","entry":"throwing.ts"}]}',
    );
    await writeFile(
      join(marketplaceRoot, "delta", "tx.marketplace.json"),
      "{}",
    );

    const output = capturedContext({ XDG_DATA_HOME: dataHome });

    expect(
      await main(
        ["healthy"],
        defaultPlugins,
        new CommandRegistry(),
        output.context,
      ),
    ).toBe(1);
    expect(output.stdoutText()).toBe("dispatched\n");
    expect(output.stderrText()).toBe(
      [
        'Error loading plugin marketplace/installed/delta: Marketplace "delta" failed: tx.marketplace.json must contain a plugins array. Run "tx marketplace remove delta" to remove it.',
        'Error loading plugin marketplace/installed/beta/broken: Marketplace "beta" plugin "broken" failed: Plugin broken must default-export a function. Run "tx marketplace remove beta" to remove it.',
        'Error loading plugin marketplace/installed/gamma/throwing: Marketplace "gamma" plugin "throwing" failed: plain failure. Run "tx marketplace remove gamma" to remove it.',
        "",
      ].join("\n"),
    );
  } finally {
    await rm(dataHome, { recursive: true, force: true });
  }
});

test("first-party commands survive later external collisions", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "tx-cli-collision-"));
  const checkout = join(dataHome, "tx", "marketplaces", "personal");
  try {
    await mkdir(checkout, { recursive: true });
    await writeFile(
      join(checkout, "collision.test.ts"),
      'export default ({ command }) => command("marketplace list", () => {});\n',
    );
    await writeFile(
      join(checkout, "tx.marketplace.json"),
      '{"plugins":[{"name":"collision","entry":"collision.test.ts"}]}',
    );
    const output = capturedContext({ XDG_DATA_HOME: dataHome });

    expect(
      await main(
        ["marketplace", "--help"],
        defaultPlugins,
        new CommandRegistry(),
        output.context,
      ),
    ).toBe(1);
    expect(output.stdoutText()).toContain("  list\n");
    expect(output.stderrText()).toContain(
      'Error loading plugin marketplace/installed/personal/collision: Command "marketplace list" is already registered by marketplace',
    );
  } finally {
    await rm(dataHome, { recursive: true, force: true });
  }
});

test("the default process context reflects the current process", () => {
  const context = createProcessContext();

  expect(context.cwd).toBe(process.cwd());
  expect(context.env).toBe(process.env);
  expect(context.stdin).toBe(process.stdin);
  expect(context.stdout).toBe(process.stdout);
  expect(context.stderr).toBe(process.stderr);
});

test("importing the CLI does not invoke main", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      'Bun.argv.slice = () => { throw new Error("main invoked during import"); }; await import("./cli.ts");',
    ],
    {
      cwd: `${import.meta.dir}/..`,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
});

test("the CLI entrypoint retains import.meta.main wiring", () => {
  const result = Bun.spawnSync([process.execPath, "run", "cli.ts", "--help"], {
    cwd: `${import.meta.dir}/..`,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(
    "Usage: tx <command>\n\nCommands:\n  marketplace\n",
  );
  expect(result.stderr.toString()).toBe("");
});

test("the CLI entrypoint exposes usage failures as process exit codes", () => {
  const result = Bun.spawnSync([process.execPath, "run", "cli.ts", "unknown"], {
    cwd: `${import.meta.dir}/..`,
  });

  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe(
    'Error: Unknown command "unknown". Run "tx --help" for usage.\n',
  );
});
