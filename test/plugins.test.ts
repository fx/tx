import { describe, expect, test } from "bun:test";
import * as ink from "ink";
import * as react from "react";
import packageMetadata from "../package.json" with { type: "json" };

import { CommandRegistry, dispatch } from "../src/commands.ts";
import type { CommandProcessContext } from "../src/context.ts";
import type {
  CoreDependencies,
  Plugin,
  PluginAPI,
  PluginDefinition,
  PluginIdentity,
} from "../src/plugin.ts";
import { coreDependencies, initializePlugins } from "../src/plugins.ts";

function definition(
  name: string,
  plugin: Plugin,
  parent?: PluginIdentity,
): PluginDefinition {
  return {
    identity: parent ? { name, parent } : { name },
    load: () => plugin,
  };
}

function outputContext(): CommandProcessContext & { stdoutText(): string } {
  let stdout = "";
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
    stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    stdoutText: () => stdout,
  };
}

describe("public plugin contract", () => {
  test("injects shared frozen dependencies for the type-only contract", () => {
    expect(coreDependencies.react).toBe(react);
    expect(coreDependencies.ink).toBe(ink);
    expect(coreDependencies.tx.version).toBe(packageMetadata.version);
    expect(coreDependencies.versions).toEqual({
      react: packageMetadata.dependencies.react,
      ink: packageMetadata.dependencies.ink,
    });
    expect(Object.isFrozen(coreDependencies)).toBe(true);
    expect(Object.isFrozen(coreDependencies.tx)).toBe(true);
    expect(Object.isFrozen(coreDependencies.versions)).toBe(true);
    expect("marketplace" in coreDependencies).toBe(false);
  });
});

describe("initializePlugins", () => {
  test("initializes roots and committed children in deterministic FIFO order", async () => {
    const registry = new CommandRegistry();
    const order: string[] = [];
    const child = (name: string, parent: PluginIdentity): PluginDefinition => ({
      identity: { name, parent },
      load: async () => {
        order.push(`load:${name}`);
        return ({ command }) => {
          order.push(`init:${name}`);
          command(name, () => {});
        };
      },
    });
    const alpha: PluginDefinition = {
      identity: { name: "alpha" },
      load: () => (api) => {
        order.push("init:alpha");
        api.plugin(child("alpha-child", api.identity));
      },
    };
    const beta: PluginDefinition = {
      identity: { name: "beta" },
      load: () => (api) => {
        order.push("init:beta");
        api.plugin(child("beta-child", api.identity));
      },
    };

    expect(await initializePlugins(registry, [alpha, beta])).toEqual([]);
    expect(order).toEqual([
      "init:alpha",
      "init:beta",
      "load:alpha-child",
      "init:alpha-child",
      "load:beta-child",
      "init:beta-child",
    ]);
    expect(registry.resolve(["alpha-child"])?.owner).toEqual({
      name: "alpha-child",
      parent: { name: "alpha" },
    });
  });

  test("exposes immutable identity, env, dependencies, and generic command context", async () => {
    const registry = new CommandRegistry();
    const env = { TEST_VALUE: "yes" };
    const customDependencies = { ...coreDependencies } as CoreDependencies;
    let retainedAPI: PluginAPI | undefined;
    const identity = { name: "leaf", parent: { name: "root" } };
    const plugin: Plugin = (api) => {
      retainedAPI = api;
      api.command("inspect", (_args, context) => {
        context.stdout.write(
          `${context.plugin.parent?.name}/${context.plugin.name}`,
        );
      });
    };

    expect(
      await initializePlugins(
        registry,
        [definition("leaf", plugin, identity.parent)],
        {
          env,
          dependencies: customDependencies,
        },
      ),
    ).toEqual([]);
    expect(retainedAPI?.env).toBe(env);
    expect(retainedAPI?.dependencies).toBe(customDependencies);
    expect(retainedAPI?.identity).toEqual(identity);
    expect(Object.isFrozen(retainedAPI)).toBe(true);
    expect(Object.isFrozen(retainedAPI?.identity)).toBe(true);
    expect(Object.isFrozen(retainedAPI?.identity.parent)).toBe(true);
    const context = outputContext();
    expect(await dispatch(registry, ["inspect"], context)).toMatchObject({
      exitCode: 0,
    });
    expect(context.stdoutText()).toBe("root/leaf");
  });

  test("atomically discards commands and children after initialization failure", async () => {
    const registry = new CommandRegistry();
    let childLoaded = false;
    const failures = await initializePlugins(registry, [
      definition("broken", ({ command, plugin, identity }) => {
        command("ghost", () => {});
        plugin({
          identity: { name: "ghost-child", parent: identity },
          load: () => {
            childLoaded = true;
            return () => {};
          },
        });
        throw new Error("initialization failed");
      }),
      definition("healthy", ({ command }) => command("healthy", () => {})),
    ]);

    expect(failures).toEqual([
      { identity: { name: "broken" }, message: "initialization failed" },
    ]);
    expect(childLoaded).toBe(false);
    expect(registry.resolve(["ghost"])).toBeUndefined();
    expect(registry.resolve(["healthy"])).toBeDefined();
  });

  test("isolates load, shape, identity, and collision failures", async () => {
    const registry = new CommandRegistry();
    const failures = await initializePlugins(registry, [
      definition("first", ({ command }) => command("shared", () => {})),
      {
        identity: { name: "throwing" },
        load: async () => {
          throw "load failed";
        },
      },
      { identity: { name: "shape" }, load: () => 42 as unknown as Plugin },
      { identity: { name: " " }, load: () => () => {} },
      definition("collision", ({ command, plugin }) => {
        command("rolled-back", () => {});
        command("shared", () => {});
        plugin(definition("never", () => {}));
      }),
    ]);

    expect(
      failures.map(({ identity, message }) => [identity.name, message]),
    ).toEqual([
      ["throwing", "load failed"],
      ["shape", "Plugin definition must load a function"],
      ["<invalid>", "Plugin identity name must not be empty"],
      [
        "collision",
        'Command "shared" is already registered by first; cannot register it for collision',
      ],
    ]);
    expect(registry.resolve(["shared"])?.owner).toEqual({ name: "first" });
    expect(registry.resolve(["rolled-back"])).toBeUndefined();
  });

  test("closes command and child contribution after initialization", async () => {
    const registry = new CommandRegistry();
    let retainedAPI: PluginAPI | undefined;
    expect(
      await initializePlugins(registry, [
        definition("retained", (api) => {
          retainedAPI = api;
          api.command("current", () => {});
        }),
      ]),
    ).toEqual([]);

    expect(() => retainedAPI?.command("late", () => {})).toThrow(
      "Plugin retained cannot register commands after initialization",
    );
    expect(() => retainedAPI?.plugin(definition("late", () => {}))).toThrow(
      "Plugin retained cannot contribute plugins after initialization",
    );
  });

  test("supports empty defaults and plugins without contributions", async () => {
    const registry = new CommandRegistry();
    expect(await initializePlugins(registry)).toEqual([]);
    expect(
      await initializePlugins(registry, [definition("empty", () => {})]),
    ).toEqual([]);
    expect(registry.help()).toBe("Usage: tx <command>\n");
  });
});
