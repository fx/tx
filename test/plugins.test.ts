import { describe, expect, test } from "bun:test";
import * as ink from "ink";
import * as react from "react";
import packageMetadata from "../package.json" with { type: "json" };

import { createRootProgram, dispatch, EXIT_SUCCESS } from "../src/commands.ts";
import type {
  CoreDependencies,
  Plugin,
  PluginAPI,
  PluginDefinition,
  PluginIdentity,
} from "../src/plugin.ts";
import { coreDependencies, initializePlugins } from "../src/plugins.ts";
import { captureContext } from "./helpers.ts";

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

function namespaceNames(
  namespaces: readonly { readonly command: { name(): string } }[],
): string[] {
  return namespaces.map((namespace) => namespace.command.name());
}

describe("public plugin contract", () => {
  test("cannot be imported at runtime", async () => {
    await expect(import("@fx/tx/plugin")).rejects.toThrow();
  });

  test("injects shared frozen dependencies for the type-only contract", async () => {
    expect(coreDependencies.react).toBe(react);
    expect(coreDependencies.ink).toBe(ink);
    expect(coreDependencies.commander).toBe(await import("commander"));
    expect(coreDependencies.tx.version).toBe(packageMetadata.version);
    expect(coreDependencies.versions).toEqual({
      react: packageMetadata.dependencies.react,
      ink: packageMetadata.dependencies.ink,
      commander: packageMetadata.dependencies.commander,
    });
    expect(Object.isFrozen(coreDependencies)).toBe(true);
    expect(Object.isFrozen(coreDependencies.tx)).toBe(true);
    expect(Object.isFrozen(coreDependencies.versions)).toBe(true);
    expect("marketplace" in coreDependencies).toBe(false);
  });
});

describe("initializePlugins", () => {
  test("initializes roots and committed children in deterministic FIFO order", async () => {
    const order: string[] = [];
    const child = (name: string, parent: PluginIdentity): PluginDefinition => ({
      identity: { name, parent },
      load: async () => {
        order.push(`load:${name}`);
        return ({ command }) => {
          order.push(`init:${name}`);
          command((namespace) => namespace.description(name));
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

    const { namespaces, failures } = await initializePlugins([alpha, beta]);

    expect(failures).toEqual([]);
    expect(order).toEqual([
      "init:alpha",
      "init:beta",
      "load:alpha-child",
      "init:alpha-child",
      "load:beta-child",
      "init:beta-child",
    ]);
    expect(namespaceNames(namespaces)).toEqual(["alpha-child", "beta-child"]);
    expect(namespaces[0]?.identity).toEqual({
      name: "alpha-child",
      parent: { name: "alpha" },
    });
  });

  test("names each namespace after the plugin's own identity, not its parents", async () => {
    const { namespaces, failures } = await initializePlugins([
      definition("journal", ({ command }) => command(() => {}), {
        name: "personal",
        parent: { name: "marketplace" },
      }),
    ]);

    expect(failures).toEqual([]);
    expect(namespaceNames(namespaces)).toEqual(["journal"]);
    expect(namespaces[0]?.identity).toEqual({
      name: "journal",
      parent: { name: "personal", parent: { name: "marketplace" } },
    });
    expect(Object.isFrozen(namespaces[0])).toBe(true);
  });

  test("claims no namespace for a plugin that defines no commands", async () => {
    const { namespaces, failures } = await initializePlugins([
      definition("quiet", () => {}),
    ]);

    expect(failures).toEqual([]);
    expect(namespaces).toEqual([]);
  });

  test("exposes immutable identity, env, dependencies, and generic command context", async () => {
    const env = { TEST_VALUE: "yes" };
    const context = captureContext(env);
    const customDependencies = { ...coreDependencies } as CoreDependencies;
    let retainedAPI: PluginAPI | undefined;
    const identity = { name: "leaf", parent: { name: "root" } };

    const { namespaces, failures } = await initializePlugins(
      [
        definition(
          "leaf",
          (api) => {
            retainedAPI = api;
            api.command((namespace) =>
              namespace.action(() => {
                api.context.stdout.write(
                  `${api.context.plugin.parent?.name}/${api.context.plugin.name} in ${api.context.cwd}\n`,
                );
              }),
            );
          },
          identity.parent,
        ),
      ],
      { env, context, dependencies: customDependencies },
    );

    expect(failures).toEqual([]);
    expect(retainedAPI?.env).toBe(env);
    expect(retainedAPI?.dependencies).toBe(customDependencies);
    expect(retainedAPI?.identity).toEqual(identity);
    expect(retainedAPI?.context.plugin).toBe(retainedAPI?.identity);
    expect(retainedAPI?.context.stdout).toBe(context.stdout);
    expect(retainedAPI?.context.stderr).toBe(context.stderr);
    expect(retainedAPI?.context.stdin).toBe(context.stdin);
    expect(retainedAPI?.context.env).toBe(env);
    expect(Object.isFrozen(retainedAPI)).toBe(true);
    expect(Object.isFrozen(retainedAPI?.identity)).toBe(true);
    expect(Object.isFrozen(retainedAPI?.identity.parent)).toBe(true);

    expect(
      await dispatch(
        createRootProgram(coreDependencies, namespaces),
        ["leaf"],
        context,
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(context.stdoutText()).toBe("root/leaf in /work\n");
    expect(context.stderrText()).toBe("");
  });

  test("falls back to the current process context and its environment", async () => {
    let retainedAPI: PluginAPI | undefined;

    const { failures } = await initializePlugins([
      definition("ambient", (api) => {
        retainedAPI = api;
      }),
    ]);

    expect(failures).toEqual([]);
    expect(retainedAPI?.env).toBe(process.env);
    expect(retainedAPI?.context.env).toBe(process.env);
    expect(retainedAPI?.context.cwd).toBe(process.cwd());
    expect(retainedAPI?.context.stdout).toBe(process.stdout);
    expect(retainedAPI?.dependencies).toBe(coreDependencies);
  });

  test("gives the command context the injected environment", async () => {
    const env = { TX_INJECTED: "yes" };
    let retainedAPI: PluginAPI | undefined;

    const { failures } = await initializePlugins(
      [
        definition("ambient", (api) => {
          retainedAPI = api;
        }),
      ],
      { env },
    );

    expect(failures).toEqual([]);
    expect(retainedAPI?.env).toBe(env);
    expect(retainedAPI?.context.env).toBe(env);
    expect(retainedAPI?.context.cwd).toBe(process.cwd());
  });

  test("accumulates repeated registration calls onto one namespace", async () => {
    const { namespaces, failures } = await initializePlugins([
      definition("notes", ({ command }) => {
        command((namespace) => {
          namespace.description("Take notes");
          namespace.command("daily");
        });
        command((namespace) => namespace.command("weekly"));
      }),
    ]);

    expect(failures).toEqual([]);
    expect(namespaces).toHaveLength(1);
    expect(namespaces[0]?.command.description()).toBe("Take notes");
    expect(
      namespaces[0]?.command.commands.map((child) => child.name()),
    ).toEqual(["daily", "weekly"]);
  });

  test("rejects a builder that returns a thenable instead of letting its work land late", async () => {
    let landed = false;

    const { namespaces, failures } = await initializePlugins([
      definition("late", ({ command }) => {
        command(async (namespace) => {
          await Promise.resolve();
          namespace.command("ghost");
          landed = true;
        });
      }),
    ]);

    expect(
      failures.map(({ identity, message }) => [identity.name, message]),
    ).toEqual([
      [
        "late",
        "Plugin late must build its namespace synchronously; the builder returned a promise",
      ],
    ]);
    expect(namespaces).toEqual([]);

    await Promise.resolve();
    expect(landed).toBe(true);
  });

  test("rejects an unusable namespace name even when the plugin swallows the error", async () => {
    let childLoaded = false;

    const { namespaces, failures } = await initializePlugins([
      definition("two words", ({ command, plugin, identity }) => {
        try {
          command(() => {});
        } catch {
          // A plugin cannot catch its way past a registration violation.
        }
        plugin({
          identity: { name: "ghost-child", parent: identity },
          load: () => {
            childLoaded = true;
            return () => {};
          },
        });
      }),
    ]);

    expect(failures.map((failure) => failure.message)).toEqual([
      'Plugin two words cannot claim namespace "two words"; a namespace name must not be empty, contain whitespace, or begin with "-"',
    ]);
    expect(namespaces).toEqual([]);
    expect(childLoaded).toBe(false);
  });

  test("rejects a thenable builder even when the plugin swallows the error", async () => {
    const { namespaces, failures } = await initializePlugins([
      definition("swallowing", ({ command }) => {
        try {
          command(async (namespace) => {
            namespace.command("staged-before-await");
            await Promise.resolve();
          });
        } catch {
          // A plugin cannot catch its way past a registration violation.
        }
      }),
    ]);

    expect(
      failures.map(({ identity, message }) => [identity.name, message]),
    ).toEqual([
      [
        "swallowing",
        "Plugin swallowing must build its namespace synchronously; the builder returned a promise",
      ],
    ]);
    expect(namespaces).toEqual([]);
  });

  test("keeps a rejected builder's promise from faulting the host", async () => {
    const { namespaces, failures } = await initializePlugins([
      definition("rejecting", ({ command }) => {
        command(async () => {
          await Promise.resolve();
          throw new Error("builder rejected after the host moved on");
        });
      }),
      definition("healthy", ({ command }) => command(() => {})),
    ]);

    expect(failures.map((failure) => failure.identity.name)).toEqual([
      "rejecting",
    ]);
    expect(namespaceNames(namespaces)).toEqual(["healthy"]);

    // Flush the builder's own rejection; an unobserved one would fault the
    // process rather than staying isolated to the plugin that caused it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test.each([
    [
      "renames its namespace",
      (namespace: { name(name: string): unknown }) => namespace.name("other"),
      'Plugin notes renamed its namespace to "other"; a namespace must stay reachable as "notes"',
    ],
    [
      "aliases its namespace",
      (namespace: { alias(alias: string): unknown }) => namespace.alias("n"),
      'Plugin notes aliased its namespace as "n"; a namespace must stay reachable only as "notes"',
    ],
  ])("fails a plugin that %s", async (_label, mutate, message) => {
    const { namespaces, failures } = await initializePlugins([
      definition("notes", ({ command }) =>
        command((namespace) => {
          namespace.command("daily");
          mutate(namespace);
        }),
      ),
    ]);

    expect(failures.map((failure) => failure.message)).toEqual([message]);
    expect(namespaces).toEqual([]);
  });

  test.each(["two words", "trailing ", "-flag", "-"])(
    "rejects the namespace name %p without reshaping it",
    async (name) => {
      const { namespaces, failures } = await initializePlugins([
        definition(name, ({ command }) => command(() => {})),
      ]);

      expect(namespaces).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.message).toBe(
        `Plugin ${name} cannot claim namespace "${name}"; a namespace name must not be empty, contain whitespace, or begin with "-"`,
      );
    },
  );

  test("rejects a second plugin claiming a committed namespace", async () => {
    const { namespaces, failures } = await initializePlugins([
      definition("notes", ({ command }) => command(() => {}), {
        name: "first",
      }),
      definition("notes", ({ command }) => command(() => {}), {
        name: "second",
      }),
    ]);

    expect(namespaceNames(namespaces)).toEqual(["notes"]);
    expect(namespaces[0]?.identity.parent).toEqual({ name: "first" });
    expect(
      failures.map(({ identity, message }) => [identity.name, message]),
    ).toEqual([
      [
        "notes",
        'Namespace "notes" is already claimed by first/notes; cannot claim it for second/notes',
      ],
    ]);
  });

  test("atomically discards the namespace and children after an initialization failure", async () => {
    let childLoaded = false;

    const { namespaces, failures } = await initializePlugins([
      definition("broken", ({ command, plugin, identity }) => {
        command((namespace) => namespace.command("ghost"));
        plugin({
          identity: { name: "ghost-child", parent: identity },
          load: () => {
            childLoaded = true;
            return () => {};
          },
        });
        throw new Error("initialization failed");
      }),
      definition("healthy", ({ command }) => command(() => {})),
    ]);

    expect(failures).toEqual([
      { identity: { name: "broken" }, message: "initialization failed" },
    ]);
    expect(childLoaded).toBe(false);
    expect(namespaceNames(namespaces)).toEqual(["healthy"]);
  });

  test("isolates load, shape, and identity failures", async () => {
    const { namespaces, failures } = await initializePlugins([
      definition("first", ({ command }) => command(() => {})),
      {
        identity: { name: "throwing" },
        load: async () => {
          throw "load failed";
        },
      },
      { identity: { name: "shape" }, load: () => 42 as unknown as Plugin },
      { identity: { name: " " }, load: () => () => {} },
      definition("last", ({ command }) => command(() => {})),
    ]);

    expect(
      failures.map(({ identity, message }) => [identity.name, message]),
    ).toEqual([
      ["throwing", "load failed"],
      ["shape", "Plugin definition must load a function"],
      ["<invalid>", "Plugin identity name must not be empty"],
    ]);
    expect(namespaceNames(namespaces)).toEqual(["first", "last"]);
  });

  test("closes command and child contribution after initialization", async () => {
    let retainedAPI: PluginAPI | undefined;

    const { failures } = await initializePlugins([
      definition("retained", (api) => {
        retainedAPI = api;
        api.command((namespace) => namespace.command("current"));
      }),
    ]);

    expect(failures).toEqual([]);
    expect(() => retainedAPI?.command(() => {})).toThrow(
      "Plugin retained cannot register commands after initialization",
    );
    expect(() => retainedAPI?.plugin(definition("late", () => {}))).toThrow(
      "Plugin retained cannot contribute plugins after initialization",
    );
  });

  test("supports empty defaults", async () => {
    expect(await initializePlugins()).toEqual({
      namespaces: [],
      failures: [],
    });
  });
});
