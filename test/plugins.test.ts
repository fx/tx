import { describe, expect, test } from "bun:test";
import * as ink from "ink";
import * as react from "react";
import packageMetadata from "../package.json" with { type: "json" };

import { CommandRegistry, dispatch } from "../src/commands.ts";
import type { CommandProcessContext } from "../src/context.ts";
import type { Plugin, PluginAPI } from "../src/plugin.ts";
import {
  coreDependencies,
  initializePlugin,
  type PluginSource,
} from "../src/plugins.ts";

const coreOwner = { marketplace: "core", plugin: "marketplace" };
const personalOwner = { marketplace: "personal", plugin: "notes" };

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

function invalidSource(defaultExport: unknown): PluginSource {
  return { default: defaultExport } as PluginSource;
}

describe("public plugin contract", () => {
  test("is available from the stable package export", async () => {
    expect(Object.keys(await import("tx/plugin"))).toEqual([]);
  });

  test("injects shared module identities and canonical package versions", () => {
    expect(coreDependencies.react).toBe(react);
    expect(coreDependencies.ink).toBe(ink);
    expect(coreDependencies.tx.version).toBe(packageMetadata.version);
    expect(coreDependencies.versions).toEqual({
      react: packageMetadata.dependencies.react,
      ink: packageMetadata.dependencies.ink,
    });
    expect(packageMetadata.dependencies["@types/react"]).toBe("19.2.18");
    expect(packageMetadata.dependencies["@types/node"]).toBe("26.1.2");
    expect(Object.isFrozen(coreDependencies)).toBe(true);
    expect(Object.isFrozen(coreDependencies.tx)).toBe(true);
    expect(Object.isFrozen(coreDependencies.versions)).toBe(true);
  });
});

describe("initializePlugin", () => {
  test("uses one scoped API for a statically supplied synchronous plugin", async () => {
    const registry = new CommandRegistry();
    let receivedAPI: PluginAPI | undefined;
    const plugin: Plugin = (api) => {
      receivedAPI = api;
      api.command(["marketplace", "list"], (_args, context) => {
        context.stdout.write(`${context.marketplace}/${context.plugin}`);
      });
    };

    await initializePlugin(registry, coreOwner, plugin);

    expect(receivedAPI?.dependencies).toBe(coreDependencies);
    expect(Object.isFrozen(receivedAPI)).toBe(true);
    const context = outputContext();
    const result = await dispatch(registry, ["marketplace", "list"], context);
    expect(result.command?.path).toEqual(["marketplace", "list"]);
    expect(result.command?.owner).toEqual(coreOwner);
    expect(context.stdoutText()).toBe("core/marketplace");
  });

  test("awaits a dynamically supplied asynchronous default export", async () => {
    const registry = new CommandRegistry();
    const owner = { ...personalOwner };
    let initialized = false;
    const loading = initializePlugin(registry, owner, {
      default: (async ({ command }) => {
        await Promise.resolve();
        initialized = true;
        command("notes open", () => {});
      }) satisfies Plugin,
    });
    owner.marketplace = "changed";
    owner.plugin = "changed";

    await loading;

    expect(initialized).toBe(true);
    expect(registry.resolve(["notes", "open"])?.owner).toEqual(personalOwner);
  });

  test.each([
    ["missing", {}],
    ["undefined", { default: undefined }],
    ["non-function", invalidSource("not a function")],
  ])("rejects a %s default export with its owner", async (_label, source) => {
    const registry = new CommandRegistry();

    await expect(
      initializePlugin(registry, personalOwner, source),
    ).rejects.toThrow("Plugin personal/notes must default-export a function");
    expect(registry.help()).toBe("Usage: tx <command>\n");
  });

  test.each([
    [
      "throws",
      (({ command }) => {
        command("ghost sync", () => {});
        throw new Error("sync initialization failed");
      }) satisfies Plugin,
    ],
    [
      "rejects",
      (async ({ command }) => {
        command("ghost async", () => {});
        await Promise.resolve();
        throw new Error("async initialization failed");
      }) satisfies Plugin,
    ],
  ])(
    "leaves no commands or ghost nodes when initialization %s",
    async (_label, plugin) => {
      const registry = new CommandRegistry();

      await expect(
        initializePlugin(registry, personalOwner, plugin),
      ).rejects.toThrow(/initialization failed/);
      expect(registry.resolve(["ghost", "sync"])).toBeUndefined();
      expect(registry.resolve(["ghost", "async"])).toBeUndefined();
      expect(registry.help(["ghost"])).toBeUndefined();
      expect(registry.help()).toBe("Usage: tx <command>\n");
    },
  );

  test("rolls back the whole plugin on an invalid path", async () => {
    const registry = new CommandRegistry();
    const plugin: Plugin = ({ command }) => {
      command("ghost valid", () => {});
      command(["ghost", "   "], () => {});
    };

    await expect(
      initializePlugin(registry, personalOwner, plugin),
    ).rejects.toThrow(
      "Command path must contain one or more non-empty segments",
    );
    expect(registry.resolve(["ghost", "valid"])).toBeUndefined();
    expect(registry.help(["ghost"])).toBeUndefined();
  });

  test("rolls back the whole plugin on an intra-batch collision", async () => {
    const registry = new CommandRegistry();
    const plugin: Plugin = ({ command }) => {
      command("ghost other", () => {});
      command("duplicate", () => {});
      command(["duplicate"], () => {});
    };

    await expect(
      initializePlugin(registry, personalOwner, plugin),
    ).rejects.toThrow(
      'Command "duplicate" is already registered by personal/notes; cannot register it for personal/notes',
    );
    expect(registry.resolve(["duplicate"])).toBeUndefined();
    expect(registry.help(["ghost"])).toBeUndefined();
  });

  test("keeps earlier plugins while rejecting a later collision atomically", async () => {
    const registry = new CommandRegistry();
    await initializePlugin(registry, coreOwner, ({ command }) => {
      command("marketplace add", () => {});
    });

    const plugin: Plugin = ({ command }) => {
      command("ghost current", () => {});
      command(["marketplace", "add"], () => {});
    };
    await expect(
      initializePlugin(registry, personalOwner, plugin),
    ).rejects.toThrow(
      'Command "marketplace add" is already registered by core/marketplace; cannot register it for personal/notes',
    );

    expect(registry.resolve(["marketplace", "add"])?.owner).toEqual(coreOwner);
    expect(registry.resolve(["ghost", "current"])).toBeUndefined();
    expect(registry.help(["ghost"])).toBeUndefined();
    expect(registry.help()).toContain("  marketplace\n");
  });

  test("closes registration after initialization for retained API references", async () => {
    const registry = new CommandRegistry();
    let retainedAPI: PluginAPI | undefined;
    await initializePlugin(registry, personalOwner, (api) => {
      retainedAPI = api;
      api.command("notes current", () => {});
    });

    expect(() => retainedAPI?.command("notes late", () => {})).toThrow(
      "Plugin personal/notes cannot register commands after initialization",
    );
    expect(registry.resolve(["notes", "current"])).toBeDefined();
    expect(registry.resolve(["notes", "late"])).toBeUndefined();
  });

  test("accepts a plugin that registers no commands", async () => {
    const registry = new CommandRegistry();

    await initializePlugin(registry, personalOwner, () => {});

    expect(registry.help()).toBe("Usage: tx <command>\n");
  });
});
