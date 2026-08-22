import { describe, expect, test } from "bun:test";
import * as ink from "ink";
import * as react from "react";
import packageMetadata from "../package.json" with { type: "json" };

import {
  createRootProgram,
  dispatch,
  EXIT_SUCCESS,
  identityName,
} from "../src/commands.ts";
import type {
  CoreDependencies,
  Plugin,
  PluginAPI,
  PluginDefinition,
  PluginIdentity,
  UpdateParticipant,
  UpdateParticipation,
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

/** A participant the host is only ever expected to store and hand back. */
function stubParticipant(): UpdateParticipant {
  return {
    gather: () => [],
    apply: () => ({ applied: false }),
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

  test("closes command, child, registry, and participant contribution after initialization", async () => {
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
    expect(() => retainedAPI?.register("late", {})).toThrow(
      "Plugin retained cannot register values after initialization",
    );
    expect(() => retainedAPI?.update(stubParticipant())).toThrow(
      "Plugin retained cannot contribute update participants after initialization",
    );
    expect(retainedAPI?.updaters()).toEqual([]);
  });

  test("supports empty defaults", async () => {
    expect(await initializePlugins()).toEqual({
      namespaces: [],
      failures: [],
    });
  });
});

describe("generic registry", () => {
  test("commits opaque repeated values in root, call, and child FIFO order", async () => {
    let calls = 0;
    const opaque = () => {
      calls += 1;
    };
    const repeated = { kind: "repeated" };
    const beta = { kind: "beta" };
    const child = { kind: "child" };
    let reader: PluginAPI | undefined;

    const { namespaces, failures } = await initializePlugins([
      definition("alpha", (api) => {
        api.register("capability", opaque);
        api.register("capability", repeated);
        api.register("capability", repeated);
        api.register(" Capability ", "spaced");
        api.register("Capability", "capitalized");
        api.register("", "empty");
        api.plugin(
          definition(
            "alpha-child",
            ({ register }) => register("capability", child),
            api.identity,
          ),
        );
      }),
      definition("beta", (api) => {
        api.register("capability", beta);
        reader = api;
      }),
    ]);

    expect(failures).toEqual([]);
    expect(namespaces).toEqual([]);
    const first = reader?.registrations("capability") ?? [];
    const second = reader?.registrations("capability") ?? [];
    expect(first).toEqual([opaque, repeated, repeated, beta, child]);
    expect(first[0]).toBe(opaque);
    expect(first[1]).toBe(repeated);
    expect(first[2]).toBe(repeated);
    expect(calls).toBe(0);
    expect(Object.isFrozen(opaque)).toBe(false);
    expect(Object.isFrozen(repeated)).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(reader?.registrations(" Capability ")).toEqual(["spaced"]);
    expect(reader?.registrations("Capability")).toEqual(["capitalized"]);
    expect(reader?.registrations("")).toEqual(["empty"]);
    expect(reader?.registrations("capability ")).toEqual([]);
    const absent = reader?.registrations("absent") ?? [];
    expect(absent).toEqual([]);
    expect(Object.isFrozen(absent)).toBe(true);
    expect(reader?.registrations("absent")).not.toBe(absent);
  });

  test("reads committed snapshots at initialization and command call time", async () => {
    const early = { provider: "early" };
    const own = { provider: "consumer" };
    const late = { provider: "late" };
    let duringInitialization: readonly unknown[] = [];
    let duringCommand: readonly unknown[] = [];

    const { namespaces, failures } = await initializePlugins([
      definition("early", ({ register }) => register("timing", early)),
      definition("consumer", ({ command, register, registrations }) => {
        register("timing", own);
        duringInitialization = registrations("timing");
        command((namespace) =>
          namespace.action(() => {
            duringCommand = registrations("timing");
          }),
        );
      }),
      definition("late", ({ register }) => register("timing", late)),
    ]);

    expect(failures).toEqual([]);
    expect(duringInitialization).toEqual([early]);
    expect(Object.isFrozen(duringInitialization)).toBe(true);
    expect(
      await dispatch(
        createRootProgram(coreDependencies, namespaces),
        ["consumer"],
        captureContext(),
      ),
    ).toEqual({ exitCode: EXIT_SUCCESS });
    expect(duringInitialization).toEqual([early]);
    expect(duringCommand).toEqual([early, own, late]);
    expect(Object.isFrozen(duringCommand)).toBe(true);
  });

  test("discards entries with every other staged contribution on all failures", async () => {
    let childLoaded = false;
    let reader: PluginAPI | undefined;
    const accepted = { accepted: true };

    const { namespaces, failures } = await initializePlugins([
      definition(
        "broken",
        ({ command, plugin, register, update, identity }) => {
          command(() => {});
          plugin({
            identity: { name: "ghost", parent: identity },
            load: () => {
              childLoaded = true;
              return () => {};
            },
          });
          register("atomic", { broken: true });
          update(stubParticipant());
          throw new Error("initialization failed");
        },
      ),
      definition("notes", ({ command, register }) => {
        command(() => {});
        register("atomic", accepted);
      }),
      definition("notes", ({ command, register }) => {
        command(() => {});
        register("atomic", { collision: true });
      }),
      definition("renamed", ({ command, register }) => {
        register("atomic", { renamed: true });
        command((namespace) => namespace.name("other"));
      }),
      definition("reader", (api) => {
        reader = api;
      }),
    ]);

    expect(failures.map(({ identity }) => identity.name)).toEqual([
      "broken",
      "notes",
      "renamed",
    ]);
    expect(namespaceNames(namespaces)).toEqual(["notes"]);
    expect(childLoaded).toBe(false);
    expect(reader?.registrations("atomic")).toEqual([accepted]);
    expect(reader?.updaters()).toEqual([]);
  });
});

describe("update participation", () => {
  test("commits participants in FIFO order, frozen with their owner's identity", async () => {
    const first = stubParticipant();
    const second = stubParticipant();
    const child = stubParticipant();
    const late = stubParticipant();
    let reader: PluginAPI | undefined;

    const { namespaces, failures } = await initializePlugins([
      definition("alpha", (api) => {
        api.update(first);
        api.update(second);
        api.plugin(
          definition(
            "alpha-child",
            ({ update }) => update(child),
            api.identity,
          ),
        );
      }),
      definition("beta", (api) => {
        api.update(late);
        reader = api;
      }),
    ]);

    expect(failures).toEqual([]);
    expect(namespaces).toEqual([]);
    const committed = reader?.updaters() ?? [];
    expect(committed.map(({ participant }) => participant)).toEqual([
      first,
      second,
      late,
      child,
    ]);
    expect(committed.map(({ identity }) => identityName(identity))).toEqual([
      "alpha",
      "alpha",
      "beta",
      "alpha/alpha-child",
    ]);
    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed[0])).toBe(true);
  });

  test("reads only what was committed before the reading plugin", async () => {
    const early = stubParticipant();
    let duringInitialization: readonly UpdateParticipation[] = [];
    let reader: PluginAPI | undefined;

    const { failures } = await initializePlugins([
      definition("early", ({ update }) => update(early)),
      definition("middle", (api) => {
        api.update(stubParticipant());
        duringInitialization = api.updaters();
      }),
      definition("late", (api) => {
        api.update(stubParticipant());
        reader = api;
      }),
    ]);

    expect(failures).toEqual([]);
    // Its own contribution is still staged, later plugins have not run, and
    // the snapshot it took is not a live view of what was committed after it.
    expect(duringInitialization.map((entry) => entry.participant)).toEqual([
      early,
    ]);
    expect(reader?.updaters()).toHaveLength(3);
  });

  test("discards participants staged by a plugin that fails", async () => {
    let reader: PluginAPI | undefined;
    const healthy = stubParticipant();

    const { namespaces, failures } = await initializePlugins([
      definition("broken", ({ command, update }) => {
        command((namespace) => namespace.command("ghost"));
        update(stubParticipant());
        throw new Error("initialization failed");
      }),
      definition("healthy", (api) => {
        api.update(healthy);
        reader = api;
      }),
    ]);

    expect(failures).toEqual([
      { identity: { name: "broken" }, message: "initialization failed" },
    ]);
    expect(namespaces).toEqual([]);
    expect(reader?.updaters().map((entry) => entry.participant)).toEqual([
      healthy,
    ]);
  });

  test("discards participants staged by a plugin whose namespace collides", async () => {
    let reader: PluginAPI | undefined;

    const { failures } = await initializePlugins([
      definition("notes", ({ command }) => command(() => {})),
      definition("notes", ({ command, update }) => {
        command(() => {});
        update(stubParticipant());
      }),
      definition("reader", (api) => {
        reader = api;
      }),
    ]);

    expect(failures).toHaveLength(1);
    expect(reader?.updaters()).toEqual([]);
  });
});
