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
  deriveMarketplaceSshRepository,
  discardStaging,
  MarketplaceAlreadyInstalledError,
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

  test.each([
    ["https://github.com/fx/tx.git", "git@github.com:fx/tx.git"],
    ["http://example.com/me/plugins.git", "git@example.com:me/plugins.git"],
    [
      "https://alice@git.company.com/team/tools.git",
      "git@git.company.com:team/tools.git",
    ],
    ["https://x:token@example.com/me/r.git", "git@example.com:me/r.git"],
    ["https://example.com:8443/me/r.git", "git@example.com:me/r.git"],
    ["https://alice@example.com:8443/me/r.git", "git@example.com:me/r.git"],
    ["https://example.com/me/r.git?ref=main", "git@example.com:me/r.git"],
    [
      "https://git.corp.example/team/my%20repo.git",
      "git@git.corp.example:team/my repo.git",
    ],
  ])("derives the SSH source of %s as %s", (repository, expected) => {
    expect(deriveMarketplaceSshRepository(repository)).toBe(expected);
  });

  test.each([
    "https://example.com/",
    "https://example.com/me/%zz.git",
    "ssh://git@example.com/me/r.git",
    "git@example.com:me/r.git",
    "file:///srv/repo.git",
    "git://example.com/me/r.git",
    "/local/repository",
    "C:\\repos\\windows.git",
  ])("derives no SSH source from %s", (repository) => {
    expect(deriveMarketplaceSshRepository(repository)).toBeUndefined();
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

/**
 * Whether a Git invocation is the `core.sshCommand` probe that settles the
 * clone environment. Matched on the argument list rather than on a position,
 * because the probe is one call per scope a clone applies.
 *
 * Every stub that reaches a clone answers this probe on its own. A stub that
 * answered all non-clone calls alike would report an SSH command by accident,
 * putting the test on the already-configured branch while it claims to cover
 * the batch-mode default — and a regression that removed the probe would
 * leave it green.
 */
function readsSshCommand(args: readonly string[]): boolean {
  return args.includes("core.sshCommand");
}

/** How `git config --get` reports a variable that is not set: exit non-zero. */
function unsetSshCommand(): never {
  throw new Error("Git command failed");
}

describe("MarketplaceManager", () => {
  test("resolves safe Git and canonical local sources without installing", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-resolve-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const local = await createLocalSource(temporaryRoot, "tools@2");
      let gitCalls = 0;
      let preparations = 0;
      const manager = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: async () => {
          gitCalls++;
          throw new Error("Git must not run while resolving");
        },
        prepare: async () => {
          preparations++;
        },
      });

      expect(
        await manager.resolve(
          "https://user:secret@example.com/acme/tools.git@v1.2.3",
        ),
      ).toEqual({
        name: "tools",
        source: "https://example.com/acme/tools.git@v1.2.3",
      });
      expect(await manager.resolve("./tools@2")).toEqual({
        name: "tools@2",
        source: local,
      });
      expect(await manager.resolve("owner/repository", "chosen")).toEqual({
        name: "chosen",
        source: "owner/repository",
      });
      expect(gitCalls).toBe(0);
      expect(preparations).toBe(0);
      await expect(lstat(root)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("uses a typed already-installed error before and after preparation", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-taken-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      await mkdir(join(root, "taken"), { recursive: true });
      const manager = new MarketplaceManager(root, { prepare: async () => {} });

      await expect(manager.add("source", "taken")).rejects.toBeInstanceOf(
        MarketplaceAlreadyInstalledError,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

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

      expect(await manager.add(source)).toEqual({ name: "source", source });
      expect(prepared).toBe(true);
      expect(await manager.list()).toEqual([
        // No tag is published, so the label is the abbreviated commit.
        {
          name: "source",
          source,
          version: expect.stringMatching(/^[0-9a-f]+$/),
        },
      ]);
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
          if (readsSshCommand(args)) unsetSshCommand();
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

      expect(await manager.add("repository", "prepared")).toEqual({
        name: "prepared",
        source: "repository",
      });
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
          if (readsSshCommand(args)) unsetSshCommand();
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

  test("augments the environment of a clone and passes its own to every other Git operation", async () => {
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
          if (readsSshCommand(args)) unsetSshCommand();
          return { stdout: "ssh://example/repository.git\n" };
        },
        prepare: async () => {},
      });

      await manager.add("fx/tx", "installed");
      await manager.list();

      expect(calls.map(({ args }) => args)).toEqual([
        ["config", "--global", "--get", "core.sshCommand"],
        ["config", "--system", "--get", "core.sshCommand"],
        [
          "clone",
          "--",
          "https://github.com/fx/tx.git",
          expect.stringContaining(".installed-staging-"),
        ],
        ["-C", join(root, "installed"), "config", "--get", "remote.origin.url"],
        [
          "-C",
          join(root, "installed"),
          "describe",
          "--tags",
          "--always",
          "HEAD",
        ],
      ]);
      // A clone attempt runs without Git's terminal prompt and, nothing being
      // configured, under the batch-mode SSH default, so its environment is a
      // copy carrying two more variables. Everything else — the probe that
      // settled that default included — keeps the initialization environment
      // by reference, and the frozen original is left as it is.
      expect(calls[2]?.env).toEqual({
        PATH: "/test/bin",
        TOKEN: "secret",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      });
      expect(calls[0]?.env).toBe(env);
      expect(calls[1]?.env).toBe(env);
      expect(calls[3]?.env).toBe(env);
      expect(calls[4]?.env).toBe(env);
      expect(env).toEqual({ PATH: "/test/bin", TOKEN: "secret" });
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
          if (readsSshCommand(args)) unsetSshCommand();
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
            if (readsSshCommand(args)) unsetSshCommand();
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

  test("reports a preparation failure a refused cleanup cannot replace", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-stuck-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      let staging = "";
      const manager = new MarketplaceManager(root, {
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
          return { stdout: "" };
        },
        prepare: async (checkout) => {
          staging = checkout;
          // The staging directory becomes unremovable in a way no privilege
          // bypasses: its parent turns into a regular file, so `rm` rejects
          // with ENOTDIR, which `force: true` does not suppress. A permission
          // bit would only work for a process that is not root.
          await rm(root, { recursive: true, force: true });
          await writeFile(root, "not a directory");
          throw new Error("prepare failed");
        },
      });

      // The publication failure the user needs, not the filesystem error the
      // cleanup in the `finally` ran into on its way out.
      await expect(manager.add("repo", "stuck")).rejects.toThrow(
        "prepare failed",
      );
      expect(staging).toStartWith(join(root, ".stuck-staging-"));
      await expect(
        rm(staging, { recursive: true, force: true }),
      ).rejects.toHaveProperty("code", "ENOTDIR");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

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
          return {
            stdout: args.includes("describe")
              ? "v2.0.0\n"
              : "ssh://example/alpha.git\n",
          };
        },
      });

      expect(await manager.list()).toEqual([
        { name: "alpha", source: "ssh://example/alpha.git", version: "v2.0.0" },
        { name: "linked", source: join(root, "alpha"), version: "live" },
        { name: "zeta", source: "<unknown>", version: "<unknown>" },
      ]);
      // A reference reaches Git not at all, and no read here contacts a
      // remote: the version comes out of the checkout. Compared as a set,
      // because the entries are read concurrently and each column of an entry
      // is read independently of the other.
      expect(calls.map((args) => args.join(" ")).toSorted()).toEqual(
        [
          `-C ${join(root, "alpha")} config --get remote.origin.url`,
          `-C ${join(root, "alpha")} describe --tags --always HEAD`,
          `-C ${join(root, "zeta")} config --get remote.origin.url`,
          `-C ${join(root, "zeta")} describe --tags --always HEAD`,
        ].toSorted(),
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("lists the version of a checkout that has lost its remote", async () => {
    const temporaryRoot = await temporaryDirectory("tx-marketplace-no-remote-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      await mkdir(join(root, "orphaned"), { recursive: true });
      const manager = new MarketplaceManager(root, {
        runGit: async (args) => {
          // What `git config --get` does for a variable that is not set,
          // which is what a checkout whose origin was removed answers.
          if (args.includes("remote.origin.url")) {
            throw new Error("Git command failed");
          }
          return { stdout: "v1.4.0\n" };
        },
      });

      // Each column is read on its own, so an unanswerable source does not
      // take the version down with it.
      expect(await manager.list()).toEqual([
        { name: "orphaned", source: "<unknown>", version: "v1.4.0" },
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
        { name: "blank", source: "<unknown>", version: "<unknown>" },
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

describe("marketplace clone transports", () => {
  test("retries a failed HTTPS clone over SSH and lists the SSH source", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-ssh-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const cloned: string[] = [];
      const probed: string[][] = [];
      const cloneEnv: Readonly<Record<string, string | undefined>>[] = [];
      const manager = new MarketplaceManager(root, {
        env: { PATH: "/test/bin" },
        prepare: async () => {},
        runGit: async (args, options) => {
          if (readsSshCommand(args)) {
            probed.push([...args]);
            unsetSshCommand();
          }
          if (args.includes("describe")) return { stdout: "v1.0.0\n" };
          if (args[0] !== "clone") {
            // The remote-URL answer belongs to the read it is meant for, and
            // to nothing else.
            expect(args).toContain("remote.origin.url");
            return { stdout: "git@github.com:fx/tx.git\n" };
          }
          const candidate = args[2] as string;
          cloned.push(candidate);
          cloneEnv.push(options.env);
          if (candidate.startsWith("https://")) {
            throw new Error("Authentication failed");
          }
          await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
          return { stdout: "" };
        },
      });

      expect(await manager.add("fx/tx")).toEqual({
        name: "tx",
        source: "fx/tx",
      });
      expect(cloned).toEqual([
        "https://github.com/fx/tx.git",
        "git@github.com:fx/tx.git",
      ]);
      // The probe really ran, in the scopes a clone applies and no other, and
      // really answered "not configured" — so this is the default SSH retry
      // the test is named for rather than the caller-configured branch.
      expect(probed).toEqual([
        ["config", "--global", "--get", "core.sshCommand"],
        ["config", "--system", "--get", "core.sshCommand"],
      ]);
      const batched = {
        PATH: "/test/bin",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      };
      expect(cloneEnv).toEqual([batched, batched]);
      expect(await manager.list()).toEqual([
        { name: "tx", source: "git@github.com:fx/tx.git", version: "v1.0.0" },
      ]);
      expect(await readdir(root)).toEqual(["tx"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("attempts nothing further once the HTTPS clone succeeds", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-https-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const cloned: string[] = [];
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          cloned.push(args[2] as string);
          await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
          return { stdout: "" };
        },
      });

      expect(await manager.add("fx/tx")).toEqual({
        name: "tx",
        source: "fx/tx",
      });
      expect(cloned).toEqual(["https://github.com/fx/tx.git"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test.each([
    "git@example.com:me/r.git",
    "ssh://git@example.com/me/r.git",
    "file:///srv/r.git",
    "host:path",
  ])("attempts the non-HTTPS source %s exactly once", async (source) => {
    const temporaryRoot = await temporaryDirectory("tx-clone-single-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const cloned: string[] = [];
      const manager = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          cloned.push(args[2] as string);
          throw new Error("clone failed");
        },
      });

      // The lone failure is reported exactly as Git reported it, since there
      // was no retry to describe.
      await expect(manager.add(source, "single")).rejects.toThrow(
        /^clone failed$/,
      );
      expect(cloned).toEqual([source]);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports both attempts when the SSH retry also fails", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-both-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          throw new Error(
            (args[2] as string).startsWith("https://")
              ? "HTTPS refused"
              : "SSH refused",
          );
        },
      });

      const failure: unknown = await manager
        .add("fx/tx", "both")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const { message, cause } = failure as Error;
      expect(message).toBe(
        'Cloning "https://github.com/fx/tx.git" failed and the SSH retry "git@github.com:fx/tx.git" failed too: HTTPS refused; SSH refused',
      );
      expect(cause).toBeInstanceOf(AggregateError);
      expect(
        (cause as AggregateError).errors.map(
          (error: Error) => `${error.message}`,
        ),
      ).toEqual(["HTTPS refused", "SSH refused"]);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("omits a source's credentials from every part of the failure", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-secret-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const cloned: string[] = [];
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          const candidate = args[2] as string;
          cloned.push(candidate);
          // Git repeats the clone URL in its own stderr and strips only the
          // password from it, so the token in the user position survives into
          // the message tx would otherwise inline verbatim.
          throw new Error(
            `Git command failed: fatal: unable to access '${candidate.replace(":ghp_SECRET", "")}/': 403`,
          );
        },
      });

      const failure: unknown = await manager
        .add("https://alice:ghp_SECRET@example.com/me/r.git", "secret")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const { message, cause } = failure as Error;
      expect(message).not.toContain("ghp_SECRET");
      expect(message).not.toContain("alice");
      expect(message).toContain('"https://example.com/me/r.git"');
      expect(message).toContain('"git@example.com:me/r.git"');
      expect(message).toContain(
        "unable to access 'https://example.com/me/r.git",
      );
      expect(cause).toBeInstanceOf(AggregateError);
      for (const preserved of (cause as AggregateError).errors as Error[]) {
        expect(preserved.message).not.toContain("ghp_SECRET");
        expect(preserved.message).not.toContain("alice");
      }
      // The derived attempt carries no credential of its own to redact: it is
      // always `git@host:path`, whatever the HTTP(S) source authenticated as.
      expect(cloned).toEqual([
        "https://alice:ghp_SECRET@example.com/me/r.git",
        "git@example.com:me/r.git",
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("omits a token in the username position from a host-only Git failure", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-token-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          if (!(args[2] as string).startsWith("https://")) {
            throw new Error(
              "Git command failed: Permission denied (publickey)",
            );
          }
          // A source with a username and no password leaves Git asking for
          // the password, and with prompts disabled it names the credential
          // through `credential_describe`, which omits the path unless
          // `credential.useHttpPath` is set. The URL it quotes is therefore
          // host-only, and matches no whole-URL spelling of the source.
          throw new Error(
            "Git command failed: fatal: could not read Password for 'https://ghp_REALTOKEN@github.com': terminal prompts disabled",
          );
        },
      });

      const failure: unknown = await manager
        .add("https://ghp_REALTOKEN@github.com/acme/private.git", "private")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const { message, cause } = failure as Error;
      expect(message).not.toContain("ghp_REALTOKEN");
      expect(message).toContain(
        "could not read Password for 'https://github.com'",
      );
      expect(message).toContain('"https://github.com/acme/private.git"');
      expect(message).toContain('"git@github.com:acme/private.git"');
      expect(cause).toBeInstanceOf(AggregateError);
      for (const preserved of (cause as AggregateError).errors as Error[]) {
        expect(preserved.message).not.toContain("ghp_REALTOKEN");
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps a repository name its password also spells intact", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-password-path-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        // Git strips the password component before it quotes the URL back.
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          throw new Error(
            `Git command failed: fatal: unable to access '${(args[2] as string).replace(":tools@", "@")}/': 403`,
          );
        },
      });

      const failure: unknown = await manager
        .add("https://user:tools@github.com/acme/tools.git", "collide")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const { message } = failure as Error;
      expect(message).not.toContain("user@");
      expect(message).not.toContain("user:tools@");
      // A password that is also an ordinary word — a repository name, an org,
      // a deploy password reusing either — must not be taken out of the text
      // around it, or the failure names repositories that do not exist.
      expect(message).toContain(
        "unable to access 'https://github.com/acme/tools.git/'",
      );
      expect(message).toContain(
        "unable to access 'git@github.com:acme/tools.git/'",
      );
      expect(message).toContain('"https://github.com/acme/tools.git"');
      expect(message).toContain('"git@github.com:acme/tools.git"');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps every host intact for a source whose userinfo has no user", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-empty-user-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          // An empty user with the token as the password is a real supported
          // form, and Git drops the whole userinfo when it quotes the URL
          // back — leaving a bare `@` as the only thing a user-derived
          // literal could match.
          throw new Error(
            `Git command failed: fatal: unable to access '${(args[2] as string).replace(":ghp_SECRET@", "")}/': 403`,
          );
        },
      });

      const failure: unknown = await manager
        .add("https://:ghp_SECRET@github.com/acme/tools.git", "emptyuser")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const { message, cause } = failure as Error;
      expect(message).not.toContain("ghp_SECRET");
      // A degenerate literal would be the bare string `@`, which deletes every
      // `@` Git wrote and turns `git@github.com` into a host that does not
      // exist.
      expect(message).toContain(
        "unable to access 'https://github.com/acme/tools.git/'",
      );
      expect(message).toContain(
        "unable to access 'git@github.com:acme/tools.git/'",
      );
      expect(message).toContain('"https://github.com/acme/tools.git"');
      expect(message).toContain('"git@github.com:acme/tools.git"');
      expect(cause).toBeInstanceOf(AggregateError);
      const preserved = ((cause as AggregateError).errors as Error[]).map(
        ({ message: quoted }) => quoted,
      );
      expect(preserved).toEqual([
        "Git command failed: fatal: unable to access 'https://github.com/acme/tools.git/': 403",
        "Git command failed: fatal: unable to access 'git@github.com:acme/tools.git/': 403",
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps every host intact for a source whose userinfo is empty", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-empty-userinfo-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          throw new Error(
            `Git command failed: fatal: unable to access '${args[2] as string}/': 403`,
          );
        },
      });

      const failure: unknown = await manager
        .add("https://@github.com/acme/tools.git", "emptyuserinfo")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const { message, cause } = failure as Error;
      // A wholly empty userinfo carries no credential, so there is nothing to
      // remove and nothing may be removed.
      expect(message).toContain(
        "unable to access 'git@github.com:acme/tools.git/'",
      );
      expect(message).toContain('"https://github.com/acme/tools.git"');
      expect(message).toContain('"git@github.com:acme/tools.git"');
      expect(cause).toBeInstanceOf(AggregateError);
      const preserved = ((cause as AggregateError).errors as Error[]).map(
        ({ message: quoted }) => quoted,
      );
      expect(preserved).toEqual([
        "Git command failed: fatal: unable to access 'https://@github.com/acme/tools.git/': 403",
        "Git command failed: fatal: unable to access 'git@github.com:acme/tools.git/': 403",
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["pa@ss", "ss@example"],
    ["s p", "s p@example"],
  ])(
    "omits a password spelled with %p, which a URL parse would escape",
    async (password, run) => {
      const temporaryRoot = await temporaryDirectory("tx-clone-escaped-");
      try {
        const root = join(temporaryRoot, "marketplaces");
        const source = `https://user:${password}@example.com/me/r.git`;
        const manager = new MarketplaceManager(root, {
          prepare: async () => {},
          // Git is handed the raw source and quotes it back raw, escaping
          // nothing, so the credential reaches stderr exactly as it was typed.
          runGit: async (args) => {
            if (readsSshCommand(args)) unsetSshCommand();
            throw new Error(
              `Git command failed: fatal: unable to access '${args[2] as string}/': 403`,
            );
          },
        });

        const failure: unknown = await manager
          .add(source, "escaped")
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        const { message, cause } = failure as Error;
        expect(message).not.toContain(password);
        expect(message).not.toContain(run);
        expect(message).toContain('"https://example.com/me/r.git"');
        expect(message).toContain('"git@example.com:me/r.git"');
        expect(cause).toBeInstanceOf(AggregateError);
        for (const preserved of (cause as AggregateError).errors as Error[]) {
          expect(preserved.message).not.toContain(password);
          expect(preserved.message).not.toContain(run);
        }
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ["https://git:tok@github.com/acme/tools.git", "github.com/acme/tools.git"],
    ["https://me:tok@example.com/me/r.git", "example.com/me/r.git"],
  ])(
    "keeps %p intact when its username also spells host or path text",
    async (source, repository) => {
      const temporaryRoot = await temporaryDirectory("tx-clone-collide-");
      try {
        const root = join(temporaryRoot, "marketplaces");
        const manager = new MarketplaceManager(root, {
          prepare: async () => {},
          runGit: async (args) => {
            if (readsSshCommand(args)) unsetSshCommand();
            throw new Error(
              `Git command failed: fatal: unable to access '${args[2] as string}/': 403`,
            );
          },
        });

        const failure: unknown = await manager
          .add(source, "collide")
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        const { message } = failure as Error;
        // The username is an identifier, not the secret: taking it out as a
        // substring would rewrite the host and the path around it.
        expect(message).not.toContain("tok");
        expect(message).toContain(`https://${repository}`);
        expect(message).toContain(
          `"git@${repository.replace("/", ":")}" failed too`,
        );
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  test("leaves an account name spelled without its userinfo run", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-bare-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          if (!(args[2] as string).startsWith("https://")) {
            throw new Error(
              "Git command failed: Permission denied (publickey)",
            );
          }
          throw new Error(
            "Git command failed: remote: HTTP Basic: Access denied for user alice\nfatal: Authentication failed for 'https://alice@example.com/me/r.git/'",
          );
        },
      });

      const failure: unknown = await manager
        .add("https://alice:ghp_LOOSE@example.com/me/r.git", "bare")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const { message, cause } = failure as Error;
      expect(message).not.toContain("ghp_LOOSE");
      expect(message).not.toContain("alice@");
      expect(message).toContain(
        "Authentication failed for 'https://example.com/me/r.git/'",
      );
      // Accepted and documented: a userinfo user a server message spells
      // without its `@` stays. Deleting a bare identifier is what rewrites the
      // text around it and fabricates sources the user never typed, and the
      // password is covered regardless, because Git never spells one outside
      // a userinfo run.
      expect(message).toContain("Access denied for user alice");
      expect(cause).toBeInstanceOf(AggregateError);
      for (const preserved of (cause as AggregateError).errors as Error[]) {
        expect(preserved.message).not.toContain("alice@");
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps the derived SSH name intact when the source's user is git", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-git-user-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          throw new Error(
            `Git command failed: fatal: unable to access '${args[2] as string}/': 403`,
          );
        },
      });

      const failure: unknown = await manager
        .add("https://git:tok@github.com/acme/tools.git", "gituser")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const { message } = failure as Error;
      expect(message).not.toContain("tok");
      // The names the failure reports are composed from the source rather
      // than scrubbed, so no removal can reach them.
      expect(message).toContain(
        'Cloning "https://github.com/acme/tools.git" failed and the SSH retry "git@github.com:acme/tools.git" failed too',
      );
      // `git` is a real HTTPS username (Gitea, GitLab deploy tokens), so
      // `git@` is a userinfo run to remove — and it is also how Git spells the
      // derived candidate in its own quoted output. Losing it there is
      // cosmetic and confined to text Git quoted.
      expect(message).toContain(
        "unable to access 'github.com:acme/tools.git/'",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("stages every attempt in its own empty directory", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-staging-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const stagings: string[] = [];
      const manager = new MarketplaceManager(root, {
        prepare: async () => {},
        runGit: async (args) => {
          if (readsSshCommand(args)) unsetSshCommand();
          const staging = args.at(-1) as string;
          if ((args[2] as string).startsWith("https://")) {
            stagings.push(staging);
            // A failed clone can leave a partial checkout behind, and
            // `git clone` refuses a destination that is not empty.
            await writeFile(join(staging, "partial.txt"), "partial");
            throw new Error("Authentication failed");
          }
          expect(staging).not.toBe(stagings[0]);
          expect(await readdir(staging)).toEqual([]);
          stagings.push(staging);
          await writeFile(join(staging, "clone.txt"), "clone");
          return { stdout: "" };
        },
      });

      expect(await manager.add("fx/tx", "fresh")).toEqual({
        name: "fresh",
        source: "fx/tx",
      });
      expect(stagings).toHaveLength(2);
      expect(await readdir(root)).toEqual(["fresh"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("walks away from a staging directory it cannot remove", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-discard-");
    try {
      const file = join(temporaryRoot, "file");
      await writeFile(file, "");
      // A path whose parent is a regular file. `rm` rejects it with ENOTDIR,
      // which `force: true` does not suppress — it suppresses only ENOENT.
      // ENOTDIR is a property of the path rather than of the process, so the
      // refusal reproduces identically for root and for everyone else, unlike
      // a permission bit root simply ignores.
      const staging = join(file, "child");
      await expect(
        rm(staging, { recursive: true, force: true }),
      ).rejects.toHaveProperty("code", "ENOTDIR");

      // Swallowed: a leftover directory must never become the failure the
      // caller reads, nor abort the attempt that follows.
      expect(await discardStaging(staging)).toBeUndefined();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps a configured GIT_SSH_COMMAND and never probes Git configuration", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-ssh-command-");
    try {
      const { calls, add } = recordingManager(temporaryRoot, {
        GIT_SSH_COMMAND: "ssh -i /keys/id",
      });

      expect(await add("keyed")).toEqual({ name: "keyed", source: "fx/tx" });
      expect(calls.map(({ args }) => args[0])).toEqual(["clone", "clone"]);
      expect(calls.map(({ env }) => env)).toEqual([
        { GIT_SSH_COMMAND: "ssh -i /keys/id", GIT_TERMINAL_PROMPT: "0" },
        { GIT_SSH_COMMAND: "ssh -i /keys/id", GIT_TERMINAL_PROMPT: "0" },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps a configured GIT_SSH, which Git honours as well", async () => {
    const temporaryRoot = await temporaryDirectory("tx-clone-ssh-wrapper-");
    try {
      const { calls, add } = recordingManager(temporaryRoot, {
        GIT_SSH: "/usr/local/bin/ssh-wrapper",
      });

      expect(await add("wrapped")).toEqual({
        name: "wrapped",
        source: "fx/tx",
      });
      expect(calls.map(({ args }) => args[0])).toEqual(["clone", "clone"]);
      expect(calls.map(({ env }) => env)).toEqual([
        { GIT_SSH: "/usr/local/bin/ssh-wrapper", GIT_TERMINAL_PROMPT: "0" },
        { GIT_SSH: "/usr/local/bin/ssh-wrapper", GIT_TERMINAL_PROMPT: "0" },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test.each<[string, readonly string[]]>([
    ["--global", ["--global"]],
    ["--system", ["--global", "--system"]],
  ])(
    "keeps an SSH command configured through core.sshCommand in %s",
    async (scope, read) => {
      const temporaryRoot = await temporaryDirectory("tx-clone-ssh-config-");
      try {
        const { calls, add } = recordingManager(
          temporaryRoot,
          { PATH: "/test/bin" },
          // Configured in one scope only, so reading the wrong scope, or the
          // right ones in the wrong order, shows up in the recorded calls.
          async (args) =>
            args.includes(scope)
              ? { stdout: "ssh -i /run/secrets/deploy_key\n" }
              : { stdout: "" },
        );

        expect(await add("deployed")).toEqual({
          name: "deployed",
          source: "fx/tx",
        });
        // `--local` is deliberately absent: `git clone` never applies the
        // configuration of the repository the caller is standing in, so
        // reading it would suppress batch mode for a command the clone
        // cannot use.
        expect(calls.map(({ args }) => args)).toEqual([
          ...read.map((probed) => [
            "config",
            probed,
            "--get",
            "core.sshCommand",
          ]),
          ["clone", "--", "https://github.com/fx/tx.git", expect.any(String)],
          ["clone", "--", "git@github.com:fx/tx.git", expect.any(String)],
        ]);
        expect(calls.map(({ env }) => env)).toEqual([
          ...read.map(() => ({ PATH: "/test/bin" })),
          { PATH: "/test/bin", GIT_TERMINAL_PROMPT: "0" },
          { PATH: "/test/bin", GIT_TERMINAL_PROMPT: "0" },
        ]);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  test.each<[string, RunGit]>([
    [
      "is unset",
      async () => {
        throw new Error("Git command failed");
      },
    ],
    ["is empty", async () => ({ stdout: "  \n" })],
  ])(
    "puts every clone attempt in batch mode when core.sshCommand %s",
    async (_case, probe) => {
      const temporaryRoot = await temporaryDirectory("tx-clone-batch-");
      try {
        const { calls, add } = recordingManager(
          temporaryRoot,
          { PATH: "/test/bin" },
          probe,
        );

        expect(await add("batched")).toEqual({
          name: "batched",
          source: "fx/tx",
        });
        // The first attempt is in batch mode too. An `insteadOf` rule can
        // rewrite its HTTP(S) source to SSH before Git dials, and ssh(1)
        // prompts for an unknown host key on `/dev/tty` whatever
        // `GIT_TERMINAL_PROMPT` says — which would hang the command before
        // any retry could run.
        const batched = {
          PATH: "/test/bin",
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        };
        expect(calls.map(({ env }) => env)).toEqual([
          { PATH: "/test/bin" },
          { PATH: "/test/bin" },
          batched,
          batched,
        ]);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  test.each<[string, Readonly<Record<string, string>>]>([
    [
      "names it",
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        GIT_CONFIG_VALUE_0: "ssh -i /run/secrets/deploy_key",
      },
    ],
    [
      "names it in another case, among other entries",
      {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "ci",
        GIT_CONFIG_KEY_1: "CORE.SSHCOMMAND",
        GIT_CONFIG_VALUE_1: "ssh -i /run/secrets/deploy_key",
      },
    ],
  ])(
    "keeps an SSH command the environment's Git configuration %s",
    async (_case, configured) => {
      const temporaryRoot = await temporaryDirectory(
        "tx-clone-ssh-env-config-",
      );
      try {
        const env = { PATH: "/test/bin", ...configured };
        const { calls, add } = recordingManager(temporaryRoot, env);

        expect(await add("commanded")).toEqual({
          name: "commanded",
          source: "fx/tx",
        });
        // Command scope is the one scope beyond the global and system files
        // that a clone applies, and it outranks both, so nothing is probed
        // and nothing is injected over it.
        expect(calls.map(({ args }) => args[0])).toEqual(["clone", "clone"]);
        expect(calls.map(({ env: passed }) => passed)).toEqual([
          { ...env, GIT_TERMINAL_PROMPT: "0" },
          { ...env, GIT_TERMINAL_PROMPT: "0" },
        ]);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  test.each<[string, Readonly<Record<string, string>>]>([
    [
      "names another variable",
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.sshCommandTimeout",
        GIT_CONFIG_VALUE_0: "ssh -i /run/secrets/deploy_key",
      },
    ],
    [
      "leaves the value empty",
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        GIT_CONFIG_VALUE_0: "",
      },
    ],
    [
      "leaves the value blank",
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        GIT_CONFIG_VALUE_0: "  ",
      },
    ],
    [
      "counts its entries with something that is not a number",
      {
        GIT_CONFIG_COUNT: "many",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        GIT_CONFIG_VALUE_0: "ssh -i /run/secrets/deploy_key",
      },
    ],
    [
      "counts its entries with a fraction",
      {
        GIT_CONFIG_COUNT: "1.5",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        GIT_CONFIG_VALUE_0: "ssh -i /run/secrets/deploy_key",
      },
    ],
    [
      "counts fewer entries than it supplies",
      {
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        GIT_CONFIG_VALUE_0: "ssh -i /run/secrets/deploy_key",
      },
    ],
  ])(
    "puts every clone attempt in batch mode when the environment %s",
    async (_case, configured) => {
      const temporaryRoot = await temporaryDirectory("tx-clone-ssh-env-none-");
      try {
        const env = { PATH: "/test/bin", ...configured };
        const { calls, add } = recordingManager(temporaryRoot, env);

        expect(await add("batched")).toEqual({
          name: "batched",
          source: "fx/tx",
        });
        // Nothing is configured, so the two scoped files are still asked.
        expect(calls.map(({ args }) => args[0])).toEqual([
          "config",
          "config",
          "clone",
          "clone",
        ]);
        const batched = {
          ...env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        };
        expect(calls.map(({ env: passed }) => passed)).toEqual([
          env,
          env,
          batched,
          batched,
        ]);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );
});

/**
 * A manager whose HTTP(S) clone always fails, so the derived SSH attempt is
 * reached, recording the arguments and environment of every Git call. `probe`
 * answers anything that is not a clone, which is how a test decides what
 * `git config --get core.sshCommand` reports in each scope it is asked for.
 * It defaults to throwing, the way `git config --get` reports a variable that
 * is not set, so nothing here reports an SSH command by accident.
 */
function recordingManager(
  parent: string,
  env: Readonly<Record<string, string | undefined>>,
  probe: RunGit = async () => {
    throw new Error("Git command failed");
  },
): {
  readonly calls: readonly {
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
  }[];
  readonly add: (name: string) => ReturnType<MarketplaceManager["add"]>;
} {
  const calls: {
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
  }[] = [];
  const manager = new MarketplaceManager(join(parent, "marketplaces"), {
    env,
    prepare: async () => {},
    runGit: async (args, options) => {
      calls.push({ args: [...args], env: options.env });
      if (args[0] !== "clone") return probe(args, options);
      if ((args[2] as string).startsWith("https://")) {
        throw new Error("Authentication failed");
      }
      await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
      return { stdout: "" };
    },
  });
  return { calls, add: (name) => manager.add("fx/tx", name) };
}

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
          if (readsSshCommand(args)) unsetSshCommand();
          cloned.push(args[2] as string);
          await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
          return { stdout: "" };
        },
      });

      // A directory whose name reads as SCP-style syntax to Git reads that way
      // here too, and stays reachable as a local source by a path.
      const colon = await createLocalSource(temporaryRoot, "host:path");

      expect(await manager.add(source)).toEqual({ name: "tools", source });
      expect(await manager.add("git@example.com:me/scp.git")).toEqual({
        name: "scp",
        source: "git@example.com:me/scp.git",
      });
      expect(await manager.add("ssh://git@example.com/me/remote.git")).toEqual({
        name: "remote",
        source: "ssh://example.com/me/remote.git",
      });
      expect(await manager.add("owner/absent")).toEqual({
        name: "absent",
        source: "owner/absent",
      });
      expect(await manager.add("host:path", "colon-remote")).toEqual({
        name: "colon-remote",
        source: "host:path",
      });
      expect(await manager.add("./host:path", "colon-local")).toEqual({
        name: "colon-local",
        source: colon,
      });

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

      expect(await manager.add("tools")).toEqual({ name: "tools", source });
      expect(prepared).toEqual([source]);
      const target = join(root, "tools");
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
      expect(await readlink(target)).toBe(source);
      expect(await manager.list()).toEqual([
        { name: "tools", source, version: "live" },
      ]);
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
          if (readsSshCommand(args)) unsetSshCommand();
          cloned.push(args[2] as string);
          await writeFile(join(args.at(-1) as string, "clone.txt"), "clone");
          return { stdout: "" };
        },
      });

      expect(await manager.add("owner/repository")).toEqual({
        name: "repository",
        source,
      });
      expect(await readlink(join(root, "repository"))).toBe(source);
      expect(cloned).toEqual([]);

      // The remote of the same spelling stays reachable by its full URL.
      expect(
        await manager.add("https://github.com/owner/repository.git", "remote"),
      ).toEqual({
        name: "remote",
        source: "https://github.com/owner/repository.git",
      });
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

      expect(await managerIn(join(temporaryRoot, "tools")).add(".")).toEqual({
        name: "tools",
        source: join(temporaryRoot, "tools"),
      });
      await managerIn(temporaryRoot).remove("tools");
      expect(await managerIn(temporaryRoot).add("tools/")).toEqual({
        name: "tools",
        source: join(temporaryRoot, "tools"),
      });
      // A directory named tools.git is called that; only a Git URL drops it.
      expect(await managerIn(temporaryRoot).add("legacy.git")).toEqual({
        name: "legacy.git",
        source: join(temporaryRoot, "legacy.git"),
      });
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

      expect(await manager.add("tools")).toEqual({ name: "tools", source });
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

      expect(await manager.add("current/repo", "pinned")).toEqual({
        name: "pinned",
        source: first,
      });
      await rm(current);
      await symlink(join(temporaryRoot, "second"), current);

      const target = join(root, "pinned");
      expect(await readlink(target)).toBe(first);
      expect((await readMarketplaceManifest(target)).plugins[0]?.name).toBe(
        "first",
      );
      expect(await manager.list()).toEqual([
        { name: "pinned", source: first, version: "live" },
      ]);
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
          return {
            stdout: args.includes("describe")
              ? "v3.1.0\n"
              : "ssh://example/cloned.git\n",
          };
        },
      });

      expect(await manager.list()).toEqual([
        {
          name: "cloned",
          source: "ssh://example/cloned.git",
          version: "v3.1.0",
        },
        { name: "dangling", source: missing, version: "live" },
        { name: "linked", source, version: "live" },
        { name: "replaced", source: replacement, version: "live" },
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
