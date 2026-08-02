import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  deriveMarketplaceName,
  MarketplaceManager,
  parseAddMarketplaceArguments,
  parseListMarketplaceArguments,
  parseRemoveMarketplaceArguments,
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
} from "../src/marketplaces.ts";
import { createGitRepository, temporaryDirectory } from "./helpers.ts";

const marketplaceCapabilities = {
  resolveDirectory: resolveMarketplaceDirectory,
  validateName: validateMarketplaceName,
  discover: discoverInstalledMarketplaces,
  prepare: prepareMarketplace,
};

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
    expect(deriveMarketplaceName(repository, validateMarketplaceName)).toBe(
      name,
    );
  });

  test.each(["", "https://example.com/..", "git@example.com:me/-bad.git"])(
    "rejects repository without a safe derived name: %s",
    (repository) =>
      expect(() =>
        deriveMarketplaceName(repository, validateMarketplaceName),
      ).toThrow(),
  );

  test("strictly parses add arguments with the name in either position", () => {
    expect(
      parseAddMarketplaceArguments(["repo"], validateMarketplaceName),
    ).toEqual({
      repository: "repo",
    });
    expect(
      parseAddMarketplaceArguments(
        ["--name", "mine", "repo"],
        validateMarketplaceName,
      ),
    ).toEqual({
      repository: "repo",
      name: "mine",
    });
    expect(
      parseAddMarketplaceArguments(
        ["repo", "--name", "mine"],
        validateMarketplaceName,
      ),
    ).toEqual({
      repository: "repo",
      name: "mine",
    });
  });

  test.each([
    [[]],
    [["repo", "extra"]],
    [["--unknown", "repo"]],
    [["--name"]],
    [["--name", "--other", "repo"]],
    [["--name", "one", "--name", "two", "repo"]],
    [["repo", "--name", "../bad"]],
  ] as const)("rejects invalid add arguments %#", (args) => {
    expect(() =>
      parseAddMarketplaceArguments(args, validateMarketplaceName),
    ).toThrow();
  });

  test("strictly parses list and remove arguments", () => {
    expect(parseListMarketplaceArguments([])).toBeUndefined();
    expect(() => parseListMarketplaceArguments(["extra"])).toThrow(
      "Usage: tx marketplace list",
    );
    expect(
      parseRemoveMarketplaceArguments(["mine"], validateMarketplaceName),
    ).toBe("mine");
    expect(() =>
      parseRemoveMarketplaceArguments([], validateMarketplaceName),
    ).toThrow("Usage: tx marketplace remove <name>");
    expect(() =>
      parseRemoveMarketplaceArguments(["one", "two"], validateMarketplaceName),
    ).toThrow();
    expect(() =>
      parseRemoveMarketplaceArguments(["../bad"], validateMarketplaceName),
    ).toThrow();
  });
});

describe("marketplace manifests", () => {
  test("accepts unknown fields and preserves manifest order", async () => {
    const root = await temporaryDirectory("tx-manifest-valid-");
    try {
      await mkdir(join(root, "plugins", "work"), { recursive: true });
      await writeFile(
        join(root, "plugins", "notes.ts"),
        "export default () => {};",
      );
      await writeFile(
        join(root, "plugins", "work", "index.ts"),
        "export default () => {};",
      );
      await writeFile(
        join(root, "tx.marketplace.json"),
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

  test.each([
    ["missing", undefined, "Missing tx.marketplace.json"],
    ["malformed JSON", "{", "Invalid tx.marketplace.json"],
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
      await mkdir(join(root, "plugins"), { recursive: true });
      await writeFile(join(parent, "outside.ts"), "outside");
      await writeFile(join(root, "plugin.ts"), "plugin");
      if (contents !== undefined) {
        await writeFile(join(root, "tx.marketplace.json"), contents);
      }
      await expect(readMarketplaceManifest(root)).rejects.toThrow(expected);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("allows contained manifest symlinks and rejects escaping ones", async () => {
    const parent = await temporaryDirectory("tx-manifest-file-symlink-");
    const root = join(parent, "marketplace");
    const manifestPath = join(root, "tx.marketplace.json");
    const manifest = '{"plugins":[{"name":"notes","entry":"plugin.ts"}]}';
    try {
      await mkdir(root);
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
        "tx.marketplace.json escapes the marketplace",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("preserves non-missing filesystem errors for plugin entries", async () => {
    const root = await temporaryDirectory("tx-manifest-entry-error-");
    try {
      await symlink("loop.ts", join(root, "loop.ts"));
      await writeFile(
        join(root, "tx.marketplace.json"),
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
      await mkdir(root);
      await writeFile(join(root, "inside.ts"), "inside");
      await writeFile(join(parent, "outside.ts"), "outside");
      await symlink(join(root, "inside.ts"), join(root, "linked.ts"));
      await writeFile(
        join(root, "tx.marketplace.json"),
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
  test("validates first and installs dependencies only with package.json", async () => {
    const root = await temporaryDirectory("tx-marketplace-prepare-");
    try {
      await writeFile(join(root, "plugin.ts"), "export default () => {};");
      await writeFile(
        join(root, "tx.marketplace.json"),
        '{"plugins":[{"name":"plugin","entry":"plugin.ts"}]}',
      );
      const calls: unknown[][] = [];
      const run = async (...args: unknown[]) => {
        calls.push(args);
      };

      await prepareMarketplace(root, { runBun: run });
      expect(calls).toEqual([]);
      await writeFile(join(root, "package.json"), "{}");
      await prepareMarketplace(root, { runBun: run });
      expect(calls).toEqual([[["install"], { cwd: root }]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("shell-free process execution", () => {
  test("returns Git stdout and reports Git stderr", async () => {
    expect((await runGit(["--version"])).stdout).toStartWith("git version");
    await expect(runGit(["not-a-real-command"])).rejects.toThrow(
      "Git command failed:",
    );
    await expect(
      runGit(["config", "--get", "tx.tests.missing-value"]),
    ).rejects.toThrow("Git command failed");
  });

  test("runs Bun arguments directly and reports failures", async () => {
    const root = await temporaryDirectory("tx-bun-runner-");
    try {
      await expect(
        runBun(["--version"], { cwd: root }),
      ).resolves.toBeUndefined();
      await expect(
        runBun(
          ["--eval", "process.stderr.write('runner failed'); process.exit(9)"],
          { cwd: root },
        ),
      ).rejects.toThrow("Bun dependency installation failed: runner failed");
      await expect(
        runBun(["--eval", "process.exit(9)"], { cwd: root }),
      ).rejects.toThrow("Bun dependency installation failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MarketplaceManager", () => {
  test("clones local Git repositories, awaits preparation, lists, and removes", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplaces-");
    try {
      const repository = await createGitRepository(
        temporaryRoot,
        "source.git",
        { "README.txt": "marketplace\n" },
      );
      const root = join(temporaryRoot, "data", "marketplaces");
      let prepared = false;
      const manager = new MarketplaceManager(root, marketplaceCapabilities, {
        prepareMarketplace: async (checkout) => {
          expect(checkout).toContain(".source-staging-");
          expect(await readFile(join(checkout, "README.txt"), "utf8")).toBe(
            "marketplace\n",
          );
          await Promise.resolve();
          prepared = true;
        },
      });

      expect(await manager.add(repository)).toBe("source");
      expect(prepared).toBe(true);
      expect(await manager.list()).toEqual([
        { name: "source", source: repository },
      ]);
      await expect(manager.add(repository)).rejects.toThrow(
        "already installed",
      );
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
      const manager = new MarketplaceManager(root, marketplaceCapabilities, {
        runGit: async (args) => {
          const staging = args.at(-1) as string;
          await writeFile(
            join(staging, "tx.marketplace.json"),
            '{"plugins":[{"name":"plugin","entry":"plugin.ts"}]}',
          );
          await writeFile(
            join(staging, "plugin.ts"),
            "export default () => {};",
          );
          await writeFile(join(staging, "package.json"), "{}");
          return { stdout: "" };
        },
        prepareMarketplace: (checkout) =>
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

  test("preserves duplicates found after preparation and cleans staging", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-race-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const target = join(root, "race");
      const manager = new MarketplaceManager(root, marketplaceCapabilities, {
        runGit: async (args) => {
          const staging = args.at(-1) as string;
          await writeFile(join(staging, "clone.txt"), "clone");
          return { stdout: "" };
        },
        prepareMarketplace: async () => {
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
        const manager = new MarketplaceManager(root, marketplaceCapabilities, {
          runGit: async (args) => {
            if (failure === "clone") throw new Error("clone failed");
            await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
            return { stdout: "" };
          },
          prepareMarketplace: async () => {
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

  test("lists valid directories in sorted order and tolerates corrupt entries", async () => {
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
      const manager = new MarketplaceManager(root, marketplaceCapabilities, {
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
      const manager = new MarketplaceManager(root, marketplaceCapabilities, {
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

      await new MarketplaceManager(root, marketplaceCapabilities).remove(
        "linked",
      );

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
