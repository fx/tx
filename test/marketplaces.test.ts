import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveMarketplaceName,
  MarketplaceManager,
  normalizeMarketplaceRepository,
  type RunGit,
  runGit,
} from "../plugins/marketplace/manager.ts";
import {
  discoverInstalledMarketplaces,
  prepareMarketplace,
  readMarketplaceManifest,
  resolveMarketplaceDirectory,
  resolveUserDataDirectory,
  runBun,
  validateMarketplaceName,
} from "../plugins/marketplace/storage.ts";
import { createGitRepository, temporaryDirectory } from "./helpers.ts";

describe("platform user data resolution", () => {
  test("uses deterministic Unix, macOS, and Windows locations", () => {
    expect(
      resolveUserDataDirectory({
        platform: "linux",
        env: { XDG_DATA_HOME: "/data" },
        home: "/home/alice",
      }),
    ).toBe("/data/tx");
    expect(
      resolveUserDataDirectory({
        platform: "freebsd",
        env: {},
        home: "/home/alice",
      }),
    ).toBe("/home/alice/.local/share/tx");
    expect(
      resolveUserDataDirectory({
        platform: "linux",
        env: { XDG_DATA_HOME: "relative/data" },
        home: "/home/alice",
      }),
    ).toBe("/home/alice/.local/share/tx");
    expect(
      resolveUserDataDirectory({
        platform: "darwin",
        env: { XDG_DATA_HOME: "/ignored" },
        home: "/Users/alice",
      }),
    ).toBe("/Users/alice/Library/Application Support/tx");
    expect(
      resolveUserDataDirectory({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Local", APPDATA: "C:\\Roaming" },
        home: "C:\\Users\\alice",
      }),
    ).toBe("C:\\Local\\tx");
    expect(
      resolveUserDataDirectory({
        platform: "win32",
        env: { APPDATA: "C:\\Roaming" },
        home: "C:\\Users\\alice",
      }),
    ).toBe("C:\\Roaming\\tx");
    expect(
      resolveMarketplaceDirectory({
        platform: "win32",
        env: {},
        home: "C:\\Users\\alice",
      }),
    ).toBe("C:\\Users\\alice\\AppData\\Local\\tx\\marketplaces");
    expect(resolveMarketplaceDirectory()).toEndWith("marketplaces");
  });

  test("requires a home when no environment override exists", () => {
    expect(() =>
      resolveUserDataDirectory({ platform: "linux", env: {}, home: "" }),
    ).toThrow("without a home directory");
    expect(() =>
      resolveUserDataDirectory({ platform: "darwin", env: {}, home: "" }),
    ).toThrow("without a home directory");
  });
});

describe("marketplace names and arguments", () => {
  test.each(["personal", "A", "team.plugins", "team_plugins", "team-1"])(
    "accepts safe name %s",
    (name) => expect(validateMarketplaceName(name)).toBe(name),
  );

  test.each(["", ".", "..", " two", "two ", "a/b", "a\\b", "-flag"])(
    "rejects unsafe name %s",
    (name) =>
      expect(() => validateMarketplaceName(name)).toThrow(
        "Invalid marketplace name",
      ),
  );

  test.each([
    ["https://github.com/me/tx-plugins.git", "tx-plugins"],
    ["ssh://git@example.com/me/plugins.git/", "plugins"],
    ["git@example.com:me/personal.git", "personal"],
    ["../local/repository", "repository"],
    ["C:\\repos\\windows.git", "windows"],
  ])("derives %s as %s", (repository, name) => {
    expect(deriveMarketplaceName(repository)).toBe(name);
  });

  test.each(["", "https://example.com/..", "git@example.com:me/-bad.git"])(
    "rejects repository without a safe derived name: %s",
    (repository) => expect(() => deriveMarketplaceName(repository)).toThrow(),
  );

  test.each([
    ["fx/tx", "https://github.com/fx/tx.git"],
    ["fx/tx.git", "https://github.com/fx/tx.git"],
    ["github/.github", "https://github.com/github/.github.git"],
    ["./fx/tx", "./fx/tx"],
    ["../local/repository", "../local/repository"],
    ["/local/repository", "/local/repository"],
    ["C:\\repos\\windows.git", "C:\\repos\\windows.git"],
    ["https://github.com/fx/tx.git", "https://github.com/fx/tx.git"],
    ["ssh://git@github.com/fx/tx.git", "ssh://git@github.com/fx/tx.git"],
    ["git@github.com:fx/tx.git", "git@github.com:fx/tx.git"],
  ])("normalizes repository %s as %s", (repository, expected) => {
    expect(normalizeMarketplaceRepository(repository)).toBe(expected);
  });
});

describe("marketplace manifests", () => {
  test("accepts unknown fields and preserves manifest order", async () => {
    const root = await temporaryDirectory("tx-manifest-valid-");
    try {
      await Promise.all([
        mkdir(join(root, ".tx"), { recursive: true }),
        mkdir(join(root, "plugins", "work"), { recursive: true }),
      ]);
      await writeFile(
        join(root, "plugins", "notes.ts"),
        "export default () => {};",
      );
      await writeFile(
        join(root, "plugins", "work", "index.ts"),
        "export default () => {};",
      );
      await writeFile(join(root, "tx.marketplace.json"), "{}");
      await writeFile(
        join(root, ".tx/config.json"),
        JSON.stringify({
          future: { enabled: true },
          plugins: [
            { name: "notes", entry: "plugins/notes.ts", future: 1 },
            { name: "work", entry: "plugins/work/index.ts" },
          ],
        }),
      );

      const manifest = await readMarketplaceManifest(root);
      expect(
        manifest.plugins.map(({ name, entry }) => ({ name, entry })),
      ).toEqual([
        { name: "notes", entry: "plugins/notes.ts" },
        { name: "work", entry: "plugins/work/index.ts" },
      ]);
      expect(
        manifest.plugins.every(({ entryPath }) => entryPath.startsWith(root)),
      ).toBe(true);
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.plugins)).toBe(true);
      expect(Object.isFrozen(manifest.plugins[0])).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to the legacy root manifest", async () => {
    const root = await temporaryDirectory("tx-manifest-legacy-");
    try {
      await writeFile(join(root, "plugin.ts"), "export default () => {};");
      await writeFile(
        join(root, "tx.marketplace.json"),
        '{"plugins":[{"name":"plugin","entry":"plugin.ts"}]}',
      );

      expect((await readMarketplaceManifest(root)).plugins[0]?.name).toBe(
        "plugin",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("identifies a selected legacy manifest that cannot be resolved", async () => {
    const root = await temporaryDirectory("tx-manifest-legacy-missing-");
    try {
      await symlink("missing.json", join(root, "tx.marketplace.json"));
      await expect(readMarketplaceManifest(root)).rejects.toThrow(
        "Missing tx.marketplace.json",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["missing", undefined, "Missing .tx/config.json"],
    ["malformed JSON", "{", "Invalid .tx/config.json"],
    ["non-object", "[]", "must contain a plugins array"],
    ["missing plugins", "{}", "must contain a plugins array"],
    ["empty plugins", '{"plugins":[]}', "plugins must not be empty"],
    ["non-object plugin", '{"plugins":[null]}', "plugin 1 must be an object"],
    [
      "unsafe plugin name",
      '{"plugins":[{"name":"../bad","entry":"plugin.ts"}]}',
      "must have a safe non-empty name",
    ],
    [
      "non-string entry",
      '{"plugins":[{"name":"notes","entry":1}]}',
      'Plugin "notes" entry must be a string',
    ],
    [
      "duplicate plugin name",
      '{"plugins":[{"name":"notes","entry":"plugin.ts"},{"name":"notes","entry":"plugin.ts"}]}',
      'Duplicate plugin name "notes"',
    ],
    [
      "empty entry",
      '{"plugins":[{"name":"notes","entry":""}]}',
      "must be a repository-relative path",
    ],
    [
      "absolute entry",
      '{"plugins":[{"name":"notes","entry":"/outside.ts"}]}',
      "must be a repository-relative path",
    ],
    [
      "escaping entry",
      '{"plugins":[{"name":"notes","entry":"../outside.ts"}]}',
      "entry escapes the marketplace",
    ],
    [
      "missing entry",
      '{"plugins":[{"name":"notes","entry":"missing.ts"}]}',
      "entry does not exist",
    ],
    [
      "directory entry",
      '{"plugins":[{"name":"notes","entry":"plugins"}]}',
      "entry is not a regular file",
    ],
    [
      "checkout root entry",
      '{"plugins":[{"name":"notes","entry":"."}]}',
      "entry is not a regular file",
    ],
    [
      "normalized checkout root entry",
      '{"plugins":[{"name":"notes","entry":"plugins/.."}]}',
      "entry is not a regular file",
    ],
  ])("rejects %s", async (_label, contents, expected) => {
    const parent = await temporaryDirectory("tx-manifest-invalid-");
    const root = join(parent, "marketplace");
    try {
      await Promise.all([
        mkdir(join(root, ".tx"), { recursive: true }),
        mkdir(join(root, "plugins"), { recursive: true }),
      ]);
      await writeFile(join(parent, "outside.ts"), "outside");
      await writeFile(join(root, "plugin.ts"), "plugin");
      if (contents !== undefined) {
        await writeFile(join(root, ".tx/config.json"), contents);
      }
      await expect(readMarketplaceManifest(root)).rejects.toThrow(expected);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("maps checkout resolution failures to manifest diagnostics", async () => {
    const parent = await temporaryDirectory("tx-manifest-checkout-error-");
    const missing = join(parent, "missing");
    const loop = join(parent, "loop");
    try {
      await expect(readMarketplaceManifest(missing)).rejects.toThrow(
        "Missing .tx/config.json",
      );
      await symlink("loop", loop);
      await expect(readMarketplaceManifest(loop)).rejects.toThrow(
        "Unable to read .tx/config.json",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("allows contained manifest symlinks and rejects escaping ones", async () => {
    const parent = await temporaryDirectory("tx-manifest-file-symlink-");
    const root = join(parent, "marketplace");
    const manifestPath = join(root, ".tx/config.json");
    const manifest = '{"plugins":[{"name":"notes","entry":"plugin.ts"}]}';
    try {
      await mkdir(join(root, ".tx"), { recursive: true });
      await writeFile(join(root, "plugin.ts"), "plugin");
      await writeFile(join(root, "manifest.json"), manifest);
      await writeFile(join(parent, "outside.json"), manifest);
      await symlink(join(root, "manifest.json"), manifestPath);
      await expect(readMarketplaceManifest(root)).resolves.toHaveProperty(
        "plugins.0.name",
        "notes",
      );

      await rm(manifestPath);
      await symlink(join(parent, "outside.json"), manifestPath);
      await expect(readMarketplaceManifest(root)).rejects.toThrow(
        ".tx/config.json escapes the marketplace",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("preserves non-missing filesystem errors for plugin entries", async () => {
    const root = await temporaryDirectory("tx-manifest-entry-error-");
    try {
      await mkdir(join(root, ".tx"));
      await symlink("loop.ts", join(root, "loop.ts"));
      await writeFile(
        join(root, ".tx/config.json"),
        '{"plugins":[{"name":"notes","entry":"loop.ts"}]}',
      );
      await expect(readMarketplaceManifest(root)).rejects.toHaveProperty(
        "code",
        "ELOOP",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows contained symlinks and rejects symlinks escaping the checkout", async () => {
    const parent = await temporaryDirectory("tx-manifest-symlink-");
    const root = join(parent, "marketplace");
    try {
      await mkdir(join(root, ".tx"), { recursive: true });
      await writeFile(join(root, "inside.ts"), "inside");
      await writeFile(join(parent, "outside.ts"), "outside");
      await symlink(join(root, "inside.ts"), join(root, "linked.ts"));
      await writeFile(
        join(root, ".tx/config.json"),
        '{"plugins":[{"name":"notes","entry":"linked.ts"}]}',
      );
      expect((await readMarketplaceManifest(root)).plugins[0]?.entryPath).toBe(
        join(root, "inside.ts"),
      );

      await rm(join(root, "linked.ts"));
      await symlink(join(parent, "outside.ts"), join(root, "linked.ts"));
      await expect(readMarketplaceManifest(root)).rejects.toThrow(
        "entry escapes the marketplace",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("marketplace preparation", () => {
  test("selects root and explicit manifests without nested fallback", async () => {
    const root = await temporaryDirectory("tx-marketplace-prepare-");
    try {
      await Promise.all([
        mkdir(join(root, ".tx")),
        mkdir(join(root, "plugins", "notes"), { recursive: true }),
        mkdir(join(root, "packages", "reports"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "root.ts"), "export default () => {};"),
        writeFile(
          join(root, "plugins", "notes", "index.ts"),
          "export default () => {};",
        ),
        writeFile(
          join(root, "plugins", "notes", "reports.ts"),
          "export default () => {};",
        ),
        writeFile(join(root, "package.json"), "{}"),
        writeFile(join(root, "packages", "reports", "package.json"), "{}"),
        writeFile(
          join(root, ".tx/config.json"),
          JSON.stringify({
            plugins: [
              { name: "root", entry: "root.ts" },
              { name: "notes", entry: "plugins/notes/index.ts" },
              {
                name: "reports",
                entry: "plugins/notes/reports.ts",
                package: "packages/reports/package.json",
              },
              {
                name: "optional",
                entry: "plugins/notes/reports.ts",
                package: "packages/missing/package.json",
              },
            ],
          }),
        ),
      ]);
      const calls: unknown[][] = [];
      const env = Object.freeze({ PATH: "/test/bin" });

      await prepareMarketplace(root, {
        env,
        runBun: async (...args: unknown[]) => {
          calls.push(args);
        },
      });

      expect(calls).toEqual([
        [["install"], { cwd: root, env }],
        [["install"], { cwd: join(root, "packages", "reports"), env }],
      ]);
      expect((await readMarketplaceManifest(root)).plugins[2]?.package).toBe(
        "packages/reports/package.json",
      );
      expect((await readMarketplaceManifest(root)).plugins[0]?.package).toBe(
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not fall back from a nested entry to the root manifest", async () => {
    const root = await temporaryDirectory("tx-marketplace-no-fallback-");
    try {
      await Promise.all([
        mkdir(join(root, ".tx")),
        mkdir(join(root, "plugins", "notes"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(root, "plugins", "notes", "index.ts"),
          "export default () => {};",
        ),
        writeFile(join(root, "package.json"), "{}"),
        writeFile(
          join(root, ".tx/config.json"),
          '{"plugins":[{"name":"notes","entry":"plugins/notes/index.ts"}]}',
        ),
      ]);
      const calls: unknown[] = [];

      await prepareMarketplace(root, {
        runBun: async (...args: unknown[]) => {
          calls.push(args);
        },
      });

      expect(calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("derives the default from the real entry location", async () => {
    const root = await temporaryDirectory("tx-marketplace-real-entry-");
    try {
      await Promise.all([
        mkdir(join(root, ".tx")),
        mkdir(join(root, "links")),
        mkdir(join(root, "real")),
      ]);
      await Promise.all([
        writeFile(join(root, "real", "plugin.ts"), "export default () => {};"),
        writeFile(join(root, "real", "package.json"), "{}"),
        symlink(
          join(root, "real", "plugin.ts"),
          join(root, "links", "plugin.ts"),
        ),
        writeFile(
          join(root, ".tx/config.json"),
          '{"plugins":[{"name":"plugin","entry":"links/plugin.ts"}]}',
        ),
      ]);
      const directories: string[] = [];

      await prepareMarketplace(root, {
        runBun: async (_args, options) => {
          directories.push(options.cwd);
        },
      });

      expect(directories).toEqual([join(root, "real")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("validates every entry before the first installation", async () => {
    const root = await temporaryDirectory("tx-marketplace-validate-first-");
    try {
      await mkdir(join(root, ".tx"));
      await Promise.all([
        writeFile(join(root, "valid.ts"), "export default () => {};"),
        writeFile(join(root, "package.json"), "{}"),
        writeFile(
          join(root, ".tx/config.json"),
          JSON.stringify({
            plugins: [
              { name: "valid", entry: "valid.ts" },
              { name: "invalid", entry: "missing.ts" },
            ],
          }),
        ),
      ]);
      const calls: unknown[] = [];

      await expect(
        prepareMarketplace(root, {
          runBun: async (...args: unknown[]) => {
            calls.push(args);
          },
        }),
      ).rejects.toThrow("entry does not exist");
      expect(calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deduplicates canonical manifests in first plugin order", async () => {
    const root = await temporaryDirectory("tx-marketplace-package-order-");
    try {
      await Promise.all([
        mkdir(join(root, ".tx")),
        mkdir(join(root, "entries")),
        mkdir(join(root, "packages", "first"), { recursive: true }),
        mkdir(join(root, "packages", "second"), { recursive: true }),
        mkdir(join(root, "aliases")),
      ]);
      await Promise.all([
        writeFile(join(root, "entries", "one.ts"), "export default () => {};"),
        writeFile(join(root, "entries", "two.ts"), "export default () => {};"),
        writeFile(
          join(root, "entries", "three.ts"),
          "export default () => {};",
        ),
        writeFile(join(root, "packages", "first", "package.json"), "{}"),
        writeFile(join(root, "packages", "second", "package.json"), "{}"),
        symlink(
          join(root, "packages", "first", "package.json"),
          join(root, "aliases", "package.json"),
        ),
        writeFile(
          join(root, ".tx/config.json"),
          JSON.stringify({
            plugins: [
              {
                name: "second",
                entry: "entries/one.ts",
                package: "packages/second/package.json",
              },
              {
                name: "first-alias",
                entry: "entries/two.ts",
                package: "aliases/package.json",
              },
              {
                name: "first-direct",
                entry: "entries/three.ts",
                package: "packages/first/package.json",
              },
            ],
          }),
        ),
      ]);
      const directories: string[] = [];
      let installationActive = false;

      await prepareMarketplace(root, {
        runBun: async (_args, options) => {
          expect(installationActive).toBe(false);
          installationActive = true;
          await Bun.sleep(1);
          directories.push(options.cwd);
          installationActive = false;
        },
      });

      expect(directories).toEqual([
        join(root, "packages", "second"),
        join(root, "packages", "first"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["wrong type", 1, "package must be a string"],
    ["empty", "", "package must be a repository-relative path"],
    [
      "absolute",
      "/outside/package.json",
      "package must be a repository-relative path",
    ],
    ["lexical escape", "../package.json", "package escapes the marketplace"],
    [
      "wrong filename",
      "packages/manifest.json",
      "package must name package.json exactly",
    ],
  ])(
    "rejects %s package overrides before installation",
    async (_label, packageValue, expected) => {
      const root = await temporaryDirectory("tx-marketplace-package-invalid-");
      try {
        await mkdir(join(root, ".tx"));
        await writeFile(join(root, "plugin.ts"), "export default () => {};");
        await writeFile(join(root, "package.json"), "{}");
        await writeFile(
          join(root, ".tx/config.json"),
          JSON.stringify({
            plugins: [
              { name: "valid", entry: "plugin.ts" },
              { name: "invalid", entry: "plugin.ts", package: packageValue },
            ],
          }),
        );
        const calls: unknown[] = [];

        await expect(
          prepareMarketplace(root, {
            runBun: async (...args: unknown[]) => {
              calls.push(args);
            },
          }),
        ).rejects.toThrow(expected);
        expect(calls).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("rejects directories and unsafe package symlinks", async () => {
    const parent = await temporaryDirectory("tx-marketplace-package-symlink-");
    const root = join(parent, "marketplace");
    const outside = join(parent, "outside");
    try {
      await Promise.all([
        mkdir(join(root, ".tx"), { recursive: true }),
        mkdir(join(root, "directory", "package.json"), { recursive: true }),
        mkdir(outside),
      ]);
      await Promise.all([
        writeFile(join(root, "plugin.ts"), "export default () => {};"),
        writeFile(join(outside, "package.json"), "{}"),
      ]);
      const writeManifest = (packagePath: string) =>
        writeFile(
          join(root, ".tx/config.json"),
          JSON.stringify({
            plugins: [
              { name: "plugin", entry: "plugin.ts", package: packagePath },
            ],
          }),
        );

      await writeManifest("directory/package.json");
      await expect(prepareMarketplace(root)).rejects.toThrow(
        "package is not a regular file",
      );

      await symlink(join(outside, "package.json"), join(root, "package.json"));
      await writeManifest("package.json");
      await expect(prepareMarketplace(root)).rejects.toThrow(
        "package escapes the marketplace",
      );

      await symlink(outside, join(root, "external"));
      await writeManifest("external/missing/package.json");
      await expect(prepareMarketplace(root)).rejects.toThrow(
        "package escapes the marketplace",
      );

      await rm(join(root, "package.json"));
      await writeFile(join(root, "manifest.json"), "{}");
      await symlink(join(root, "manifest.json"), join(root, "package.json"));
      await writeManifest("package.json");
      await expect(prepareMarketplace(root)).rejects.toThrow(
        "package must resolve to package.json",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("rejects broken and looping package symlinks rather than skipping", async () => {
    const root = await temporaryDirectory("tx-marketplace-package-broken-");
    try {
      await mkdir(join(root, ".tx"));
      await writeFile(join(root, "plugin.ts"), "export default () => {};");
      const writeManifest = (packagePath: string) =>
        writeFile(
          join(root, ".tx/config.json"),
          JSON.stringify({
            plugins: [
              { name: "plugin", entry: "plugin.ts", package: packagePath },
            ],
          }),
        );

      await symlink("missing.json", join(root, "package.json"));
      await writeManifest("package.json");
      await expect(prepareMarketplace(root)).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );

      await rm(join(root, "package.json"));
      await symlink("package.json", join(root, "package.json"));
      await expect(prepareMarketplace(root)).rejects.toHaveProperty(
        "code",
        "ELOOP",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("shell-free process execution", () => {
  test("returns Git stdout and reports Git stderr", async () => {
    const options = { env: process.env };
    expect((await runGit(["--version"], options)).stdout).toStartWith(
      "git version",
    );
    await expect(runGit(["not-a-real-command"], options)).rejects.toThrow(
      "Git command failed:",
    );
    await expect(
      runGit(["config", "--get", "tx.tests.missing-value"], options),
    ).rejects.toThrow("Git command failed");
  });

  test("runs Bun arguments directly and reports failures", async () => {
    const root = await temporaryDirectory("tx-bun-runner-");
    try {
      await expect(
        runBun(["--version"], { cwd: root, env: process.env }),
      ).resolves.toBeUndefined();
      await expect(
        runBun(
          ["--eval", "process.stderr.write('runner failed'); process.exit(9)"],
          { cwd: root, env: process.env },
        ),
      ).rejects.toThrow("Bun dependency installation failed: runner failed");
      await expect(
        runBun(["--eval", "process.exit(9)"], { cwd: root, env: process.env }),
      ).rejects.toThrow("Bun dependency installation failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MarketplaceManager", () => {
  test("directs callers to provide a name when one cannot be derived", async () => {
    const manager = new MarketplaceManager("/unused", {
      runGit: async () => {
        throw new Error("Git must not run");
      },
    });

    await expect(manager.add("https://example.com/..")).rejects.toThrow(
      'Cannot derive a safe marketplace name from "https://example.com/.."; pass --name <name>',
    );
  });

  test("clones a file:// repository, awaits preparation, lists, and removes", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplaces-");
    try {
      const repository = await createGitRepository(
        temporaryRoot,
        "source.git",
        { "README.txt": "marketplace\n" },
      );
      // The directory exists, so only the URL scheme keeps this a clone.
      const source = pathToFileURL(repository).href;
      const root = join(temporaryRoot, "data", "marketplaces");
      let prepared = false;
      const manager = new MarketplaceManager(root, {
        prepare: async (checkout) => {
          expect(checkout).toContain(".source-staging-");
          expect(await readFile(join(checkout, "README.txt"), "utf8")).toBe(
            "marketplace\n",
          );
          await Promise.resolve();
          prepared = true;
        },
      });

      expect(await manager.add(source)).toBe("source");
      expect(prepared).toBe(true);
      expect(await manager.list()).toEqual([{ name: "source", source }]);
      await expect(manager.add(source)).rejects.toThrow("already installed");
      expect((await lstat(join(root, "source"))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(root, "source", "README.txt"), "utf8")).toBe(
        "marketplace\n",
      );

      // A clone is a snapshot: the source moves on without it.
      await writeFile(join(repository, "README.txt"), "edited\n");
      expect(await readFile(join(root, "source", "README.txt"), "utf8")).toBe(
        "marketplace\n",
      );

      await manager.remove("source");
      await expect(lstat(join(root, "source"))).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
      await expect(manager.remove("source")).rejects.toThrow(
        "is not installed",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("runs production preparation in staging before atomic installation", async () => {
    const temporaryRoot = await temporaryDirectory(
      "tx-marketplace-production-",
    );
    try {
      const root = join(temporaryRoot, "marketplaces");
      const target = join(root, "prepared");
      const manager = new MarketplaceManager(root, {
        runGit: async (args) => {
          const staging = args.at(-1) as string;
          await mkdir(join(staging, ".tx"));
          await writeFile(
            join(staging, ".tx/config.json"),
            '{"plugins":[{"name":"plugin","entry":"plugin.ts"}]}',
          );
          await writeFile(
            join(staging, "plugin.ts"),
            "export default () => {};",
          );
          await writeFile(join(staging, "package.json"), "{}");
          return { stdout: "" };
        },
        prepare: (checkout) =>
          prepareMarketplace(checkout, {
            runBun: async (args, options) => {
              expect(args).toEqual(["install"]);
              expect(options.cwd).toBe(checkout);
              await expect(lstat(target)).rejects.toHaveProperty(
                "code",
                "ENOENT",
              );
              await writeFile(join(checkout, "installed.txt"), "ready");
            },
          }),
      });

      expect(await manager.add("repository", "prepared")).toBe("prepared");
      expect(await readFile(join(target, "installed.txt"), "utf8")).toBe(
        "ready",
      );
      expect(
        (await readdir(root)).filter((name) => name.includes("staging")),
      ).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("cleans staging when a selected dependency installation fails", async () => {
    const temporaryRoot = await temporaryDirectory(
      "tx-marketplace-install-failure-",
    );
    try {
      const root = join(temporaryRoot, "marketplaces");
      const target = join(root, "failed");
      const manager = new MarketplaceManager(root, {
        runGit: async (args) => {
          const staging = args.at(-1) as string;
          await mkdir(join(staging, ".tx"));
          await writeFile(
            join(staging, ".tx/config.json"),
            '{"plugins":[{"name":"plugin","entry":"plugin.ts"}]}',
          );
          await writeFile(
            join(staging, "plugin.ts"),
            "export default () => {};",
          );
          await writeFile(join(staging, "package.json"), "{}");
          return { stdout: "" };
        },
        prepare: (checkout) =>
          prepareMarketplace(checkout, {
            runBun: async () => {
              throw new Error("trusted lifecycle failed");
            },
          }),
      });

      await expect(manager.add("repository", "failed")).rejects.toThrow(
        "trusted lifecycle failed",
      );
      await expect(lstat(target)).rejects.toHaveProperty("code", "ENOENT");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("passes its initialization environment to every Git operation", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-git-env-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const env = Object.freeze({ PATH: "/test/bin", TOKEN: "secret" });
      const calls: {
        readonly args: readonly string[];
        readonly env: Readonly<Record<string, string | undefined>>;
      }[] = [];
      const manager = new MarketplaceManager(root, {
        env,
        runGit: async (args, options) => {
          calls.push({ args: [...args], env: options.env });
          return { stdout: "ssh://example/repository.git\n" };
        },
        prepare: async () => {},
      });

      await manager.add("fx/tx", "installed");
      await manager.list();

      expect(calls.map(({ args }) => args)).toEqual([
        [
          "clone",
          "--",
          "https://github.com/fx/tx.git",
          expect.stringContaining(".installed-staging-"),
        ],
        ["-C", join(root, "installed"), "config", "--get", "remote.origin.url"],
      ]);
      expect(calls.every((call) => call.env === env)).toBe(true);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("preserves duplicates found after preparation and cleans staging", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-race-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const target = join(root, "race");
      const manager = new MarketplaceManager(root, {
        runGit: async (args) => {
          const staging = args.at(-1) as string;
          await writeFile(join(staging, "clone.txt"), "clone");
          return { stdout: "" };
        },
        prepare: async () => {
          await mkdir(target);
          await writeFile(join(target, "existing.txt"), "existing");
        },
      });

      await expect(manager.add("repository", "race")).rejects.toThrow(
        "already installed",
      );
      expect(await readFile(join(target, "existing.txt"), "utf8")).toBe(
        "existing",
      );
      expect(
        (await readdir(root)).filter((name) => name.includes("staging")),
      ).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test.each(["clone", "prepare"])(
    "cleans temporary storage when %s fails",
    async (failure) => {
      const temporaryRoot = await temporaryDirectory("tx-marketplace-failure-");
      try {
        const root = join(temporaryRoot, "marketplaces");
        const manager = new MarketplaceManager(root, {
          runGit: async (args) => {
            if (failure === "clone") throw new Error("clone failed");
            await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
            return { stdout: "" };
          },
          prepare: async () => {
            if (failure === "prepare") throw new Error("prepare failed");
          },
        });

        await expect(manager.add("repo", "failure")).rejects.toThrow(
          `${failure} failed`,
        );
        expect(await readdir(root)).toEqual([]);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  test("lists directories and references in sorted order and tolerates corrupt entries", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-list-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      await mkdir(join(root, "zeta"), { recursive: true });
      await mkdir(join(root, "alpha"));
      await mkdir(join(root, ".staging"));
      await writeFile(join(root, "plain-file"), "not a checkout");
      await symlink(join(root, "alpha"), join(root, "linked"));
      const calls: string[][] = [];
      let releaseAlpha: (() => void) | undefined;
      const zetaStarted = new Promise<void>((resolve) => {
        releaseAlpha = resolve;
      });
      const manager = new MarketplaceManager(root, {
        runGit: async (args) => {
          calls.push([...args]);
          if (args[1]?.endsWith("zeta")) {
            releaseAlpha?.();
            throw new Error("corrupt repository");
          }
          await zetaStarted;
          return { stdout: "ssh://example/alpha.git\n" };
        },
      });

      expect(await manager.list()).toEqual([
        { name: "alpha", source: "ssh://example/alpha.git" },
        { name: "linked", source: join(root, "alpha") },
        { name: "zeta", source: "<unknown>" },
      ]);
      expect(calls).toEqual([
        ["-C", join(root, "alpha"), "config", "--get", "remote.origin.url"],
        ["-C", join(root, "zeta"), "config", "--get", "remote.origin.url"],
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("returns an empty list for missing storage and unknown for blank source", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-empty-");
    try {
      const root = join(temporaryRoot, "missing");
      const manager = new MarketplaceManager(root, {
        runGit: async () => ({ stdout: "  \n" }),
      });
      expect(await manager.list()).toEqual([]);
      await mkdir(join(root, "blank"), { recursive: true });
      expect(await manager.list()).toEqual([
        { name: "blank", source: "<unknown>" },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("removes a symlink without following its external target", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-symlink-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const external = join(temporaryRoot, "external");
      await mkdir(root);
      await mkdir(external);
      await writeFile(join(external, "keep.txt"), "keep");
      await symlink(external, join(root, "linked"));

      await new MarketplaceManager(root).remove("linked");

      expect(await readFile(join(external, "keep.txt"), "utf8")).toBe("keep");
      await expect(lstat(join(root, "linked"))).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

const rejectGit: RunGit = async () => {
  throw new Error("Git must not run for a local source");
};

/**
 * A directory holding a valid marketplace, created inside the caller's own
 * temporary directory so nothing in the working repository is referenced,
 * installed into, or removed.
 */
async function createLocalSource(
  parent: string,
  name: string,
  plugin = name,
): Promise<string> {
  const source = join(parent, name);
  await mkdir(join(source, ".tx"), { recursive: true });
  await Promise.all([
    writeFile(join(source, "plugin.ts"), "export default () => {};\n"),
    writeFile(
      join(source, ".tx/config.json"),
      JSON.stringify({ plugins: [{ name: plugin, entry: "plugin.ts" }] }),
    ),
  ]);
  return source;
}

describe("local marketplace sources", () => {
  test("sends every Git source form to clone, including one naming a real directory", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-git-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const source = pathToFileURL(
        await createLocalSource(temporaryRoot, "tools"),
      ).href;
      const cloned: string[] = [];
      const manager = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        prepare: async () => {},
        runGit: async (args) => {
          cloned.push(args[2] as string);
          await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
          return { stdout: "" };
        },
      });

      // A directory whose name reads as SCP-style syntax to Git reads that way
      // here too, and stays reachable as a local source by a path.
      const colon = await createLocalSource(temporaryRoot, "host:path");

      expect(await manager.add(source)).toBe("tools");
      expect(await manager.add("git@example.com:me/scp.git")).toBe("scp");
      expect(await manager.add("ssh://git@example.com/me/remote.git")).toBe(
        "remote",
      );
      expect(await manager.add("owner/absent")).toBe("absent");
      expect(await manager.add("host:path", "colon-remote")).toBe(
        "colon-remote",
      );
      expect(await manager.add("./host:path", "colon-local")).toBe(
        "colon-local",
      );

      expect(cloned).toEqual([
        source,
        "git@example.com:me/scp.git",
        "ssh://git@example.com/me/remote.git",
        "https://github.com/owner/absent.git",
        "host:path",
      ]);
      for (const name of ["absent", "colon-remote", "remote", "scp", "tools"]) {
        expect((await lstat(join(root, name))).isSymbolicLink()).toBe(false);
      }
      expect(await readlink(join(root, "colon-local"))).toBe(colon);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("references an existing directory and re-reads its edits without reinstalling", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-local-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const source = await createLocalSource(temporaryRoot, "tools");
      const prepared: string[] = [];
      const manager = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async (checkout) => {
          prepared.push(checkout);
        },
      });

      expect(await manager.add("tools")).toBe("tools");
      expect(prepared).toEqual([source]);
      const target = join(root, "tools");
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
      expect(await readlink(target)).toBe(source);
      expect(await manager.list()).toEqual([{ name: "tools", source }]);
      expect((await readMarketplaceManifest(target)).plugins[0]?.name).toBe(
        "tools",
      );

      await writeFile(
        join(source, ".tx/config.json"),
        '{"plugins":[{"name":"edited","entry":"plugin.ts"}]}',
      );

      expect((await readMarketplaceManifest(target)).plugins[0]?.name).toBe(
        "edited",
      );
      expect(prepared).toEqual([source]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("lets an existing directory win over owner/repository shorthand", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-shorthand-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const source = await createLocalSource(
        temporaryRoot,
        join("owner", "repository"),
        "shorthand",
      );
      const cloned: string[] = [];
      const manager = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        prepare: async () => {},
        runGit: async (args) => {
          cloned.push(args[2] as string);
          await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
          return { stdout: "" };
        },
      });

      expect(await manager.add("owner/repository")).toBe("repository");
      expect(await readlink(join(root, "repository"))).toBe(source);
      expect(cloned).toEqual([]);

      // The remote of the same spelling stays reachable by its full URL.
      expect(
        await manager.add("https://github.com/owner/repository.git", "remote"),
      ).toBe("remote");
      expect(cloned).toEqual(["https://github.com/owner/repository.git"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("names a local marketplace after the directory it resolves to", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-name-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      await Promise.all([
        createLocalSource(temporaryRoot, "tools"),
        createLocalSource(temporaryRoot, "legacy.git"),
        createLocalSource(temporaryRoot, "-unsafe"),
      ]);
      const managerIn = (cwd: string) =>
        new MarketplaceManager(root, {
          cwd,
          runGit: rejectGit,
          prepare: async () => {},
        });

      expect(await managerIn(join(temporaryRoot, "tools")).add(".")).toBe(
        "tools",
      );
      await managerIn(temporaryRoot).remove("tools");
      expect(await managerIn(temporaryRoot).add("tools/")).toBe("tools");
      // A directory named tools.git is called that; only a Git URL drops it.
      expect(await managerIn(temporaryRoot).add("legacy.git")).toBe(
        "legacy.git",
      );
      await expect(managerIn(temporaryRoot).add("-unsafe")).rejects.toThrow(
        'Cannot derive a safe marketplace name from "-unsafe"; pass --name <name>',
      );

      expect((await readdir(root)).toSorted()).toEqual(["legacy.git", "tools"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects a name already held by a clone or a reference", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-taken-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const source = await createLocalSource(temporaryRoot, "tools");
      await mkdir(join(root, "cloned"), { recursive: true });
      const prepared: string[] = [];
      const manager = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async (checkout) => {
          prepared.push(checkout);
        },
      });

      expect(await manager.add("tools")).toBe("tools");
      await expect(manager.add("tools")).rejects.toThrow(
        'Marketplace "tools" is already installed',
      );
      await expect(manager.add(source, "cloned")).rejects.toThrow(
        'Marketplace "cloned" is already installed',
      );

      expect(prepared).toEqual([source]);
      expect((await readdir(root)).toSorted()).toEqual(["cloned", "tools"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects an empty source before it can name the working directory", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-empty-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const cwd = await createLocalSource(temporaryRoot, "work");
      const manager = new MarketplaceManager(root, {
        cwd,
        runGit: rejectGit,
        prepare: async () => {
          throw new Error("Preparation must not run");
        },
      });

      await expect(manager.add("")).rejects.toThrow(
        "Marketplace source must not be empty",
      );
      await expect(manager.add("", "named")).rejects.toThrow(
        "Marketplace source must not be empty",
      );

      expect((await readdir(cwd)).toSorted()).toEqual([".tx", "plugin.ts"]);
      await expect(lstat(root)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects an existing non-directory and reports other inspection failures", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-inspect-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      await Promise.all([
        writeFile(join(temporaryRoot, "file.txt"), "not a marketplace"),
        symlink("loop", join(temporaryRoot, "loop")),
      ]);
      const manager = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async () => {
          throw new Error("Preparation must not run");
        },
      });

      await expect(manager.add("file.txt")).rejects.toThrow(
        'Marketplace source "file.txt" is not a directory',
      );
      // An unreadable path is reported as itself rather than resurfacing as
      // an unrelated clone failure.
      await expect(manager.add("loop")).rejects.toHaveProperty("code", "ELOOP");

      await expect(lstat(root)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("pins the resolved real path against a later repointed link", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-pinned-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const current = join(temporaryRoot, "current");
      const [first] = await Promise.all([
        createLocalSource(join(temporaryRoot, "first"), "repo", "first"),
        createLocalSource(join(temporaryRoot, "second"), "repo", "second"),
      ]);
      const manager = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async () => {},
      });
      await symlink(join(temporaryRoot, "first"), current);

      expect(await manager.add("current/repo", "pinned")).toBe("pinned");
      await rm(current);
      await symlink(join(temporaryRoot, "second"), current);

      const target = join(root, "pinned");
      expect(await readlink(target)).toBe(first);
      expect((await readMarketplaceManifest(target)).plugins[0]?.name).toBe(
        "first",
      );
      expect(await manager.list()).toEqual([{ name: "pinned", source: first }]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("publishes nothing and leaves the referenced tree in place when preparation fails", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-rejected-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const source = await createLocalSource(temporaryRoot, "tools");
      const failing = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async (checkout) => {
          // Whatever trusted installation writes into the tree is not tx's to
          // undo; withholding the reference is all tx owns here.
          await writeFile(join(checkout, "installed.txt"), "installed");
          throw new Error("trusted lifecycle failed");
        },
      });

      await expect(failing.add("tools")).rejects.toThrow(
        "trusted lifecycle failed",
      );
      expect(await readdir(root)).toEqual([]);
      expect((await readdir(source)).toSorted()).toEqual([
        ".tx",
        "installed.txt",
        "plugin.ts",
      ]);
      expect(await readFile(join(source, "plugin.ts"), "utf8")).toBe(
        "export default () => {};\n",
      );

      // Production validation rejects an invalid source the same way, with no
      // dependency installation reached and nothing removed.
      const invalid = join(temporaryRoot, "invalid");
      await mkdir(invalid);
      await writeFile(join(invalid, "keep.txt"), "keep");
      await expect(
        new MarketplaceManager(root, {
          cwd: temporaryRoot,
          runGit: rejectGit,
        }).add("invalid"),
      ).rejects.toThrow("Missing .tx/config.json");
      expect(await readdir(root)).toEqual([]);
      expect(await readdir(invalid)).toEqual(["keep.txt"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("withholds a reference for a name taken during preparation", async () => {
    const temporaryRoot = await temporaryDirectory("tx-source-race-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const source = await createLocalSource(temporaryRoot, "tools");
      const manager = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async () => {
          await mkdir(join(root, "race"));
          await writeFile(join(root, "race", "existing.txt"), "existing");
        },
      });

      await expect(manager.add("tools", "race")).rejects.toThrow(
        'Marketplace "race" is already installed',
      );
      expect(await readdir(root)).toEqual(["race"]);
      expect((await lstat(join(root, "race"))).isDirectory()).toBe(true);
      expect((await readdir(source)).toSorted()).toEqual([".tx", "plugin.ts"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

interface ReferenceFixture {
  readonly root: string;
  readonly source: string;
  readonly missing: string;
  readonly replacement: string;
}

/**
 * Marketplace storage holding a clone beside three references: one to a
 * directory, one whose target has gone, and one whose target is now a file.
 * Every path lives under the caller's temporary directory.
 */
async function createReferenceStorage(
  temporaryRoot: string,
): Promise<ReferenceFixture> {
  const fixture = {
    root: join(temporaryRoot, "marketplaces"),
    source: join(temporaryRoot, "source"),
    missing: join(temporaryRoot, "moved-away"),
    replacement: join(temporaryRoot, "replacement.txt"),
  };
  await Promise.all([
    mkdir(join(fixture.root, "cloned"), { recursive: true }),
    mkdir(fixture.source),
  ]);
  await Promise.all([
    writeFile(join(fixture.source, "keep.txt"), "keep"),
    writeFile(fixture.replacement, "not a checkout"),
    writeFile(join(fixture.root, "plain-file"), "not a checkout"),
  ]);
  await Promise.all([
    symlink(fixture.source, join(fixture.root, "linked")),
    symlink(fixture.missing, join(fixture.root, "dangling")),
    symlink(fixture.replacement, join(fixture.root, "replaced")),
  ]);
  return fixture;
}

describe("referenced marketplaces", () => {
  test("discovers every reference whatever its target resolves to", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-discover-");
    try {
      const { root } = await createReferenceStorage(temporaryRoot);

      expect(await discoverInstalledMarketplaces(root)).toEqual([
        { name: "cloned", checkout: join(root, "cloned") },
        { name: "dangling", checkout: join(root, "dangling") },
        { name: "linked", checkout: join(root, "linked") },
        { name: "replaced", checkout: join(root, "replaced") },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("lists the recorded target of a reference and the remote of a clone", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-reference-");
    try {
      const { root, source, missing, replacement } =
        await createReferenceStorage(temporaryRoot);
      const manager = new MarketplaceManager(root, {
        runGit: async (args) => {
          expect(args[1]).toBe(join(root, "cloned"));
          return { stdout: "ssh://example/cloned.git\n" };
        },
      });

      expect(await manager.list()).toEqual([
        { name: "cloned", source: "ssh://example/cloned.git" },
        { name: "dangling", source: missing },
        { name: "linked", source },
        { name: "replaced", source: replacement },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("removes a reference without touching what it points at", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-unlink-");
    try {
      const { root, source, replacement } =
        await createReferenceStorage(temporaryRoot);
      const manager = new MarketplaceManager(root);

      for (const name of ["dangling", "linked", "replaced"]) {
        await manager.remove(name);
        await expect(lstat(join(root, name))).rejects.toHaveProperty(
          "code",
          "ENOENT",
        );
      }

      expect((await lstat(source)).isDirectory()).toBe(true);
      expect(await readdir(source)).toEqual(["keep.txt"]);
      expect(await readFile(join(source, "keep.txt"), "utf8")).toBe("keep");
      expect(await readFile(replacement, "utf8")).toBe("not a checkout");
      expect((await readdir(root)).toSorted()).toEqual([
        "cloned",
        "plain-file",
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
