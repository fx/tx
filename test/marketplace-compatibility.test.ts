import { describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CoreDependencies } from "@fx/tx/plugin";
import { createMarketplacePlugin } from "../plugins/marketplace/index.ts";
import {
  MarketplaceManager,
  planMarketplaceManifestAtRevision,
  runGit,
} from "../plugins/marketplace/manager.ts";
import {
  MarketplaceManifestContentError,
  parseMarketplaceManifestDocument,
  planMarketplaceManifest,
  readMarketplaceManifest,
} from "../plugins/marketplace/storage.ts";
import updatePlugin from "../plugins/update/index.ts";
import { main } from "../src/cli.ts";
import { EXIT_FAILURE, EXIT_SUCCESS } from "../src/commands.ts";
import { coreDependencies } from "../src/plugins.ts";
import {
  captureContext,
  commitFixtureFiles,
  createGitRepository,
  fixtureGit,
  temporaryDirectory,
  writeFixtureFiles,
} from "./helpers.ts";

const manifestFile = ".tx/config.json";
const plugins = [{ name: "tools", entry: "plugin.ts" }];
const ref40 = "0123456789abcdef0123456789abcdef01234567";
const ref64 = `${ref40}0123456789abcdef01234567`;

function parse(document: Record<string, unknown>) {
  return parseMarketplaceManifestDocument(
    "/checkout",
    manifestFile,
    JSON.stringify({ plugins, ...document }),
  );
}

function release(overrides: Record<string, unknown> = {}) {
  return { version: "1.4.0", ref: ref40, tx: "^1.0.0", ...overrides };
}

function withoutKey(key: string) {
  return Object.fromEntries(
    Object.entries(release()).filter(([name]) => name !== key),
  );
}

describe("marketplace compatibility fields", () => {
  test.each([
    ["every field absent", {}, {}],
    ["a version", { version: "1.4.0" }, { version: "1.4.0" }],
    [
      "a pre-release version with build metadata",
      { version: "1.4.0-rc.1+build.7" },
      { version: "1.4.0-rc.1+build.7" },
    ],
    ["a range", { tx: "^1.8.0" }, { tx: "^1.8.0" }],
    ["the any range", { tx: "*" }, { tx: "*" }],
    ["an empty history", { versions: [] }, { versions: [] }],
    [
      "a history naming 40- and 64-character commits",
      {
        versions: [
          release(),
          release({ version: "1.5.0", ref: ref64, tx: ">=1.8.0 <3" }),
        ],
      },
      {
        versions: [
          release(),
          release({ version: "1.5.0", ref: ref64, tx: ">=1.8.0 <3" }),
        ],
      },
    ],
    [
      "a release and its pre-release",
      { versions: [release(), release({ version: "1.4.0-rc.1" })] },
      { versions: [release(), release({ version: "1.4.0-rc.1" })] },
    ],
    [
      "unknown keys at both levels",
      {
        homepage: "ignored",
        versions: [{ ...release(), notes: "ignored" }],
      },
      { versions: [release()] },
    ],
  ])("accepts %s", (_label, document, declared) => {
    expect(parse(document)).toEqual({ plugins, ...declared });
  });

  test.each([
    ["version of the wrong type", { version: 1 }, "version must be a string"],
    ["a null version", { version: null }, "version must be a string"],
    [
      "a malformed version",
      { version: "1.4" },
      'version "1.4" must be a semantic version, such as 1.4.0, without a "v" prefix',
    ],
    [
      "a v-prefixed version",
      { version: "v1.4.0" },
      'version "v1.4.0" must be a semantic version',
    ],
    ["tx of the wrong type", { tx: 2 }, "tx must be a string"],
    ["an empty tx", { tx: "" }, "tx must not be empty"],
    ["a whitespace-only tx", { tx: "  \t" }, "tx must not be empty"],
    [
      "a malformed tx",
      { tx: "^1.0.0 garbage" },
      'tx "^1.0.0 garbage" is not a valid version range',
    ],
    [
      "a comma-separated tx",
      { tx: ">=1.0.0, <2" },
      'tx ">=1.0.0, <2" is not a valid version range',
    ],
    [
      "versions of the wrong type",
      { versions: {} },
      "versions must be an array",
    ],
    [
      "a versions element of the wrong type",
      { versions: [release(), "1.5.0"] },
      "versions element 2 must be an object",
    ],
    [
      "an element missing its version",
      { versions: [release({ version: "1.3.0" }), withoutKey("version")] },
      "versions element 2 version is required",
    ],
    [
      "an element missing its ref",
      { versions: [withoutKey("ref")] },
      "versions element 1 ref is required",
    ],
    [
      "an element missing its tx",
      { versions: [withoutKey("tx")] },
      "versions element 1 tx is required",
    ],
    [
      "an element version of the wrong type",
      { versions: [release({ version: 140 })] },
      "versions element 1 version must be a string",
    ],
    [
      "a malformed element version",
      { versions: [release({ version: "1.4.0.1" })] },
      'versions element 1 version "1.4.0.1" must be a semantic version',
    ],
    [
      "a v-prefixed element version",
      { versions: [release({ version: "v1.4.0" })] },
      'versions element 1 version "v1.4.0" must be a semantic version',
    ],
    [
      "an element ref of the wrong type",
      { versions: [release({ ref: 1234567 })] },
      "versions element 1 ref must be a commit's full object name in lowercase hexadecimal, 40 or 64 characters long",
    ],
    [
      "an abbreviated ref",
      { versions: [release({ ref: ref40.slice(0, 12) })] },
      "versions element 1 ref must be a commit's full object name",
    ],
    [
      "an uppercase ref",
      { versions: [release({ ref: ref40.toUpperCase() })] },
      "versions element 1 ref must be a commit's full object name",
    ],
    [
      "a non-hexadecimal ref",
      { versions: [release({ ref: `${ref40.slice(0, 39)}g` })] },
      "versions element 1 ref must be a commit's full object name",
    ],
    [
      "a tag as ref",
      { versions: [release({ ref: "v1.4.0" })] },
      "versions element 1 ref must be a commit's full object name",
    ],
    [
      "a 41-character ref",
      { versions: [release({ ref: `${ref40}0` })] },
      "versions element 1 ref must be a commit's full object name",
    ],
    [
      "an element tx of the wrong type",
      { versions: [release({ tx: ["^1.0.0"] })] },
      "versions element 1 tx must be a string",
    ],
    [
      "an empty element tx",
      { versions: [release({ tx: "" })] },
      "versions element 1 tx must not be empty",
    ],
    [
      "a whitespace-only element tx",
      { versions: [release({ tx: " " })] },
      "versions element 1 tx must not be empty",
    ],
    [
      "a malformed element tx",
      { versions: [release({ tx: "latest" })] },
      'versions element 1 tx "latest" is not a valid version range',
    ],
    [
      "duplicate versions",
      { versions: [release(), release({ ref: ref64 })] },
      'versions element 2 version "1.4.0" duplicates the version of element 1',
    ],
    [
      "versions differing only in build metadata",
      {
        versions: [
          release({ version: "1.3.0" }),
          release({ version: "1.4.0+a" }),
          release({ version: "1.4.0+b" }),
        ],
      },
      'versions element 3 version "1.4.0+b" duplicates the version of element 2',
    ],
  ])("rejects %s", (_label, document, message) => {
    let failure: unknown;
    try {
      parse(document);
    } catch (error) {
      failure = error;
    }
    // A content failure: no retrieval of more of the tree can change it.
    expect(failure).toBeInstanceOf(MarketplaceManifestContentError);
    expect((failure as Error).message).toStartWith(`${manifestFile} `);
    expect((failure as Error).message).toContain(message);
  });

  test("reads the fields from the selected manifest only", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-manifest-");
    try {
      const both = join(temporaryRoot, "both");
      const legacy = join(temporaryRoot, "legacy");
      await writeFixtureFiles(both, {
        "plugin.ts": "export default () => {};\n",
        [manifestFile]: JSON.stringify({ plugins, version: "1.5.0" }),
        "tx.marketplace.json": JSON.stringify({
          plugins,
          version: "9.9.9",
          tx: "^9.0.0",
        }),
      });
      await writeFixtureFiles(legacy, {
        "plugin.ts": "export default () => {};\n",
        "tx.marketplace.json": JSON.stringify({
          plugins,
          tx: "^1.8.0",
          versions: [release()],
        }),
      });

      expect(await planMarketplaceManifest(both)).toEqual({
        plugins,
        version: "1.5.0",
      });
      const resolved = await readMarketplaceManifest(legacy);
      expect(resolved.tx).toBe("^1.8.0");
      expect(resolved.versions).toEqual([release()]);
      expect(resolved.version).toBeUndefined();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("validates the fields of an update's target commit", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-revision-");
    try {
      const repository = await createGitRepository(temporaryRoot, "remote", {
        "plugin.ts": "export default () => {};\n",
        [manifestFile]: JSON.stringify({ plugins, tx: "^1.8.0" }),
      });
      const valid = fixtureGit(repository, ["rev-parse", "HEAD"]);
      const invalid = await commitFixtureFiles(
        repository,
        {
          [manifestFile]: JSON.stringify({
            plugins,
            versions: [release({ ref: ref40.slice(0, 7) })],
          }),
        },
        "abbreviate a ref",
      );
      const execution = { runGit, env: process.env };

      expect(
        await planMarketplaceManifestAtRevision(repository, valid, execution),
      ).toEqual({ plugins, tx: "^1.8.0" });
      await expect(
        planMarketplaceManifestAtRevision(repository, invalid, execution),
      ).rejects.toThrow(
        `${manifestFile} versions element 1 ref must be a commit's full object name`,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("fails an addition whose manifest declares a malformed range and publishes nothing", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-add-");
    try {
      const repository = await createGitRepository(temporaryRoot, "tools", {
        "plugin.ts": "export default () => {};\n",
        [manifestFile]: JSON.stringify({ plugins, tx: "^1.0.0 garbage" }),
      });
      const root = join(temporaryRoot, "marketplaces");
      let prepared = false;
      const manager = new MarketplaceManager(root, {
        // The override governs loading only; it cannot make a manifest valid.
        env: { ...process.env, TX_IGNORE_COMPATIBILITY: "1" },
        prepare: async () => {
          prepared = true;
        },
      });

      await expect(manager.add(pathToFileURL(repository).href)).rejects.toThrow(
        'tx "^1.0.0 garbage" is not a valid version range',
      );
      expect(prepared).toBe(false);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function dependencies(version: string): CoreDependencies {
  return { ...coreDependencies, tx: { version } };
}

/**
 * A plugin whose import leaves a file behind, so a test can tell whether
 * refusing a marketplace happened before or after its entry was imported.
 */
function pluginSource(name: string, marker: string): string {
  return `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export default ({ command, context }) => {
  command((namespace) =>
    namespace.command("run").action(() => context.stdout.write("${name}\\n")),
  );
};
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface Installed {
  readonly temporaryRoot: string;
  readonly root: string;
}

/** The file a fixture plugin's import leaves behind. */
function marker(installed: Installed, name: string): string {
  return join(installed.temporaryRoot, `${name}.imported`);
}

/**
 * Installs `tools`, a clone of a local repository tagged `v1.0.0`, and every
 * other named marketplace as a live reference to a directory, each declaring
 * the given range or none.
 */
async function install(
  temporaryRoot: string,
  marketplaces: Readonly<Record<string, string | undefined>>,
): Promise<Installed> {
  const root = join(temporaryRoot, "marketplaces");
  await mkdir(root, { recursive: true });
  const installed = { temporaryRoot, root };
  for (const [name, tx] of Object.entries(marketplaces)) {
    const files = {
      "plugin.ts": pluginSource(name, marker(installed, name)),
      [manifestFile]: JSON.stringify({
        plugins: [{ name, entry: "plugin.ts" }],
        ...(tx === undefined ? {} : { tx }),
      }),
    };
    if (name === "tools") {
      const remote = await createGitRepository(temporaryRoot, "remote", files);
      fixtureGit(remote, ["tag", "v1.0.0"]);
      fixtureGit(temporaryRoot, [
        "clone",
        "--quiet",
        "--",
        pathToFileURL(remote).href,
        join(root, name),
      ]);
    } else {
      const source = join(temporaryRoot, "sources", name);
      await writeFixtureFiles(source, files);
      await symlink(source, join(root, name));
    }
  }
  return installed;
}

async function run(
  installed: Installed,
  argv: readonly string[],
  options: {
    readonly env?: Record<string, string | undefined>;
    readonly txVersion?: string;
  } = {},
) {
  const context = captureContext(options.env ?? {});
  const exitCode = await main(
    argv,
    [createMarketplacePlugin({ root: installed.root }), updatePlugin],
    context,
    dependencies(options.txVersion ?? "1.8.0"),
  );
  return {
    exitCode,
    stdout: context.stdoutText(),
    stderr: context.stderrText(),
  };
}

const clonedRefusal =
  'Error loading plugin marketplace/installed/tools: Marketplace "tools" supports tx ^2.0.0, not tx 1.8.0. Run "tx update" to update tx and its marketplaces, pin a version that supports tx 1.8.0 with "tx marketplace pin tools <ref>", or set TX_IGNORE_COMPATIBILITY=1 to load it anyway.\n';

describe("loading an incompatible marketplace", () => {
  test("refuses it in isolation, before importing any of its entries", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-refuse-");
    try {
      const installed = await install(temporaryRoot, {
        tools: "^2.0.0",
        other: undefined,
      });

      const result = await run(installed, ["other", "run"]);

      expect(result).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: "other\n",
        stderr: clonedRefusal,
      });
      expect(result.stderr).not.toContain("marketplace remove");
      expect(await exists(marker(installed, "tools"))).toBe(false);
      expect(await exists(marker(installed, "other"))).toBe(true);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps the management commands and the update participant", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-manage-");
    try {
      const installed = await install(temporaryRoot, { tools: "^2.0.0" });

      expect(await run(installed, ["update", "--dry-run"])).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: "tools\tv1.0.0\tup to date\n",
        stderr: clonedRefusal,
      });
      const listed = await run(installed, ["marketplace", "list"]);
      expect(listed.exitCode).toBe(EXIT_SUCCESS);
      expect(listed.stdout).toStartWith("tools\tv1.0.0\t");
      expect(await exists(marker(installed, "tools"))).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("refuses a pinned clone and a live reference alike", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-kinds-");
    try {
      const installed = await install(temporaryRoot, {
        tools: "^2.0.0",
        linked: "^2.0.0",
      });
      fixtureGit(join(installed.root, "tools"), [
        "config",
        "--local",
        "tx.pin",
        "v1.0.0",
      ]);

      const result = await run(installed, ["tools", "run"]);

      expect(result.exitCode).toBe(EXIT_FAILURE);
      expect(result.stdout).toBe("");
      // A reference has nothing to update or pin; only the override applies.
      expect(result.stderr).toStartWith(
        `Error loading plugin marketplace/installed/linked: Marketplace "linked" supports tx ^2.0.0, not tx 1.8.0. Set TX_IGNORE_COMPATIBILITY=1 to load it anyway.\n${clonedRefusal}`,
      );
      expect(result.stderr).toEndWith(
        'Error: Unknown command "tools". Run "tx --help" for usage.\n',
      );
      expect(await exists(marker(installed, "tools"))).toBe(false);
      expect(await exists(marker(installed, "linked"))).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("loads it with one warning line when TX_IGNORE_COMPATIBILITY is 1", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-override-");
    try {
      const installed = await install(temporaryRoot, {
        tools: "^2.0.0",
        other: "^1.0.0",
      });

      expect(
        await run(installed, ["tools", "run"], {
          env: { TX_IGNORE_COMPATIBILITY: "1" },
        }),
      ).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: "tools\n",
        stderr:
          'Warning: loading marketplace "tools", which supports tx ^2.0.0, under tx 1.8.0 because TX_IGNORE_COMPATIBILITY=1.\n',
      });
      expect(await exists(marker(installed, "tools"))).toBe(true);
      const compatible = await run(installed, ["other", "run"], {
        env: { TX_IGNORE_COMPATIBILITY: "1" },
      });
      expect(compatible.stdout).toBe("other\n");
      expect(compatible.stderr.match(/^Warning:/gm)).toHaveLength(1);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["true", { TX_IGNORE_COMPATIBILITY: "true" }],
    ["0", { TX_IGNORE_COMPATIBILITY: "0" }],
    ["an empty value", { TX_IGNORE_COMPATIBILITY: "" }],
    ["an unset variable", {}],
  ])("keeps refusing it for %s", async (_label, env) => {
    const temporaryRoot = await temporaryDirectory("tx-compat-values-");
    try {
      const installed = await install(temporaryRoot, { tools: "^2.0.0" });

      const result = await run(installed, ["tools", "run"], { env });

      expect(result.exitCode).toBe(EXIT_FAILURE);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith(clonedRefusal);
      expect(result.stderr).not.toContain("Warning:");
      expect(await exists(marker(installed, "tools"))).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports a malformed range as an invalid manifest, override or not", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-invalid-");
    try {
      const installed = await install(temporaryRoot, {
        broken: "^1.0.0 garbage",
      });

      for (const env of [{}, { TX_IGNORE_COMPATIBILITY: "1" }]) {
        const result = await run(installed, ["broken", "run"], { env });
        expect(result.exitCode).toBe(EXIT_FAILURE);
        expect(result.stderr).toStartWith(
          'Error loading plugin marketplace/installed/broken: Marketplace "broken" failed: .tx/config.json tx "^1.0.0 garbage" is not a valid version range. Run "tx marketplace remove broken" to remove it.\n',
        );
        expect(await exists(marker(installed, "broken"))).toBe(false);
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("matches a pre-release tx by the pre-release rule", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-prerelease-");
    try {
      const installed = await install(temporaryRoot, {
        candidate: "^2.0.0-rc.0",
        stable: ">=1.0.0",
        undeclared: undefined,
      });
      const options = { txVersion: "2.0.0-rc.1" };

      expect(await run(installed, ["candidate", "run"], options)).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: "candidate\n",
        stderr:
          'Error loading plugin marketplace/installed/stable: Marketplace "stable" supports tx >=1.0.0, not tx 2.0.0-rc.1. Set TX_IGNORE_COMPATIBILITY=1 to load it anyway.\n',
      });
      // No range at all is compatible with every tx, pre-releases included.
      const undeclared = await run(installed, ["undeclared", "run"], options);
      expect(undeclared.exitCode).toBe(EXIT_SUCCESS);
      expect(undeclared.stdout).toBe("undeclared\n");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("listing declared versions", () => {
  test("reports each manifest's declared version after the source, offline", async () => {
    const temporaryRoot = await temporaryDirectory("tx-compat-list-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const entry = { "plugin.ts": "export default () => {};\n" };
      await writeFixtureFiles(join(root, "cloned"), {
        ...entry,
        [manifestFile]: JSON.stringify({ plugins, version: "1.5.0" }),
      });
      await writeFixtureFiles(join(root, "undeclared"), {
        ...entry,
        [manifestFile]: JSON.stringify({ plugins }),
      });
      await writeFixtureFiles(join(root, "unreadable"), {
        ...entry,
        [manifestFile]: "{ not json",
      });
      const source = join(temporaryRoot, "source");
      await writeFixtureFiles(source, {
        ...entry,
        [manifestFile]: JSON.stringify({ plugins, version: "2.0.0-rc.1" }),
      });
      await symlink(source, join(root, "linked"));
      const calls: string[] = [];
      const manager = new MarketplaceManager(root, {
        runGit: async (args) => {
          calls.push(args.slice(2).join(" "));
          return {
            stdout: args.includes("describe")
              ? "v1.0.0\n"
              : "ssh://example/tools.git\n",
          };
        },
      });

      const context = captureContext();
      expect(
        await main(
          ["marketplace", "list"],
          [createMarketplacePlugin({ manager, root })],
          context,
        ),
      ).toBe(EXIT_SUCCESS);
      expect(context.stdoutText()).toBe(
        [
          "cloned\tv1.0.0\tssh://example/tools.git\t1.5.0",
          `linked\tlive\t${source}\t2.0.0-rc.1`,
          "undeclared\tv1.0.0\tssh://example/tools.git\t-",
          "unreadable\tv1.0.0\tssh://example/tools.git\t-",
          "",
        ].join("\n"),
      );
      // The declared version is read from disk: Git is asked only for the
      // label and the source, and never to reach a remote.
      expect(new Set(calls)).toEqual(
        new Set([
          "config --get remote.origin.url",
          "describe --tags --always HEAD",
        ]),
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
