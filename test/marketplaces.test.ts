import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveMarketplaceName,
  MarketplaceManager,
  parseAddMarketplaceArguments,
  parseListMarketplaceArguments,
  parseRemoveMarketplaceArguments,
  prepareMarketplace,
  resolveMarketplaceDirectory,
  resolveUserDataDirectory,
  runGit,
  validateMarketplaceName,
} from "../src/marketplaces.ts";

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function createGitRepository(root: string): Promise<string> {
  const repository = join(root, "source.git");
  expect(Bun.spawnSync(["git", "init", repository]).exitCode).toBe(0);
  await writeFile(join(repository, "README.txt"), "marketplace\n");
  expect(
    Bun.spawnSync(["git", "add", "README.txt"], { cwd: repository }).exitCode,
  ).toBe(0);
  expect(
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=TX Tests",
        "-c",
        "user.email=tx@example.invalid",
        "commit",
        "-m",
        "initial",
      ],
      { cwd: repository },
    ).exitCode,
  ).toBe(0);
  return repository;
}

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

  test("strictly parses add arguments with the name in either position", () => {
    expect(parseAddMarketplaceArguments(["repo"])).toEqual({
      repository: "repo",
    });
    expect(parseAddMarketplaceArguments(["--name", "mine", "repo"])).toEqual({
      repository: "repo",
      name: "mine",
    });
    expect(parseAddMarketplaceArguments(["repo", "--name", "mine"])).toEqual({
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
    expect(() => parseAddMarketplaceArguments(args)).toThrow();
  });

  test("strictly parses list and remove arguments", () => {
    expect(parseListMarketplaceArguments([])).toBeUndefined();
    expect(() => parseListMarketplaceArguments(["extra"])).toThrow(
      "Usage: tx marketplace list",
    );
    expect(parseRemoveMarketplaceArguments(["mine"])).toBe("mine");
    expect(() => parseRemoveMarketplaceArguments([])).toThrow(
      "Usage: tx marketplace remove <name>",
    );
    expect(() => parseRemoveMarketplaceArguments(["one", "two"])).toThrow();
    expect(() => parseRemoveMarketplaceArguments(["../bad"])).toThrow();
  });
});

describe("Git execution", () => {
  test("returns stdout and reports stderr without invoking a shell", async () => {
    expect((await runGit(["--version"])).stdout).toStartWith("git version");
    await expect(runGit(["not-a-real-command"])).rejects.toThrow(
      "Git command failed:",
    );
    await expect(
      runGit(["config", "--get", "tx.tests.missing-value"]),
    ).rejects.toThrow("Git command failed");
    await expect(prepareMarketplace("/unused")).resolves.toBeUndefined();
  });
});

describe("MarketplaceManager", () => {
  test("clones local Git repositories, awaits preparation, lists, and removes", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplaces-");
    try {
      const repository = await createGitRepository(temporaryRoot);
      const root = join(temporaryRoot, "data", "marketplaces");
      let prepared = false;
      const manager = new MarketplaceManager(root, {
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
        const manager = new MarketplaceManager(root, {
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
