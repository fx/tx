import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import configPlugin from "../plugins/config/index.ts";
import {
  createConfigStorage,
  resolveConfigPath,
  resolveUserDataDirectory,
} from "../plugins/config/storage.ts";
import { main } from "../src/cli.ts";
import type { PluginDefinition } from "../src/plugin.ts";
import { captureContext, temporaryDirectory } from "./helpers.ts";

type ConfigValidator<T> = (value: unknown) => value is T;

type Config = {
  define<T>(key: string, isValid: ConfigValidator<T>): void;
  read<T>(key: string): Promise<T | undefined>;
  write<T>(key: string, value: T): Promise<void>;
};

const isNumber = (value: unknown): value is number => typeof value === "number";
const isString = (value: unknown): value is string => typeof value === "string";

function documentPath(dataHome: string): string {
  return join(dataHome, "tx", "config.json");
}

async function seedDocument(dataHome: string, contents: string): Promise<void> {
  const path = documentPath(dataHome);
  await mkdir(join(dataHome, "tx"), { recursive: true });
  await writeFile(path, contents);
}

async function obtainConfig(dataHome: string): Promise<Config> {
  let config: Config | undefined;
  const consumer: PluginDefinition = {
    identity: { name: "consumer" },
    load:
      () =>
      ({ command, registrations }) => {
        expect(registrations<Config>("config")).toEqual([]);
        command((namespace) =>
          namespace.action(() => {
            const registered = registrations<Config>("config");
            expect(registered).toHaveLength(1);
            config = registered[0];
          }),
        );
      },
  };
  const context = captureContext({ XDG_DATA_HOME: dataHome });

  expect(await main(["consumer"], [consumer, configPlugin], context)).toBe(0);
  expect(context.stdoutText()).toBe("");
  expect(context.stderrText()).toBe("");
  if (!config) throw new Error("The config capability was not registered");
  return config;
}

describe("config storage paths", () => {
  test("resolves every documented platform location and fallback", () => {
    expect(
      resolveConfigPath({
        platform: "linux",
        env: { XDG_DATA_HOME: "/data" },
        home: "/home/alice",
      }),
    ).toBe("/data/tx/config.json");
    expect(
      resolveConfigPath({
        platform: "freebsd",
        env: {},
        home: "/home/alice",
      }),
    ).toBe("/home/alice/.local/share/tx/config.json");
    expect(
      resolveConfigPath({
        platform: "linux",
        env: { XDG_DATA_HOME: "relative/data" },
        home: "/home/alice",
      }),
    ).toBe("/home/alice/.local/share/tx/config.json");
    expect(
      resolveConfigPath({
        platform: "darwin",
        env: { XDG_DATA_HOME: "/ignored" },
        home: "/Users/alice",
      }),
    ).toBe("/Users/alice/Library/Application Support/tx/config.json");
    expect(
      resolveConfigPath({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Local", APPDATA: "C:\\Roaming" },
        home: "C:\\Users\\alice",
      }),
    ).toBe("C:\\Local\\tx\\config.json");
    expect(
      resolveConfigPath({
        platform: "win32",
        env: { APPDATA: "C:\\Roaming" },
        home: "C:\\Users\\alice",
      }),
    ).toBe("C:\\Roaming\\tx\\config.json");
    expect(
      resolveConfigPath({
        platform: "win32",
        env: {},
        home: "C:\\Users\\alice",
      }),
    ).toBe("C:\\Users\\alice\\AppData\\Local\\tx\\config.json");
    expect(createConfigStorage().path).toBe(resolveConfigPath());
  });

  test("requires a home when the selected branch has no override", () => {
    expect(() =>
      resolveUserDataDirectory({ platform: "linux", env: {}, home: "" }),
    ).toThrow("without a home directory");
    expect(() =>
      resolveUserDataDirectory({ platform: "darwin", env: {}, home: "" }),
    ).toThrow("without a home directory");
  });
});

describe("bundled config provider", () => {
  let dataHome = "";

  beforeEach(async () => {
    dataHome = await temporaryDirectory("tx-config-");
  });

  afterEach(async () => {
    await rm(dataHome, { recursive: true, force: true });
  });

  test("registers exactly one namespace-free structural capability", async () => {
    expect(Object.isFrozen(configPlugin)).toBe(true);
    expect(Object.isFrozen(configPlugin.identity)).toBe(true);
    expect(Object.keys(await obtainConfig(dataHome))).toEqual([
      "define",
      "read",
      "write",
    ]);

    const context = captureContext({ XDG_DATA_HOME: dataHome });
    expect(await main(["--help"], [configPlugin], context)).toBe(0);
    expect(context.stdoutText()).not.toContain("config");
    expect(context.stderrText()).toBe("");
  });

  test("requires an exact definition before use without touching storage", async () => {
    const original = '{"untouched":true}\n';
    await seedDocument(dataHome, original);
    const config = await obtainConfig(dataHome);

    await expect(config.read("missing")).rejects.toThrow("defined before use");
    await expect(config.write("missing", 1)).rejects.toThrow(
      "defined before use",
    );
    expect(await readFile(documentPath(dataHome), "utf8")).toBe(original);
  });

  test("retains the original guard after rejecting a duplicate definition", async () => {
    const config = await obtainConfig(dataHome);
    config.define("shared", isString);

    expect(() => config.define("shared", isNumber)).toThrow("already defined");
    await expect(config.write("shared", 42)).rejects.toThrow("is invalid");
    await config.write("shared", "original guard");
    expect(await config.read<string>("shared")).toBe("original guard");
  });

  test("compares opaque keys exactly without reserving special strings", async () => {
    const config = await obtainConfig(dataHome);
    const entries = [
      ["", "empty"],
      [" Key ", "spaced"],
      ["key", "lowercase"],
      ["__proto__", "ordinary property"],
    ] as const;

    for (const [key, value] of entries) {
      config.define(key, isString);
      await config.write(key, value);
    }

    for (const [key, value] of entries) {
      expect(await config.read<string>(key)).toBe(value);
    }
    const persisted = JSON.parse(
      await readFile(documentPath(dataHome), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "__proto__")).toBe(true);
    expect(Reflect.get(persisted, "__proto__")).toBe("ordinary property");
  });

  test("returns undefined for an absent property and round-trips across invocations", async () => {
    const first = await obtainConfig(dataHome);
    first.define("count", isNumber);
    expect(await first.read("count")).toBeUndefined();

    await first.write("count", 7);
    expect(await first.read<number>("count")).toBe(7);

    const later = await obtainConfig(dataHome);
    later.define("count", isNumber);
    expect(await later.read<number>("count")).toBe(7);
  });

  test("creates every parent on the first write", async () => {
    const config = await obtainConfig(dataHome);
    config.define("first", isString);

    expect(await Bun.file(documentPath(dataHome)).exists()).toBe(false);
    await config.write("first", "value");
    expect(JSON.parse(await readFile(documentPath(dataHome), "utf8"))).toEqual({
      first: "value",
    });
  });

  test("rejects invalid writes without mutating the document", async () => {
    const original = '{\n  "count": 3,\n  "foreign": true\n}\n';
    await seedDocument(dataHome, original);
    const config = await obtainConfig(dataHome);
    config.define("count", isNumber);

    await expect(config.write("count", "not a number")).rejects.toThrow(
      "is invalid",
    );
    expect(await readFile(documentPath(dataHome), "utf8")).toBe(original);
  });

  test("isolates a bad key while preserving unrelated unowned properties", async () => {
    await seedDocument(
      dataHome,
      JSON.stringify({ bad: 10, good: "valid", foreign: { nested: true } }),
    );
    const config = await obtainConfig(dataHome);
    config.define("bad", isString);
    config.define("good", isString);

    await expect(config.read("bad")).rejects.toThrow("is invalid");
    expect(await config.read<string>("good")).toBe("valid");
    await config.write("good", "updated");
    expect(JSON.parse(await readFile(documentPath(dataHome), "utf8"))).toEqual({
      bad: 10,
      good: "updated",
      foreign: { nested: true },
    });
  });

  test.each([
    ["corrupt JSON", "{broken"],
    ["an array", "[]"],
    ["a string", '"value"'],
    ["a number", "1"],
    ["a boolean", "true"],
    ["null", "null"],
  ])(
    "rejects %s on reads and writes without replacement",
    async (_, original) => {
      await seedDocument(dataHome, original);
      const config = await obtainConfig(dataHome);
      config.define("value", isString);

      await expect(config.read("value")).rejects.toThrow();
      await expect(config.write("value", "replacement")).rejects.toThrow();
      expect(await readFile(documentPath(dataHome), "utf8")).toBe(original);
    },
  );

  test("keeps the previous document and removes its temp file when replacement fails", async () => {
    const path = documentPath(dataHome);
    const original = '{"stable":true}\n';
    await seedDocument(dataHome, original);
    const storage = createConfigStorage(path, {
      async rename() {
        throw new Error("replacement failed");
      },
    });

    await expect(storage.write({ stable: false })).rejects.toThrow(
      "replacement failed",
    );
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(join(dataHome, "tx"))).toEqual(["config.json"]);
  });

  test("leaves a complete JSON document after concurrent writers race", async () => {
    const writers = await Promise.all(
      Array.from({ length: 24 }, async () => {
        const config = await obtainConfig(dataHome);
        config.define("winner", isNumber);
        return config;
      }),
    );

    await Promise.all(
      writers.map((config, value) => config.write("winner", value)),
    );

    const persisted = JSON.parse(
      await readFile(documentPath(dataHome), "utf8"),
    ) as Record<string, unknown>;
    expect(typeof Reflect.get(persisted, "winner")).toBe("number");
    expect(await readdir(join(dataHome, "tx"))).toEqual(["config.json"]);
  });
});
