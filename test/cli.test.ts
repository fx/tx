import { expect, test } from "bun:test";
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

test("main returns the dispatcher exit code with injected process wiring", async () => {
  const registry = new CommandRegistry();
  registry.register("fail", { marketplace: "core", plugin: "test" }, () => {
    throw new Error("failed");
  });

  expect(await main(["fail"], registry, quietContext())).toBe(1);
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

  expect(await main(["marketplace", "--help"], undefined, context)).toBe(0);
  expect(stdout).toBe(
    "Usage: tx marketplace <command>\n\nCommands:\n  add\n  list\n  remove\n",
  );

  stdout = "";
  expect(await main([], new CommandRegistry(), context)).toBe(0);
  expect(stdout).toBe("Usage: tx <command>\n");
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
      'Bun.argv.slice = () => { throw new Error("main invoked during import"); }; await import("./src/cli.ts");',
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
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "--help"],
    {
      cwd: `${import.meta.dir}/..`,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(
    "Usage: tx <command>\n\nCommands:\n  marketplace\n",
  );
  expect(result.stderr.toString()).toBe("");
});

test("the CLI entrypoint exposes usage failures as process exit codes", () => {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "unknown"],
    { cwd: `${import.meta.dir}/..` },
  );

  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe(
    'Error: Unknown command "unknown". Run "tx --help" for usage.\n',
  );
});
