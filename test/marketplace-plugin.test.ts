import { describe, expect, test } from "bun:test";
import { CommandRegistry, dispatch } from "../src/commands.ts";
import type { CommandProcessContext } from "../src/context.ts";
import {
  createMarketplacePlugin,
  type MarketplaceOperations,
} from "../src/first-party/marketplace.ts";
import { initializePlugin } from "../src/plugins.ts";

class RecordingManager implements MarketplaceOperations {
  readonly calls: unknown[][] = [];
  listings = [
    { name: "alpha", source: "ssh://example/alpha.git" },
    { name: "broken", source: "<unknown>" },
  ];

  async add(repository: string, name?: string): Promise<string> {
    this.calls.push(["add", repository, name]);
    return name ?? "derived";
  }

  async list() {
    this.calls.push(["list"]);
    return this.listings;
  }

  async remove(name: string): Promise<void> {
    this.calls.push(["remove", name]);
  }
}

function outputContext(): CommandProcessContext & {
  stdoutText(): string;
  stderrText(): string;
} {
  let stdout = "";
  let stderr = "";
  return {
    cwd: "/work",
    env: {},
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

async function setup(manager = new RecordingManager()) {
  const registry = new CommandRegistry();
  await initializePlugin(
    registry,
    { marketplace: "core", plugin: "marketplace" },
    createMarketplacePlugin({ manager }),
  );
  return { manager, registry };
}

describe("first-party marketplace plugin", () => {
  test("registers all commands through the normal scoped plugin API", async () => {
    const { registry } = await setup();

    for (const command of ["add", "list", "remove"]) {
      expect(registry.resolve(["marketplace", command])?.owner).toEqual({
        marketplace: "core",
        plugin: "marketplace",
      });
    }
    expect(registry.help()).toBe(
      "Usage: tx <command>\n\nCommands:\n  marketplace\n",
    );
    expect(registry.help(["marketplace"])).toBe(
      "Usage: tx marketplace <command>\n\nCommands:\n  add\n  list\n  remove\n",
    );
  });

  test("adds with strict parsing and reports the installed name", async () => {
    const { manager, registry } = await setup();
    const context = outputContext();

    expect(
      await dispatch(
        registry,
        ["marketplace", "add", "repository", "--name", "personal"],
        context,
      ),
    ).toMatchObject({ exitCode: 0 });
    expect(manager.calls).toEqual([["add", "repository", "personal"]]);
    expect(context.stdoutText()).toBe('Added marketplace "personal".\n');
    expect(context.stderrText()).toBe("");
  });

  test("lists sorted manager results including unknown sources", async () => {
    const { manager, registry } = await setup();
    const context = outputContext();

    expect(
      await dispatch(registry, ["marketplace", "list"], context),
    ).toMatchObject({ exitCode: 0 });
    expect(manager.calls).toEqual([["list"]]);
    expect(context.stdoutText()).toBe(
      "alpha\tssh://example/alpha.git\nbroken\t<unknown>\n",
    );
  });

  test("removes through the manager and reports success", async () => {
    const { manager, registry } = await setup();
    const context = outputContext();

    expect(
      await dispatch(registry, ["marketplace", "remove", "personal"], context),
    ).toMatchObject({ exitCode: 0 });
    expect(manager.calls).toEqual([["remove", "personal"]]);
    expect(context.stdoutText()).toBe('Removed marketplace "personal".\n');
  });

  test.each([
    ["add", []],
    ["list", ["extra"]],
    ["remove", []],
  ])("reports strict %s usage errors", async (command, args) => {
    const { manager, registry } = await setup();
    const context = outputContext();

    expect(
      await dispatch(registry, ["marketplace", command, ...args], context),
    ).toMatchObject({ exitCode: 1 });
    expect(manager.calls).toEqual([]);
    expect(context.stdoutText()).toBe("");
    expect(context.stderrText()).toStartWith("Error: Usage:");
  });

  test("constructs its production manager when no manager is injected", () => {
    expect(
      createMarketplacePlugin({
        userData: { platform: "linux", env: {}, home: "/home/test" },
      }),
    ).toBeFunction();
  });
});
