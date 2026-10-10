import { describe, expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "@fx/tx/config";
import type { CoreDependencies, PluginDefinition } from "@fx/tx/plugin";
import { createMarketplacePlugin } from "../plugins/marketplace/index.ts";
import { MarketplaceManager } from "../plugins/marketplace/manager.ts";
import { MarketplaceUpdater } from "../plugins/marketplace/updater.ts";
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
const pluginEntry = `export default ({ command, context }) => {
  command((namespace) =>
    namespace.command("run").action(() => context.stdout.write("tools\\n")),
  );
};
`;
const unserved = "0123456789abcdef0123456789abcdef01234567";

function manifest(fields: Record<string, unknown>): string {
  return JSON.stringify({
    plugins: [{ name: "tools", entry: "plugin.ts" }],
    ...fields,
  });
}

function release(version: string, ref: string, tx: string) {
  return { version, ref, tx };
}

/** Commits a manifest declaring the given fields, tagged when a tag is given. */
async function publish(
  remote: string,
  fields: Record<string, unknown>,
  tag?: string,
): Promise<string> {
  const commit = await commitFixtureFiles(
    remote,
    { [manifestFile]: manifest(fields) },
    tag ?? "publish",
  );
  if (tag !== undefined) fixtureGit(remote, ["tag", tag]);
  return commit;
}

interface Remote {
  readonly temporaryRoot: string;
  readonly remote: string;
  readonly source: string;
  /** `1.4.0`, declaring `>=1.0.0 <2.0.0`. */
  readonly b: string;
  /** `1.5.0`, declaring `>=1.6.0 <2.0.0`, on the default branch after B. */
  readonly a: string;
}

/**
 * A remote whose default branch carries `1.4.0` at B and `1.5.0` at A, both
 * tagged, ready for a tip to be published on top. Every fetch from it is a
 * real Git fetch over `file://` that reaches no network.
 */
async function remoteWithReleases(temporaryRoot: string): Promise<Remote> {
  const remote = await createGitRepository(temporaryRoot, "tools", {
    [manifestFile]: manifest({ version: "1.4.0", tx: ">=1.0.0 <2.0.0" }),
    "plugin.ts": pluginEntry,
  });
  fixtureGit(remote, ["tag", "v1.4.0"]);
  const b = fixtureGit(remote, ["rev-parse", "HEAD"]);
  const a = await publish(
    remote,
    { version: "1.5.0", tx: ">=1.6.0 <2.0.0" },
    "v1.5.0",
  );
  return {
    temporaryRoot,
    remote,
    source: pathToFileURL(remote).href,
    b,
    a,
  };
}

/** The tip of the scenarios: `2.0.0`, requiring tx `^2.0.0`, whose history
 * lists the given releases. */
async function publishTip(
  remote: Remote,
  versions: readonly ReturnType<typeof release>[],
): Promise<string> {
  return publish(
    remote.remote,
    { version: "2.0.0", tx: "^2.0.0", versions },
    "v2.0.0",
  );
}

function standardHistory(remote: Remote) {
  return [
    release("1.4.0", remote.b, ">=1.0.0 <2.0.0"),
    release("1.5.0", remote.a, ">=1.6.0 <2.0.0"),
  ];
}

function headOf(checkout: string): string {
  return fixtureGit(checkout, ["rev-parse", "HEAD"]);
}

/** Whether a checkout records a pin, read the way the manager writes one. */
function pinOf(checkout: string): string | undefined {
  const listed = fixtureGit(checkout, ["config", "--local", "--list"]);
  return listed
    .split("\n")
    .find((line) => line.startsWith("tx.pin="))
    ?.slice("tx.pin=".length);
}

async function noPreparation(): Promise<void> {}

async function unprepared(): Promise<void> {
  throw new Error("Preparation must not run");
}

function manager(root: string, txVersion = "1.8.0"): MarketplaceManager {
  return new MarketplaceManager(root, {
    env: process.env,
    prepare: noPreparation,
    txVersion,
  });
}

function updater(
  root: string,
  options: {
    readonly txVersion?: string;
    readonly prepare?: (checkout: string) => Promise<void>;
  } = {},
): MarketplaceUpdater {
  return new MarketplaceUpdater(root, {
    env: process.env,
    txVersion: options.txVersion ?? "1.8.0",
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
  });
}

/** Clones the remote as the installed `tools`, checked out at a commit. */
function install(remote: Remote, commit: string, full = true): string {
  const root = join(remote.temporaryRoot, "marketplaces");
  const checkout = join(root, "tools");
  fixtureGit(remote.temporaryRoot, [
    "clone",
    "--quiet",
    ...(full ? [] : ["--filter=blob:none"]),
    "--",
    remote.source,
    checkout,
  ]);
  fixtureGit(checkout, ["checkout", "--quiet", "--detach", commit]);
  return root;
}

function dependencies(version: string): CoreDependencies {
  return { ...coreDependencies, tx: { version } };
}

/** An in-memory config capability, so additions through the CLI record
 * themselves exactly as they do against the bundled one. */
function memoryConfig(values: Map<string, unknown>): PluginDefinition {
  const config: Config = {
    define() {},
    async read<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async write<T>(key: string, value: T) {
      values.set(key, value);
    },
  };
  return {
    identity: { name: "memory-config" },
    load:
      () =>
      ({ register }) =>
        register<Config>("@fx/tx/config", config),
  };
}

async function run(
  root: string,
  argv: readonly string[],
  options: {
    readonly txVersion?: string;
    readonly values?: Map<string, unknown>;
  } = {},
) {
  const context = captureContext(process.env);
  const exitCode = await main(
    argv,
    [
      createMarketplacePlugin({ root }),
      updatePlugin,
      memoryConfig(options.values ?? new Map()),
    ],
    context,
    dependencies(options.txVersion ?? "1.8.0"),
  );
  return {
    exitCode,
    stdout: context.stdoutText(),
    stderr: context.stderrText(),
  };
}

const selectedNotice =
  "Installed 1.5.0 because 2.0.0 requires tx ^2.0.0, which tx 1.8.0 does not satisfy.";
const selectedDetail =
  "2.0.0 requires tx ^2.0.0; 1.5.0 is the newest version supporting tx 1.8.0";

describe("adding a marketplace whose tip the running tx does not support", () => {
  test.each([
    ["a reduced", {}],
    ["a complete", { full: true }],
  ])(
    "installs the newest compatible version through %s clone, unpinned",
    async (_label, options) => {
      const temporaryRoot = await temporaryDirectory("tx-select-add-");
      try {
        const remote = await remoteWithReleases(temporaryRoot);
        await publishTip(remote, [
          ...standardHistory(remote),
          // A pre-release is never selected, however new and compatible.
          release("1.6.0-rc.1", remote.b, ">=1.0.0"),
        ]);
        const root = join(temporaryRoot, "marketplaces");

        expect(
          await manager(root).add(remote.source, undefined, options),
        ).toEqual({
          name: "tools",
          source: remote.source,
          notice: selectedNotice,
        });
        const checkout = join(root, "tools");
        expect(headOf(checkout)).toBe(remote.a);
        expect(pinOf(checkout)).toBeUndefined();
        expect(await readFile(join(checkout, manifestFile), "utf8")).toBe(
          manifest({ version: "1.5.0", tx: ">=1.6.0 <2.0.0" }),
        );
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  test("installs the tip when the running tx supports it", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-add-tip-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const tip = await publishTip(remote, standardHistory(remote));
      const root = join(temporaryRoot, "marketplaces");

      expect(await manager(root, "2.1.0").add(remote.source)).toEqual({
        name: "tools",
        source: remote.source,
      });
      expect(headOf(join(root, "tools"))).toBe(tip);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("publishes nothing when nothing is compatible", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-add-none-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      await publishTip(remote, [release("1.9.0", remote.a, ">=1.9.0 <2.0.0")]);
      const root = join(temporaryRoot, "marketplaces");

      await expect(manager(root).add(remote.source)).rejects.toThrow(
        `Marketplace "tools" has no version supporting tx 1.8.0: 2.0.0 requires tx ^2.0.0. Install a specific version with "tx marketplace add ${remote.source}@<ref>".`,
      );
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["a reduced", {}],
    ["a complete", { full: true }],
  ])(
    "never falls back past a candidate its own commit contradicts, through %s clone",
    async (_label, options) => {
      const temporaryRoot = await temporaryDirectory("tx-select-add-claim-");
      try {
        const remote = await remoteWithReleases(temporaryRoot);
        // The history claims 1.5.0 supports tx 1.8.0; commit A says otherwise.
        const a = await publish(remote.remote, {
          version: "1.5.0",
          tx: "^2.0.0",
        });
        await publishTip(remote, [
          release("1.4.0", remote.b, ">=1.0.0 <2.0.0"),
          release("1.5.0", a, ">=1.6.0 <2.0.0"),
        ]);
        const root = join(temporaryRoot, "marketplaces");

        await expect(
          manager(root).add(remote.source, undefined, options),
        ).rejects.toThrow(
          `Marketplace "tools" has no version supporting tx 1.8.0: 2.0.0 requires tx ^2.0.0; 1.5.0 is listed as supporting tx >=1.6.0 <2.0.0, but its commit declares tx ^2.0.0. Install a specific version with "tx marketplace add ${remote.source}@<ref>".`,
        );
        // Commit B, compatible and lower, is not installed in its place.
        expect(await readdir(root)).toEqual([]);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  test("names a candidate commit the remote does not serve", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-add-unserved-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      await publishTip(remote, [release("1.5.0", unserved, ">=1.6.0 <2.0.0")]);
      const root = join(temporaryRoot, "marketplaces");

      await expect(manager(root).add(remote.source)).rejects.toThrow(
        `1.5.0 is listed as supporting tx >=1.6.0 <2.0.0, but the remote does not serve its commit ${unserved}: Git command failed`,
      );
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("names a candidate commit whose manifest cannot be read", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-add-unread-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const broken = await commitFixtureFiles(
        remote.remote,
        { [manifestFile]: "{ not json" },
        "broken",
      );
      await publishTip(remote, [release("1.5.0", broken, ">=1.6.0 <2.0.0")]);
      const root = join(temporaryRoot, "marketplaces");

      await expect(manager(root).add(remote.source)).rejects.toThrow(
        "1.5.0 is listed as supporting tx >=1.6.0 <2.0.0, but its commit's manifest cannot be read: ",
      );
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["a reduced", {}],
    ["a complete", { full: true }],
  ])(
    "fetches a candidate commit by its object name through %s clone",
    async (_label, options) => {
      const temporaryRoot = await temporaryDirectory("tx-select-add-fetch-");
      try {
        const remote = await remoteWithReleases(temporaryRoot);
        // 1.6.0 was released from a branch since deleted, so no ref the clone
        // copies reaches it; only its object name does.
        fixtureGit(remote.remote, ["checkout", "--quiet", "-b", "release"]);
        const side = await publish(remote.remote, {
          version: "1.6.0",
          tx: ">=1.8.0 <2.0.0",
        });
        fixtureGit(remote.remote, ["checkout", "--quiet", "-"]);
        fixtureGit(remote.remote, ["branch", "-D", "release"]);
        await publishTip(remote, [
          ...standardHistory(remote),
          release("1.6.0", side, ">=1.8.0 <2.0.0"),
        ]);
        const root = join(temporaryRoot, "marketplaces");

        const added = await manager(root).add(
          remote.source,
          undefined,
          options,
        );
        expect(added.notice).toBe(
          "Installed 1.6.0 because 2.0.0 requires tx ^2.0.0, which tx 1.8.0 does not satisfy.",
        );
        expect(headOf(join(root, "tools"))).toBe(side);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  test("installs an unreadable tip, so validation reports it", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-add-broken-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      await commitFixtureFiles(
        remote.remote,
        { [manifestFile]: "{ not json" },
        "broken",
      );
      const root = join(temporaryRoot, "marketplaces");

      await expect(
        new MarketplaceManager(root, {
          env: process.env,
          txVersion: "1.8.0",
        }).add(remote.source, undefined, { full: true }),
      ).rejects.toThrow(`Invalid ${manifestFile}`);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("adding or pinning what the running tx refuses", () => {
  const warning = (subject: string) =>
    `${subject} supports tx ^2.0.0, not tx 1.8.0, so its plugins will be refused under this tx; set TX_IGNORE_COMPATIBILITY=1 to load them anyway.`;

  test("warns on a pinned addition and records the pin regardless", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-warn-ref-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const tip = await publishTip(remote, standardHistory(remote));
      const root = join(temporaryRoot, "marketplaces");

      expect(await manager(root).add(`${remote.source}@v2.0.0`)).toEqual({
        name: "tools",
        source: `${remote.source}@v2.0.0`,
        warning: warning('Marketplace "tools"'),
      });
      expect(headOf(join(root, "tools"))).toBe(tip);
      expect(pinOf(join(root, "tools"))).toBe("v2.0.0");

      // A compatible pinned version is added without a word.
      expect(
        await manager(root).add(`${remote.source}@v1.5.0`, "older"),
      ).toEqual({ name: "older", source: `${remote.source}@v1.5.0` });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("warns on a local reference without selecting anything", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-warn-local-");
    try {
      const source = join(temporaryRoot, "source");
      await writeFixtureFiles(source, {
        [manifestFile]: manifest({ tx: "^2.0.0" }),
        "plugin.ts": pluginEntry,
      });
      const root = join(temporaryRoot, "marketplaces");

      expect(await manager(root).add(source)).toEqual({
        name: "source",
        source,
        warning: warning('Marketplace "source"'),
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("warns on a pin to an incompatible commit, and not on an unreadable one", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-warn-pin-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      await publishTip(remote, standardHistory(remote));
      await commitFixtureFiles(
        remote.remote,
        { [manifestFile]: "{ not json" },
        "broken",
      );
      fixtureGit(remote.remote, ["tag", "broken"]);
      const root = install(remote, remote.a);
      const pinning = manager(root);

      expect(await pinning.pin("tools", "v2.0.0")).toEqual({
        version: "v2.0.0",
        warning: warning('Marketplace "tools" at v2.0.0'),
      });
      expect(pinOf(join(root, "tools"))).toBe("v2.0.0");
      expect(await pinning.pin("tools", "v1.4.0")).toEqual({
        version: "v1.4.0",
      });
      // Validated when the update applies the pin, not warned about here.
      expect(await pinning.pin("tools", "broken")).toEqual({
        version: "broken",
      });
      expect(pinOf(join(root, "tools"))).toBe("broken");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports through the commands on standard output and standard error", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-commands-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      await publishTip(remote, standardHistory(remote));
      const root = join(temporaryRoot, "marketplaces");
      const values = new Map<string, unknown>();

      expect(
        await run(root, ["marketplace", "add", remote.source], { values }),
      ).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: `Added marketplace "tools".\n${selectedNotice}\n`,
        stderr: "",
      });
      // Only what identifies the marketplace is recorded.
      expect(values.get("marketplace")).toEqual([
        { name: "tools", source: remote.source },
      ]);

      expect(
        await run(root, ["marketplace", "pin", "tools", "v2.0.0"]),
      ).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout:
          'Pinned marketplace "tools" to "v2.0.0"; the next "tx update" applies v2.0.0.\n',
        stderr: `Warning: ${warning('Marketplace "tools" at v2.0.0')}\n`,
      });

      expect(
        await run(root, [
          "marketplace",
          "add",
          `${remote.source}@v2.0.0`,
          "--name",
          "pinned",
        ]),
      ).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: 'Added marketplace "pinned".\n',
        stderr: `Warning: ${warning('Marketplace "pinned"')}\n`,
      });
      // The selected version is the one that loads.
      expect((await run(root, ["tools", "run"])).stdout).toBe("tools\n");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("selects for a configured marketplace exactly as adding one does", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-install-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      await publishTip(remote, standardHistory(remote));
      const root = join(temporaryRoot, "marketplaces");
      const values = new Map<string, unknown>([
        ["marketplace", [{ source: remote.source }]],
      ]);

      expect(await run(root, ["marketplace", "install"], { values })).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: `Added marketplace "tools".\n${selectedNotice}\n`,
        stderr: "",
      });
      expect(headOf(join(root, "tools"))).toBe(remote.a);
      expect(pinOf(join(root, "tools"))).toBeUndefined();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("updating a marketplace whose tip the running tx does not support", () => {
  test("holds a compatible installation the candidate does not lead forward from", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-held-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      await publishTip(remote, standardHistory(remote));
      const root = install(remote, remote.a);
      const checkout = join(root, "tools");

      expect(await updater(root, { prepare: unprepared }).gather()).toEqual([
        {
          name: "tools",
          current: "v1.5.0",
          detail: "held at 1.5.0: 2.0.0 requires tx ^2.0.0",
        },
      ]);
      expect(
        await updater(root, { prepare: unprepared }).apply({
          name: "tools",
          current: "v1.5.0",
        }),
      ).toEqual({
        applied: false,
        detail: "held at 1.5.0: 2.0.0 requires tx ^2.0.0",
      });
      expect(await run(root, ["update"])).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout:
          "tools\tv1.5.0\tup to date\theld at 1.5.0: 2.0.0 requires tx ^2.0.0\n",
        stderr: "",
      });
      expect(headOf(checkout)).toBe(remote.a);
      // Held is not refused: the installed version keeps loading.
      expect(await run(root, ["tools", "run"])).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: "tools\n",
        stderr: "",
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("never moves a compatible installation backwards to an older candidate", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-backwards-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      // Only 1.4.0 is listed, so the candidate is an ancestor of A.
      await publishTip(remote, [release("1.4.0", remote.b, ">=1.0.0 <2.0.0")]);
      const root = install(remote, remote.a);

      expect(await updater(root, { prepare: unprepared }).gather()).toEqual([
        {
          name: "tools",
          current: "v1.5.0",
          detail: "held at 1.5.0: 2.0.0 requires tx ^2.0.0",
        },
      ]);
      expect(
        await updater(root, { prepare: unprepared }).apply({
          name: "tools",
          current: "v1.5.0",
        }),
      ).toEqual({
        applied: false,
        detail: "held at 1.5.0: 2.0.0 requires tx ^2.0.0",
      });
      expect(headOf(join(root, "tools"))).toBe(remote.a);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("moves forward to the candidate without recording a pin", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-forward-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      await publishTip(remote, standardHistory(remote));
      const root = install(remote, remote.b);
      const checkout = join(root, "tools");
      const prepared: string[] = [];
      const updating = updater(root, {
        prepare: async (path) => {
          prepared.push(path);
        },
      });

      expect(await updating.gather()).toEqual([
        {
          name: "tools",
          current: "v1.4.0",
          available: "v1.5.0",
          detail: selectedDetail,
        },
      ]);
      expect(
        await updating.apply({ name: "tools", current: "v1.4.0" }),
      ).toEqual({ applied: true, version: "v1.5.0", detail: selectedDetail });
      expect(headOf(checkout)).toBe(remote.a);
      expect(prepared).toEqual([checkout]);
      expect(pinOf(checkout)).toBeUndefined();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("moves a refused installation back to the last working version", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-moveback-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const tip = await publishTip(remote, standardHistory(remote));
      const root = install(remote, tip);
      const checkout = join(root, "tools");
      await writeFile(join(checkout, "untracked.txt"), "kept\n");

      // A dry run reports the selection and moves nothing.
      expect(await run(root, ["update", "--dry-run"])).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: `tools\tv2.0.0\t-> v1.5.0\t${selectedDetail}\n`,
        stderr:
          'Error loading plugin marketplace/installed/tools: Marketplace "tools" supports tx ^2.0.0, not tx 1.8.0. Run "tx update" to update tx and its marketplaces, pin a version that supports tx 1.8.0 with "tx marketplace pin tools <ref>", or set TX_IGNORE_COMPATIBILITY=1 to load it anyway.\n',
      });
      expect(headOf(checkout)).toBe(tip);
      expect(fixtureGit(checkout, ["status", "--porcelain"])).toBe(
        "?? untracked.txt",
      );

      const updated = await run(root, ["update"]);
      expect(updated.exitCode).toBe(EXIT_SUCCESS);
      expect(updated.stdout).toBe(
        `tools\tv2.0.0\t-> v1.5.0\t${selectedDetail}\ntools\tupdated to v1.5.0\t${selectedDetail}\n`,
      );
      expect(headOf(checkout)).toBe(remote.a);
      expect(pinOf(checkout)).toBeUndefined();

      // The next invocation loads its plugins.
      expect(await run(root, ["tools", "run"])).toEqual({
        exitCode: EXIT_SUCCESS,
        stdout: "tools\n",
        stderr: "",
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("counts an installed commit whose manifest cannot be read as refused", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-unreadable-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const broken = await commitFixtureFiles(
        remote.remote,
        { [manifestFile]: "{ not json" },
        "broken",
      );
      await publishTip(remote, standardHistory(remote));
      const root = install(remote, broken);

      const [item] = await updater(root, { prepare: unprepared }).gather();
      expect(item?.available).toBe("v1.5.0");
      expect(item?.detail).toBe(selectedDetail);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("still refuses to discard a tracked edit when moving back", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-edited-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const tip = await publishTip(remote, standardHistory(remote));
      const root = install(remote, tip);
      const checkout = join(root, "tools");
      await writeFile(join(checkout, "plugin.ts"), "// edited\n");

      const blocked =
        "blocked: modified tracked files (plugin.ts); resolve them in the checkout";
      expect(await updater(root, { prepare: unprepared }).gather()).toEqual([
        {
          name: "tools",
          current: "v2.0.0",
          available: "v1.5.0",
          detail: `${selectedDetail}; ${blocked}`,
        },
      ]);
      await expect(
        updater(root, { prepare: unprepared }).apply({
          name: "tools",
          current: "v2.0.0",
        }),
      ).rejects.toThrow(blocked);
      expect(headOf(checkout)).toBe(tip);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("returns to the tip under a tx that supports it", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-return-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const tip = await publishTip(remote, standardHistory(remote));
      const root = install(remote, remote.a);
      const updating = updater(root, {
        txVersion: "2.0.0",
        prepare: noPreparation,
      });

      expect(await updating.gather()).toEqual([
        { name: "tools", current: "v1.5.0", available: "v2.0.0" },
      ]);
      expect(
        await updating.apply({ name: "tools", current: "v1.5.0" }),
      ).toEqual({ applied: true, version: "v2.0.0" });
      expect(headOf(join(root, "tools"))).toBe(tip);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("fetches a candidate by object name while gathering, changing nothing installed", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-gather-fetch-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      fixtureGit(remote.remote, ["checkout", "--quiet", "-b", "release"]);
      const side = await publish(remote.remote, {
        version: "1.6.0",
        tx: ">=1.8.0 <2.0.0",
      });
      fixtureGit(remote.remote, ["checkout", "--quiet", "-"]);
      fixtureGit(remote.remote, ["branch", "-D", "release"]);
      const tip = await publishTip(remote, [
        ...standardHistory(remote),
        release("1.6.0", side, ">=1.8.0 <2.0.0"),
      ]);
      const root = install(remote, tip);
      const checkout = join(root, "tools");
      const before = await readFile(join(checkout, manifestFile), "utf8");
      expect(
        Bun.spawnSync(["git", "cat-file", "-e", `${side}^{commit}`], {
          cwd: checkout,
        }).exitCode,
      ).not.toBe(0);

      const [item] = await updater(root, { prepare: unprepared }).gather();
      expect(item?.current).toBe("v2.0.0");
      expect(item?.detail).toBe(
        "2.0.0 requires tx ^2.0.0; 1.6.0 is the newest version supporting tx 1.8.0",
      );
      expect(item?.available).toMatch(/^v1\.5\.0-1-g[0-9a-f]+$/);
      expect(side).toStartWith(
        item?.available?.slice("v1.5.0-1-g".length) ?? "-",
      );
      // Only objects were written: the commit is now present, while the
      // checked-out commit, the working tree, and the files are unchanged.
      expect(fixtureGit(checkout, ["cat-file", "-t", side])).toBe("commit");
      expect(headOf(checkout)).toBe(tip);
      expect(fixtureGit(checkout, ["status", "--porcelain"])).toBe("");
      expect(await readFile(join(checkout, manifestFile), "utf8")).toBe(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("holds a compatible installation when the candidate is unusable", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-held-unusable-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      await publishTip(remote, [
        release("1.4.0", remote.b, ">=1.0.0 <2.0.0"),
        release("1.5.0", unserved, ">=1.6.0 <2.0.0"),
      ]);
      const root = install(remote, remote.b);

      const [item] = await updater(root, { prepare: unprepared }).gather();
      expect(item?.available).toBeUndefined();
      expect(item?.failure).toBeUndefined();
      expect(item?.detail).toStartWith(
        `held at 1.4.0: 2.0.0 requires tx ^2.0.0; 1.5.0 is listed as supporting tx >=1.6.0 <2.0.0, but the remote does not serve its commit ${unserved}: `,
      );
      expect(headOf(join(root, "tools"))).toBe(remote.b);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("fails a refused installation with nothing usable to move to", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-failed-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const a = await publish(remote.remote, {
        version: "1.5.0",
        tx: "^2.0.0",
      });
      const tip = await publishTip(remote, [
        release("1.4.0", remote.b, ">=1.0.0 <2.0.0"),
        release("1.5.0", a, ">=1.6.0 <2.0.0"),
      ]);
      const root = install(remote, tip);
      const failure =
        'no version supporting tx 1.8.0: 2.0.0 requires tx ^2.0.0; 1.5.0 is listed as supporting tx >=1.6.0 <2.0.0, but its commit declares tx ^2.0.0. Update tx to a version it supports, pin a version with "tx marketplace pin tools <ref>", or set TX_IGNORE_COMPATIBILITY=1 to load it anyway.';

      expect(await updater(root, { prepare: unprepared }).gather()).toEqual([
        { name: "tools", current: "v2.0.0", failure },
      ]);
      await expect(
        updater(root, { prepare: unprepared }).apply({
          name: "tools",
          current: "v2.0.0",
        }),
      ).rejects.toThrow(failure);
      const dryRun = await run(root, ["update", "--dry-run"]);
      expect(dryRun.exitCode).toBe(EXIT_FAILURE);
      expect(dryRun.stderr).toContain(
        `Error: tools\tv2.0.0\tfailed: ${failure}\n`,
      );
      // Commit B is compatible and lower, and is not moved to in A's place.
      expect(headOf(join(root, "tools"))).toBe(tip);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("never re-selects a pin, and notes when the running tx refuses it", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-pinned-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const tip = await publishTip(remote, standardHistory(remote));
      const root = install(remote, remote.a);
      const checkout = join(root, "tools");
      fixtureGit(checkout, ["config", "--local", "tx.pin", "v2.0.0"]);
      const note = "pinned to v2.0.0; v2.0.0 supports tx ^2.0.0, not tx 1.8.0";

      const updating = updater(root, { prepare: noPreparation });
      expect(await updating.gather()).toEqual([
        { name: "tools", current: "v1.5.0", available: "v2.0.0", detail: note },
      ]);
      expect(
        await updating.apply({ name: "tools", current: "v1.5.0" }),
      ).toEqual({ applied: true, version: "v2.0.0" });
      expect(headOf(checkout)).toBe(tip);
      expect(await updating.gather()).toEqual([
        { name: "tools", current: "v2.0.0", detail: note },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("leaves a pin's detail alone when its manifest cannot be read", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-pin-broken-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const broken = await commitFixtureFiles(
        remote.remote,
        { [manifestFile]: "{ not json" },
        "broken",
      );
      fixtureGit(remote.remote, ["tag", "broken"]);
      const root = install(remote, broken);
      fixtureGit(join(root, "tools"), [
        "config",
        "--local",
        "tx.pin",
        "broken",
      ]);

      expect(await updater(root, { prepare: unprepared }).gather()).toEqual([
        { name: "tools", current: "broken", detail: "pinned to broken" },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("targets an unreadable tip, validating it only when it is new", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-tip-broken-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const broken = await commitFixtureFiles(
        remote.remote,
        { [manifestFile]: "{ not json" },
        "broken",
      );
      const root = install(remote, remote.a);
      const checkout = join(root, "tools");

      // A new tip: gathered as the target, and refused by validation when the
      // update applies it, with the checkout restored.
      const [item] = await updater(root, { prepare: unprepared }).gather();
      expect(item?.available).toMatch(/^v1\.5\.0-1-g[0-9a-f]+$/);
      expect(item?.detail).toBeUndefined();
      await expect(
        new MarketplaceUpdater(root, {
          env: process.env,
          txVersion: "1.8.0",
        }).apply({ name: "tools", current: "v1.5.0" }),
      ).rejects.toThrow(`Invalid ${manifestFile}`);
      expect(headOf(checkout)).toBe(remote.a);

      // The installed tip: nothing to apply, and nothing revalidated.
      fixtureGit(checkout, ["checkout", "--quiet", "--detach", broken]);
      const current = await updater(root, { prepare: unprepared }).gather();
      expect(current).toEqual([
        { name: "tools", current: item?.available as string },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reads compatibility from a reduced checkout without materializing it", async () => {
    const temporaryRoot = await temporaryDirectory("tx-select-partial-");
    try {
      const remote = await remoteWithReleases(temporaryRoot);
      const tip = await publishTip(remote, standardHistory(remote));
      const root = install(remote, tip, false);
      const checkout = join(root, "tools");

      expect(await updater(root, { prepare: unprepared }).gather()).toEqual([
        {
          name: "tools",
          current: "v2.0.0",
          available: "v1.5.0",
          detail: selectedDetail,
        },
      ]);
      expect(headOf(checkout)).toBe(tip);
      expect(fixtureGit(checkout, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
