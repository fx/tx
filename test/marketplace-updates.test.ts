import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { UpdateItem } from "@fx/tx/plugin";
import {
  MarketplaceManager,
  type RunGit,
  runGit,
} from "../plugins/marketplace/manager.ts";
import { MarketplaceUpdater } from "../plugins/marketplace/updater.ts";
import {
  commitFixtureFiles,
  createGitRepository,
  fixtureGit,
  temporaryDirectory,
  writeFixtureFiles,
} from "./helpers.ts";

const manifest = '{"plugins":[{"name":"tools","entry":"plugin.ts"}]}';
const entry = "export default () => {};\n";

interface Installed {
  readonly remote: string;
  readonly root: string;
  readonly checkout: string;
}

/**
 * A marketplace cloned from a local repository, at a tagged first commit. The
 * remote is a `file://` source, so every fetch below is a real Git fetch that
 * reaches no network.
 */
async function installClone(
  temporaryRoot: string,
  name = "tools",
  tag: string | false = "v1.0.0",
): Promise<Installed> {
  const remote = await createGitRepository(temporaryRoot, `${name}-remote`, {
    ".tx/config.json": manifest,
    "plugin.ts": entry,
    "README.txt": "first\n",
  });
  if (tag) fixtureGit(remote, ["tag", tag]);
  const root = join(temporaryRoot, "marketplaces");
  const checkout = join(root, name);
  fixtureGit(temporaryRoot, [
    "clone",
    "--quiet",
    "--",
    pathToFileURL(remote).href,
    checkout,
  ]);
  return { remote, root, checkout };
}

async function installSparseClone(
  temporaryRoot: string,
  files: Readonly<Record<string, string>> = {
    ".tx/config.json":
      '{"plugins":[{"name":"tools","entry":"plugins/old/index.ts"}]}',
    "plugins/old/index.ts": entry,
    "assets/unused.bin": "unused old content\n",
  },
): Promise<Installed> {
  const remote = await createGitRepository(
    temporaryRoot,
    "tools-sparse-remote",
    files,
  );
  fixtureGit(remote, ["tag", "v1.0.0"]);
  const root = join(temporaryRoot, "marketplaces");
  const checkout = join(root, "tools");
  fixtureGit(temporaryRoot, [
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--sparse",
    "--",
    pathToFileURL(remote).href,
    checkout,
  ]);
  fixtureGit(checkout, [
    "sparse-checkout",
    "set",
    "--cone",
    "--skip-checks",
    "--",
    ".tx",
    "plugins/old",
  ]);
  return { remote, root, checkout };
}

function sparseDirectories(checkout: string): readonly string[] {
  const listed = fixtureGit(checkout, ["sparse-checkout", "list"]);
  return listed === "" ? [] : listed.split("\n");
}

/** A second commit on the remote, published as `v2.0.0`. */
async function publishSecondVersion(
  remote: string,
  files: Readonly<Record<string, string>> = { "README.txt": "second\n" },
): Promise<string> {
  const commit = await commitFixtureFiles(remote, files, "second");
  fixtureGit(remote, ["tag", "v2.0.0"]);
  return commit;
}

function headOf(checkout: string): string {
  return fixtureGit(checkout, ["rev-parse", "HEAD"]);
}

/** Pins an installed checkout the way `marketplace add` and `marketplace pin`
 * record one: in the checkout's own Git configuration. */
function pin(checkout: string, ref: string): void {
  fixtureGit(checkout, ["config", "--local", "tx.pin", ref]);
}

/** Gathering never prepares anything, so a gather-only test says so. */
async function unprepared(): Promise<void> {
  throw new Error("Preparation must not run");
}

function updater(
  root: string,
  prepare: (checkout: string) => Promise<void>,
): MarketplaceUpdater {
  return new MarketplaceUpdater(root, { env: process.env, prepare });
}

function gathered(items: readonly UpdateItem[], index = 0): UpdateItem {
  const item = items[index];
  if (!item) throw new Error(`Nothing was gathered at index ${index}`);
  return item;
}

describe("marketplace update gathering", () => {
  test("reports the available version and leaves the checkout untouched", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-gather-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      await publishSecondVersion(remote);
      const before = headOf(checkout);

      expect(await updater(root, unprepared).gather()).toEqual([
        { name: "tools", current: "v1.0.0", available: "v2.0.0" },
      ]);

      // Gathering fetched, which writes remote-tracking refs and objects and
      // nothing else: the commit, the working tree, and everything installed
      // beside it are exactly as they were.
      expect(headOf(checkout)).toBe(before);
      expect(fixtureGit(checkout, ["status", "--porcelain"])).toBe("");
      expect(await readFile(join(checkout, "README.txt"), "utf8")).toBe(
        "first\n",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports a current clone with nothing available", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-current-");
    try {
      const { root } = await installClone(temporaryRoot);

      expect(await updater(root, unprepared).gather()).toEqual([
        { name: "tools", current: "v1.0.0" },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("labels a commit past a tag by the tag it descends from", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-described-");
    try {
      const { remote, root } = await installClone(temporaryRoot);
      await commitFixtureFiles(remote, { "README.txt": "second\n" }, "second");

      const item = gathered(await updater(root, unprepared).gather());
      expect(item.current).toBe("v1.0.0");
      expect(item.available).toMatch(/^v1\.0\.0-1-g[0-9a-f]+$/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("labels a commit by its abbreviated hash where nothing is tagged", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-untagged-");
    try {
      const { remote, root, checkout } = await installClone(
        temporaryRoot,
        "tools",
        false,
      );
      const commit = await commitFixtureFiles(
        remote,
        { "README.txt": "second\n" },
        "second",
      );

      const item = gathered(await updater(root, unprepared).gather());
      expect(item.current).toMatch(/^[0-9a-f]{7,}$/);
      expect(headOf(checkout)).toStartWith(item.current);
      expect(item.available).toMatch(/^[0-9a-f]{7,}$/);
      expect(commit).toStartWith(item.available ?? "");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports a tag the fetch brought in for the commit already installed", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-new-tag-");
    try {
      const { remote, root } = await installClone(
        temporaryRoot,
        "tools",
        false,
      );
      // The publisher tags what is already installed and advances nothing, so
      // the only thing the fetch changes is what this commit is called.
      fixtureGit(remote, ["tag", "v1.0.0"]);

      expect(await updater(root, unprepared).gather()).toEqual([
        { name: "tools", current: "v1.0.0" },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("never reaches Git for a reference, and applies nothing to it", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-reference-");
    try {
      const source = join(temporaryRoot, "source");
      const root = join(temporaryRoot, "marketplaces");
      await mkdir(root, { recursive: true });
      await writeFixtureFiles(source, {
        ".tx/config.json": manifest,
        "plugin.ts": entry,
      });
      await symlink(source, join(root, "linked"));
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        runGit: async () => {
          throw new Error("Git must not run against a reference");
        },
        prepare: async () => {
          throw new Error("A reference must not be prepared");
        },
      });

      const items = await participant.gather();
      expect(items).toEqual([{ name: "linked", current: "live" }]);
      expect(await participant.apply(gathered(items))).toEqual({
        applied: false,
        detail: "live reference",
      });
      expect(await readFile(join(source, "plugin.ts"), "utf8")).toBe(entry);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports an unreadable checkout beside healthy ones that still apply", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-corrupt-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      await publishSecondVersion(remote);
      await writeFixtureFiles(join(root, "broken"), {
        "stray.txt": "not a checkout",
      });
      const prepared: string[] = [];
      const participant = updater(root, async (target) => {
        prepared.push(target);
      });

      const items = await participant.gather();
      const broken = gathered(items);
      const healthy = gathered(items, 1);

      expect(broken.name).toBe("broken");
      expect(broken.current).toBe("<unknown>");
      expect(broken.available).toBeUndefined();
      expect(broken.failure).toEndWith(
        'Run "tx marketplace remove broken" to remove it.',
      );
      expect(healthy).toEqual({
        name: "tools",
        current: "v1.0.0",
        available: "v2.0.0",
      });

      expect(await participant.apply(healthy)).toEqual({
        applied: true,
        version: "v2.0.0",
      });
      expect(prepared).toEqual([checkout]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("gathers and applies marketplaces in sorted name order", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-order-");
    try {
      const zeta = await installClone(temporaryRoot, "zeta");
      const alpha = await installClone(temporaryRoot, "alpha");
      await publishSecondVersion(zeta.remote);
      await publishSecondVersion(alpha.remote);
      const applied: string[] = [];
      const participant = updater(alpha.root, async (checkout) => {
        applied.push(checkout);
      });

      const items = await participant.gather();
      expect(items.map(({ name }) => name)).toEqual(["alpha", "zeta"]);
      for (const item of items) await participant.apply(item);

      expect(applied).toEqual([alpha.checkout, zeta.checkout]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("marketplace update application", () => {
  test("moves the checkout forward, prepares it, and reports the new label", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-forward-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      const target = await publishSecondVersion(remote);
      const prepared: string[] = [];
      const participant = updater(root, async (moved) => {
        // Preparation runs against the commit it is meant to validate.
        expect(await readFile(join(moved, "README.txt"), "utf8")).toBe(
          "second\n",
        );
        prepared.push(moved);
      });

      const item = gathered(await participant.gather());
      expect(await participant.apply(item)).toEqual({
        applied: true,
        version: "v2.0.0",
      });
      expect(headOf(checkout)).toBe(target);
      expect(prepared).toEqual([checkout]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("applies nothing, and prepares nothing, when the checkout is current", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-noop-");
    try {
      const { root, checkout } = await installClone(temporaryRoot);
      const before = headOf(checkout);
      const participant = updater(root, async () => {
        throw new Error("Preparation must not run for a current checkout");
      });

      const item = gathered(await participant.gather());
      expect(await participant.apply(item)).toEqual({ applied: false });
      expect(headOf(checkout)).toBe(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("refuses a checkout with modified tracked files without moving it", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-modified-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      await publishSecondVersion(remote);
      await writeFile(join(checkout, "README.txt"), "mine\n");
      const before = headOf(checkout);
      const participant = updater(root, async () => {
        throw new Error("Preparation must not run for a blocked checkout");
      });

      const item = gathered(await participant.gather());
      expect(item.available).toBe("v2.0.0");
      expect(item.detail).toBe(
        "blocked: modified tracked files (README.txt); resolve them in the checkout",
      );

      await expect(participant.apply(item)).rejects.toThrow(
        "blocked: modified tracked files (README.txt)",
      );
      expect(headOf(checkout)).toBe(before);
      expect(await readFile(join(checkout, "README.txt"), "utf8")).toBe(
        "mine\n",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("updates past untracked files, which dependency installation creates", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-untracked-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      const target = await publishSecondVersion(remote);
      await writeFixtureFiles(checkout, {
        "node_modules/installed/index.js": "module.exports = {};\n",
      });
      const participant = updater(root, async () => {});

      const item = gathered(await participant.gather());
      expect(item.detail).toBeUndefined();
      expect(await participant.apply(item)).toEqual({
        applied: true,
        version: "v2.0.0",
      });
      expect(headOf(checkout)).toBe(target);
      expect(
        await readFile(
          join(checkout, "node_modules/installed/index.js"),
          "utf8",
        ),
      ).toBe("module.exports = {};\n");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("refuses an untracked file in the way of a tracked path and keeps it", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-collision-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      await publishSecondVersion(remote, {
        "README.txt": "second\n",
        "added.txt": "published\n",
      });
      await writeFile(join(checkout, "added.txt"), "mine\n");
      const before = headOf(checkout);
      const participant = updater(root, async () => {
        throw new Error("Preparation must not run for a refused checkout");
      });

      const item = gathered(await participant.gather());
      // Nothing local can see this collision until the checkout is attempted,
      // so the update is available and undetailed right up to the refusal.
      expect(item.available).toBe("v2.0.0");
      expect(item.detail).toBeUndefined();

      await expect(participant.apply(item)).rejects.toThrow("added.txt");
      expect(headOf(checkout)).toBe(before);
      expect(await readFile(join(checkout, "added.txt"), "utf8")).toBe(
        "mine\n",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("refuses a target the installed commit is not an ancestor of", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-rewritten-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      // What a force-pushed branch looks like: the default branch now names a
      // history the installed commit is no part of.
      const branch = fixtureGit(remote, ["symbolic-ref", "--short", "HEAD"]);
      fixtureGit(remote, ["checkout", "--quiet", "--orphan", "rewritten"]);
      await commitFixtureFiles(
        remote,
        { "README.txt": "rewritten\n" },
        "rewritten",
      );
      fixtureGit(remote, ["branch", "--move", "--force", branch]);
      // The tag went with it, so the installed commit is published nowhere on
      // the remote — which is what separates this from a checkout sitting on a
      // commit the remote still has.
      fixtureGit(remote, ["tag", "--delete", "v1.0.0"]);
      const before = headOf(checkout);
      const participant = updater(root, async () => {
        throw new Error("Preparation must not run for a blocked checkout");
      });

      const item = gathered(await participant.gather());
      expect(item.available).toBeString();
      expect(item.detail).toBe(
        'blocked: the remote no longer contains the installed commit; run "tx marketplace remove tools" and add it again',
      );

      await expect(participant.apply(item)).rejects.toThrow(
        "the remote no longer contains the installed commit",
      );
      expect(headOf(checkout)).toBe(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("restores the previous commit when production preparation fails", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-restore-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      await publishSecondVersion(remote, {
        "README.txt": "second\n",
        ".tx/config.json": "{ not json",
      });
      const before = headOf(checkout);
      // No injected preparation: the validation and installation that run when
      // a marketplace is added are the ones that must run here.
      const participant = new MarketplaceUpdater(root, { env: process.env });

      const item = gathered(await participant.gather());
      await expect(participant.apply(item)).rejects.toThrow(
        /Invalid \.tx\/config\.json[\s\S]*The previous commit was restored; installed dependencies were not\./,
      );

      expect(headOf(checkout)).toBe(before);
      expect(await readFile(join(checkout, ".tx/config.json"), "utf8")).toBe(
        manifest,
      );
      expect(await readFile(join(checkout, "README.txt"), "utf8")).toBe(
        "first\n",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("reduced marketplace update application", () => {
  test("adds the target entry and package cones before moving", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-sparse-plan-");
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      const target = await commitFixtureFiles(
        remote,
        {
          ".tx/config.json":
            '{"plugins":[{"name":"tools","entry":"extensions/new/index.ts","package":"packages/shared/package.json"}]}',
          "extensions/new/index.ts": "export default () => 'new';\n",
          "packages/shared/package.json": '{"name":"shared"}\n',
          "assets/new-unused.bin": "still excluded\n",
        },
        "move plugin footprint",
      );
      fixtureGit(remote, ["tag", "v2.0.0"]);
      const calls: readonly string[][] = [];
      const recorded: string[][] = calls as string[][];
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        runGit: async (args, options) => {
          recorded.push([...args]);
          return runGit(args, options);
        },
        prepare: async (moved) => {
          expect(
            await readFile(join(moved, "extensions/new/index.ts"), "utf8"),
          ).toContain("new");
          expect(
            await readFile(join(moved, "packages/shared/package.json"), "utf8"),
          ).toContain("shared");
        },
      });

      const item = gathered(await participant.gather());
      expect(await participant.apply(item)).toEqual({
        applied: true,
        version: "v2.0.0",
      });
      expect(headOf(checkout)).toBe(target);
      expect(sparseDirectories(checkout)).toEqual([
        ".tx",
        "extensions/new",
        "packages/shared",
        "plugins/old",
      ]);
      expect(
        recorded.find(
          (args) => args[2] === "sparse-checkout" && args[3] === "add",
        ),
      ).toEqual([
        "-C",
        checkout,
        "sparse-checkout",
        "add",
        "--skip-checks",
        "--",
        ".tx",
        "extensions/new",
        "packages/shared",
      ]);
      expect(
        await Bun.file(join(checkout, "assets/new-unused.bin")).exists(),
      ).toBe(false);
      expect(recorded.some((args) => args.includes("disable"))).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  for (const transition of [
    "canonical to legacy",
    "legacy to canonical",
  ] as const) {
    test(`honors ${transition} manifest precedence at the target`, async () => {
      const temporaryRoot = await temporaryDirectory("tx-update-transition-");
      try {
        const legacyFirst = transition === "legacy to canonical";
        const initialManifest = legacyFirst
          ? "tx.marketplace.json"
          : ".tx/config.json";
        const targetManifest = legacyFirst
          ? ".tx/config.json"
          : "tx.marketplace.json";
        const { remote, root, checkout } = await installSparseClone(
          temporaryRoot,
          {
            [initialManifest]:
              '{"plugins":[{"name":"tools","entry":"plugins/old/index.ts"}]}',
            "plugins/old/index.ts": entry,
          },
        );
        await rm(join(remote, initialManifest));
        await commitFixtureFiles(
          remote,
          {
            [targetManifest]:
              '{"plugins":[{"name":"tools","entry":"plugins/new/index.ts"}]}',
            "plugins/new/index.ts": "export default () => 'transition';\n",
          },
          transition,
        );
        fixtureGit(remote, ["tag", "v2.0.0"]);

        const participant = updater(root, async (moved) => {
          expect(
            await readFile(join(moved, "plugins/new/index.ts"), "utf8"),
          ).toContain("transition");
        });
        expect(
          await participant.apply(gathered(await participant.gather())),
        ).toEqual({ applied: true, version: "v2.0.0" });
        expect(sparseDirectories(checkout)).toContain("plugins/new");
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  }

  test("uses canonical symlink precedence and keeps a successful fallback full", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-symlink-plan-");
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      await rm(join(remote, ".tx/config.json"));
      await commitFixtureFiles(
        remote,
        {
          "config/canonical.json":
            '{"plugins":[{"name":"canonical","entry":"canonical/index.ts"}]}',
          "canonical/index.ts": "export default () => 'canonical';\n",
          "tx.marketplace.json":
            '{"plugins":[{"name":"legacy","entry":"legacy/index.ts"}]}',
          "legacy/index.ts": "export default () => 'legacy';\n",
        },
        "stage symlink target",
      );
      await symlink(
        "../config/canonical.json",
        join(remote, ".tx/config.json"),
      );
      fixtureGit(remote, ["add", "--all"]);
      fixtureGit(remote, ["commit", "-m", "prefer canonical symlink"]);
      fixtureGit(remote, ["tag", "v2.0.0"]);

      const participant = updater(root, async (moved) => {
        expect(
          await readFile(join(moved, "canonical/index.ts"), "utf8"),
        ).toContain("canonical");
      });
      expect(
        await participant.apply(gathered(await participant.gather())),
      ).toEqual({ applied: true, version: "v2.0.0" });
      expect(
        fixtureGit(checkout, ["config", "--bool", "core.sparseCheckout"]),
      ).toBe("false");
      expect(await Bun.file(join(checkout, "legacy/index.ts")).exists()).toBe(
        true,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("uses a symlinked canonical manifest parent before a legacy file", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-parent-link-");
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      await rm(join(remote, ".tx"), { recursive: true });
      await commitFixtureFiles(
        remote,
        {
          "metadata/config.json":
            '{"plugins":[{"name":"canonical","entry":"canonical/index.ts"}]}',
          "canonical/index.ts": "export default () => 'canonical parent';\n",
          "tx.marketplace.json":
            '{"plugins":[{"name":"legacy","entry":"legacy/index.ts"}]}',
          "legacy/index.ts": "export default () => 'legacy';\n",
        },
        "stage canonical parent target",
      );
      await symlink("metadata", join(remote, ".tx"));
      fixtureGit(remote, ["add", "--all"]);
      fixtureGit(remote, ["commit", "-m", "link canonical parent"]);
      fixtureGit(remote, ["tag", "v2.0.0"]);

      const participant = updater(root, async (moved) => {
        expect(
          await readFile(join(moved, "canonical/index.ts"), "utf8"),
        ).toContain("canonical parent");
      });
      expect(
        await participant.apply(gathered(await participant.gather())),
      ).toEqual({ applied: true, version: "v2.0.0" });
      expect(
        fixtureGit(checkout, ["config", "--bool", "core.sparseCheckout"]),
      ).toBe("false");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  for (const invalid of [
    {
      name: "missing manifest",
      mutate: async (remote: string) => {
        await rm(join(remote, ".tx/config.json"));
      },
      expected: "Missing .tx/config.json",
    },
    {
      name: "malformed manifest",
      mutate: async (remote: string) => {
        await writeFile(join(remote, ".tx/config.json"), "{");
      },
      expected: "Invalid .tx/config.json",
    },
    {
      name: "lexically invalid entry",
      mutate: async (remote: string) => {
        await writeFile(
          join(remote, ".tx/config.json"),
          '{"plugins":[{"name":"tools","entry":"../outside.ts"}]}',
        );
      },
      expected: "entry escapes the marketplace",
    },
  ]) {
    test(`rejects ${invalid.name} before sparse or HEAD mutation`, async () => {
      const temporaryRoot = await temporaryDirectory("tx-update-content-");
      try {
        const { remote, root, checkout } =
          await installSparseClone(temporaryRoot);
        const before = headOf(checkout);
        const cones = sparseDirectories(checkout);
        await invalid.mutate(remote);
        fixtureGit(remote, ["add", "--all"]);
        fixtureGit(remote, ["commit", "-m", invalid.name]);
        fixtureGit(remote, ["tag", "v2.0.0"]);
        const calls: string[][] = [];
        const participant = new MarketplaceUpdater(root, {
          env: process.env,
          runGit: async (args, options) => {
            calls.push([...args]);
            return runGit(args, options);
          },
          prepare: async () => {
            throw new Error("Preparation must not run");
          },
        });

        const item = gathered(await participant.gather());
        await expect(participant.apply(item)).rejects.toThrow(invalid.expected);
        expect(headOf(checkout)).toBe(before);
        expect(sparseDirectories(checkout)).toEqual(cones);
        expect(
          calls.some(
            (args) =>
              (args[2] === "sparse-checkout" &&
                ["add", "set", "disable"].includes(args[3] ?? "")) ||
              args[2] === "checkout",
          ),
        ).toBe(false);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  }

  test("falls back in the same checkout when target-tree planning fails", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-plan-fallback-");
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      await publishSecondVersion(remote, {
        ".tx/config.json": manifest,
        "plugin.ts": entry,
      });
      let failed = false;
      const calls: string[][] = [];
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        runGit: async (args, options) => {
          calls.push([...args]);
          if (!failed && args.includes("ls-tree")) {
            failed = true;
            throw new Error("target tree unavailable");
          }
          return runGit(args, options);
        },
        prepare: async () => {},
      });

      expect(
        await participant.apply(gathered(await participant.gather())),
      ).toEqual({ applied: true, version: "v2.0.0" });
      expect(calls.filter((args) => args.includes("disable"))).toHaveLength(1);
      expect(
        fixtureGit(checkout, ["config", "--bool", "core.sparseCheckout"]),
      ).toBe("false");
      expect(calls.some((args) => args[0] === "clone")).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("retries repository-path preparation once against the complete tree", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-path-retry-");
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      await commitFixtureFiles(
        remote,
        {
          ".tx/config.json":
            '{"plugins":[{"name":"tools","entry":"linked/index.ts"}]}',
          "real/index.ts": "export default () => 'linked target';\n",
        },
        "symlinked entry parent",
      );
      await symlink("real", join(remote, "linked"));
      fixtureGit(remote, ["add", "--all"]);
      fixtureGit(remote, ["commit", "-m", "link entry parent"]);
      fixtureGit(remote, ["tag", "v2.0.0"]);
      const participant = new MarketplaceUpdater(root, { env: process.env });

      expect(
        await participant.apply(gathered(await participant.gather())),
      ).toEqual({ applied: true, version: "v2.0.0" });
      expect(
        await readFile(join(checkout, "linked/index.ts"), "utf8"),
      ).toContain("linked target");
      expect(
        fixtureGit(checkout, ["config", "--bool", "core.sparseCheckout"]),
      ).toBe("false");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("does not retry a repository path absent from the target", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-path-absent-");
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      await commitFixtureFiles(
        remote,
        {
          ".tx/config.json":
            '{"plugins":[{"name":"tools","entry":"missing/index.ts"}]}',
        },
        "missing entry",
      );
      fixtureGit(remote, ["tag", "v2.0.0"]);
      const before = headOf(checkout);
      const cones = sparseDirectories(checkout);
      const calls: string[][] = [];
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        runGit: async (args, options) => {
          calls.push([...args]);
          return runGit(args, options);
        },
      });

      await expect(
        participant.apply(gathered(await participant.gather())),
      ).rejects.toThrow("entry does not exist: missing/index.ts");
      expect(headOf(checkout)).toBe(before);
      expect(sparseDirectories(checkout)).toEqual(cones);
      expect(calls.filter((args) => args.includes("disable"))).toHaveLength(0);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("restores the old commit and exact cone after preparation fails", async () => {
    const temporaryRoot = await temporaryDirectory(
      "tx-update-sparse-rollback-",
    );
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      await commitFixtureFiles(
        remote,
        {
          ".tx/config.json":
            '{"plugins":[{"name":"tools","entry":"plugins/new/index.ts"}]}',
          "plugins/new/index.ts": "export default () => 'new';\n",
        },
        "new sparse directory",
      );
      fixtureGit(remote, ["tag", "v2.0.0"]);
      const before = headOf(checkout);
      const cones = sparseDirectories(checkout);
      const participant = updater(root, async () => {
        throw new Error("dependency failed");
      });

      await expect(
        participant.apply(gathered(await participant.gather())),
      ).rejects.toThrow(
        "dependency failed. The previous commit was restored; installed dependencies were not.",
      );
      expect(headOf(checkout)).toBe(before);
      expect(sparseDirectories(checkout)).toEqual(cones);
      expect(
        await Bun.file(join(checkout, "plugins/new/index.ts")).exists(),
      ).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("restores only sparse intent when an untracked collision prevents the move", async () => {
    const temporaryRoot = await temporaryDirectory(
      "tx-update-sparse-collision-",
    );
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      await publishSecondVersion(remote, {
        ".tx/config.json":
          '{"plugins":[{"name":"tools","entry":"new/added.txt"}]}',
        "new/added.txt": "published\n",
      });
      await mkdir(join(checkout, "new"), { recursive: true });
      await writeFile(join(checkout, "new/added.txt"), "mine\n");
      const before = headOf(checkout);
      const cones = sparseDirectories(checkout);
      const calls: string[][] = [];
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        runGit: async (args, options) => {
          calls.push([...args]);
          return runGit(args, options);
        },
        prepare: async () => {
          throw new Error("Preparation must not run");
        },
      });

      await expect(
        participant.apply(gathered(await participant.gather())),
      ).rejects.toThrow("added.txt");
      expect(headOf(checkout)).toBe(before);
      expect(sparseDirectories(checkout)).toEqual(cones);
      expect(await readFile(join(checkout, "new/added.txt"), "utf8")).toBe(
        "mine\n",
      );
      expect(
        calls.some(
          (args) => args[2] === "checkout" && args.includes("--force"),
        ),
      ).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("refuses sparse untracked collisions on either side of a path hierarchy", async () => {
    const scenarios = [
      {
        name: "untracked ancestor",
        published: { "blocked/published.txt": "published\n" },
        untracked: "blocked",
      },
      {
        name: "untracked descendant",
        published: { blocked: "published\n" },
        untracked: "blocked/mine.txt",
      },
    ] as const;

    for (const scenario of scenarios) {
      const temporaryRoot = await temporaryDirectory(
        `tx-update-sparse-${scenario.name.replace(" ", "-")}-`,
      );
      try {
        const { remote, root, checkout } =
          await installSparseClone(temporaryRoot);
        await publishSecondVersion(remote, scenario.published);
        await mkdir(join(checkout, scenario.untracked, ".."), {
          recursive: true,
        });
        await writeFile(join(checkout, scenario.untracked), "mine\n");
        const before = headOf(checkout);
        const cones = sparseDirectories(checkout);
        const participant = updater(root, async () => {
          throw new Error("Preparation must not run");
        });

        await expect(
          participant.apply(gathered(await participant.gather())),
        ).rejects.toThrow(scenario.untracked);
        expect(headOf(checkout)).toBe(before);
        expect(sparseDirectories(checkout)).toEqual(cones);
        expect(await readFile(join(checkout, scenario.untracked), "utf8")).toBe(
          "mine\n",
        );
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  });

  test("never runs sparse mutation commands for a durable full checkout", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-full-intent-");
    try {
      const { remote, root } = await installClone(temporaryRoot);
      await publishSecondVersion(remote);
      const calls: string[][] = [];
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        runGit: async (args, options) => {
          calls.push([...args]);
          return runGit(args, options);
        },
        prepare: async () => {},
      });
      expect(
        await participant.apply(gathered(await participant.gather())),
      ).toEqual({ applied: true, version: "v2.0.0" });
      expect(calls.some((args) => args.includes("sparse-checkout"))).toBe(
        false,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects an unexpected non-cone sparse checkout before mutation", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-non-cone-");
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      await publishSecondVersion(remote);
      fixtureGit(checkout, [
        "config",
        "--worktree",
        "core.sparseCheckoutCone",
        "false",
      ]);
      const before = headOf(checkout);
      const calls: string[][] = [];
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        runGit: async (args, options) => {
          calls.push([...args]);
          return runGit(args, options);
        },
        prepare: async () => {
          throw new Error("Preparation must not run");
        },
      });
      const item = gathered(await participant.gather());

      await expect(participant.apply(item)).rejects.toThrow(
        "unexpected non-cone sparse checkout",
      );
      expect(headOf(checkout)).toBe(before);
      expect(
        calls.some(
          (args) =>
            args[2] === "sparse-checkout" &&
            ["add", "set", "disable"].includes(args[3] ?? ""),
        ),
      ).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rolls back a sparse update when final version labeling fails", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-label-rollback-");
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      const target = await commitFixtureFiles(
        remote,
        {
          ".tx/config.json":
            '{"plugins":[{"name":"tools","entry":"plugins/new/index.ts"}]}',
          "plugins/new/index.ts": entry,
        },
        "new label target",
      );
      fixtureGit(remote, ["tag", "v2.0.0"]);
      const before = headOf(checkout);
      const cones = sparseDirectories(checkout);
      let failLabel = false;
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        runGit: async (args, options) => {
          if (failLabel && args[2] === "describe" && args.at(-1) === target) {
            throw new Error("cannot label target");
          }
          return runGit(args, options);
        },
        prepare: async () => {},
      });
      const item = gathered(await participant.gather());
      failLabel = true;

      await expect(participant.apply(item)).rejects.toThrow(
        "cannot label target. The previous commit was restored",
      );
      expect(headOf(checkout)).toBe(before);
      expect(sparseDirectories(checkout)).toEqual(cones);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("redacts checkout credentials from sparse fallback failures", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-sparse-secret-");
    try {
      const { remote, root, checkout } =
        await installSparseClone(temporaryRoot);
      await commitFixtureFiles(
        remote,
        {
          ".tx/config.json":
            '{"plugins":[{"name":"tools","entry":"plugins/new/index.ts"}]}',
          "plugins/new/index.ts": entry,
        },
        "secret failure target",
      );
      fixtureGit(remote, ["tag", "v2.0.0"]);
      const env = Object.freeze({ ...process.env, TX_TEST_MARKER: "present" });
      const environments: Readonly<Record<string, string | undefined>>[] = [];
      let failSparse = false;
      const source = "https://user:top-secret@example.com/acme/tools.git";
      const participant = new MarketplaceUpdater(root, {
        env,
        runGit: async (args, options) => {
          if (
            failSparse &&
            args[2] === "sparse-checkout" &&
            (args[3] === "add" || args[3] === "disable")
          ) {
            environments.push(options.env);
            throw new Error(`Git failed for ${source}`);
          }
          return runGit(args, options);
        },
        prepare: async () => {},
      });
      const item = gathered(await participant.gather());
      fixtureGit(checkout, ["config", "remote.origin.url", source]);
      failSparse = true;

      const failure = await participant.apply(item).catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain("top-secret");
      expect((failure as Error).message).not.toContain("user@");
      expect((failure as Error).message).toContain(
        "https://example.com/acme/tools.git",
      );
      expect(environments).toHaveLength(2);
      for (const applied of environments) {
        const { GIT_TERMINAL_PROMPT, TX_TEST_MARKER } = applied;
        expect(GIT_TERMINAL_PROMPT).toBe("0");
        expect(TX_TEST_MARKER).toBe("present");
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  for (const restoration of [
    {
      name: "commit restoration",
      commitFails: true,
      sparseFails: false,
      expected: "Restoring commit",
    },
    {
      name: "sparse restoration",
      commitFails: false,
      sparseFails: true,
      expected: "restoring the sparse checkout failed",
    },
    {
      name: "both restorations",
      commitFails: true,
      sparseFails: true,
      expected: "Restoring the sparse checkout also failed",
    },
  ]) {
    test(`preserves the primary failure when ${restoration.name} fails`, async () => {
      const temporaryRoot = await temporaryDirectory("tx-update-restore-pair-");
      try {
        const { remote, root, checkout } =
          await installSparseClone(temporaryRoot);
        const target = await commitFixtureFiles(
          remote,
          {
            ".tx/config.json":
              '{"plugins":[{"name":"tools","entry":"plugins/new/index.ts"}]}',
            "plugins/new/index.ts": entry,
          },
          "restoration target",
        );
        fixtureGit(remote, ["tag", "v2.0.0"]);
        const before = headOf(checkout);
        let sparseRestorations = 0;
        const participant = new MarketplaceUpdater(root, {
          env: process.env,
          runGit: async (args, options) => {
            if (
              restoration.commitFails &&
              args[2] === "checkout" &&
              args.includes("--force")
            ) {
              throw new Error("commit restore unavailable");
            }
            if (args[2] === "sparse-checkout" && args[3] === "set") {
              sparseRestorations += 1;
              if (restoration.sparseFails) {
                throw new Error("sparse restore unavailable");
              }
            }
            return runGit(args, options);
          },
          prepare: async () => {
            throw new Error("primary dependency failure");
          },
        });

        const failure = await participant
          .apply(gathered(await participant.gather()))
          .catch((error) => error);
        expect((failure as Error).message).toStartWith(
          "primary dependency failure",
        );
        expect((failure as Error).message).toContain(restoration.expected);
        expect(sparseRestorations).toBe(1);
        expect(headOf(checkout)).toBe(
          restoration.commitFails ? target : before,
        );
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

describe("pinned marketplace updates", () => {
  test("keeps a tag pin where it is and notes the newer tag", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-pinned-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      pin(checkout, "v1.0.0");
      await publishSecondVersion(remote);
      const before = headOf(checkout);
      const participant = updater(root, async () => {
        throw new Error("Preparation must not run for a pinned checkout");
      });

      // Reported, because a user who pinned a version still wants to learn a
      // newer one exists; not applied, because moving them off the version
      // they pinned without being asked would defeat the pin.
      expect(await participant.gather()).toEqual([
        {
          name: "tools",
          current: "v1.0.0",
          detail: "pinned to v1.0.0; the remote publishes v2.0.0",
        },
      ]);
      expect(
        await participant.apply({ name: "tools", current: "v1.0.0" }),
      ).toEqual({ applied: false });
      expect(headOf(checkout)).toBe(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports the highest release above the pin, and no pre-release", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-higher-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      pin(checkout, "v1.0.0");
      await commitFixtureFiles(remote, { "README.txt": "second\n" }, "second");
      // Higher, lower than the highest, not a version at all, and one the
      // publisher has not offered yet: only one of these is reportable.
      for (const tag of [
        "v10.0.0",
        "v1.5.0+build-7",
        "nightly",
        "v11.0.0-rc.1",
      ]) {
        fixtureGit(remote, ["tag", tag]);
      }

      expect(gathered(await updater(root, unprepared).gather()).detail).toBe(
        "pinned to v1.0.0; the remote publishes v10.0.0",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports no comparison for a pre-release above the pin", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-prerelease-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      pin(checkout, "v1.0.0");
      await commitFixtureFiles(remote, { "README.txt": "second\n" }, "second");
      fixtureGit(remote, ["tag", "v2.0.0-beta.1"]);

      expect(await updater(root, unprepared).gather()).toEqual([
        { name: "tools", current: "v1.0.0", detail: "pinned to v1.0.0" },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports the first ordinary release above a pre-release pin", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-beta-pin-");
    try {
      const { remote, root, checkout } = await installClone(
        temporaryRoot,
        "tools",
        false,
      );
      fixtureGit(remote, ["tag", "v1.0.0-beta.1"]);
      pin(checkout, "v1.0.0-beta.1");
      await publishSecondVersion(remote);
      // The release the pre-release led to is higher than it, and the ordinary
      // tag above them both is what a user is told about.
      fixtureGit(remote, ["tag", "v1.0.0"]);

      expect(gathered(await updater(root, unprepared).gather()).detail).toBe(
        "pinned to v1.0.0-beta.1; the remote publishes v2.0.0",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("compares nothing for a branch pin that is spelled like a version", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-branch-named-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      const branch = fixtureGit(remote, ["symbolic-ref", "--short", "HEAD"]);
      // A maintenance branch named like a release, which is a real habit and
      // is still not a release: there is nothing above a branch to move to.
      fixtureGit(remote, ["checkout", "--quiet", "-b", "v1.5.0"]);
      await commitFixtureFiles(remote, { "README.txt": "branch\n" }, "branch");
      fixtureGit(remote, ["checkout", "--quiet", branch]);
      await publishSecondVersion(remote);
      pin(checkout, "v1.5.0");

      const item = gathered(await updater(root, async () => {}).gather());
      expect(item.detail).toBe("pinned to v1.5.0");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("compares nothing for a pin that is not a semantic version", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-branch-pin-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      const branch = fixtureGit(remote, ["symbolic-ref", "--short", "HEAD"]);
      fixtureGit(remote, ["checkout", "--quiet", "-b", "release/1.4"]);
      const target = await commitFixtureFiles(
        remote,
        { "README.txt": "release\n" },
        "release",
      );
      fixtureGit(remote, ["checkout", "--quiet", branch]);
      await publishSecondVersion(remote);
      pin(checkout, "release/1.4");
      const participant = updater(root, async () => {});

      const item = gathered(await participant.gather());
      // A branch pin follows its branch rather than the default one, and a pin
      // that is not a semantic version is compared against nothing.
      expect(item.detail).toBe("pinned to release/1.4");
      expect((await participant.apply(item)).applied).toBe(true);
      expect(headOf(checkout)).toBe(target);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("follows a tag the remote moved", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-moved-tag-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      pin(checkout, "v1.0.0");
      const target = await commitFixtureFiles(
        remote,
        { "README.txt": "second\n" },
        "second",
      );
      // The pin names the ref, so it is whatever `v1.0.0` is now.
      fixtureGit(remote, ["tag", "--force", "v1.0.0"]);
      const participant = updater(root, async () => {});

      const item = gathered(await participant.gather());
      expect(item.available).toBe("v1.0.0");
      expect((await participant.apply(item)).applied).toBe(true);
      expect(headOf(checkout)).toBe(target);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("moves a pinned checkout backwards, which an unpinned one is refused", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-backwards-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      const first = headOf(checkout);
      await publishSecondVersion(remote);
      const participant = updater(root, async () => {});

      // Forward first, unpinned, exactly as any marketplace moves.
      await participant.apply(gathered(await participant.gather()));
      expect(headOf(checkout)).not.toBe(first);

      pin(checkout, "v1.0.0");
      const item = gathered(await participant.gather());
      expect(item).toEqual({
        name: "tools",
        current: "v2.0.0",
        available: "v1.0.0",
        detail: "pinned to v1.0.0; the remote publishes v2.0.0",
      });
      expect(await participant.apply(item)).toEqual({
        applied: true,
        version: "v1.0.0",
      });
      expect(headOf(checkout)).toBe(first);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports a pin the remote no longer publishes, naming the pin commands", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-lost-pin-");
    try {
      const { root, checkout } = await installClone(temporaryRoot);
      pin(checkout, "v9.9.9");
      const participant = updater(root, unprepared);
      const failure =
        'Version "v9.9.9" is not published by the remote. Run "tx marketplace pin tools <ref>" or "tx marketplace unpin tools".';

      expect(await participant.gather()).toEqual([
        { name: "tools", current: "v1.0.0", failure },
      ]);
      // The ref can go between gathering and applying, so applying answers the
      // same way rather than with a bare resolution failure and no remedy.
      await expect(
        participant.apply({ name: "tools", current: "v1.0.0" }),
      ).rejects.toThrow(failure);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("does not follow the default branch when reading the pin fails operationally", async () => {
    const temporaryRoot = await temporaryDirectory(
      "tx-update-pin-read-failed-",
    );
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      pin(checkout, "v1.0.0");
      await publishSecondVersion(remote);
      const runWithFailedPinRead: RunGit = async (args, options) => {
        if (args.includes("--null") && args.includes("--list")) {
          throw new Error("Git command failed: pin config unreadable");
        }
        return runGit(args, options);
      };
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        prepare: unprepared,
        runGit: runWithFailedPinRead,
      });

      expect(await participant.gather()).toEqual([
        {
          name: "tools",
          current: "v1.0.0",
          failure:
            'Git command failed: pin config unreadable. Run "tx marketplace remove tools" to remove it.',
        },
      ]);
      await expect(
        participant.apply({ name: "tools", current: "v1.0.0" }),
      ).rejects.toThrow("Git command failed: pin config unreadable");
      expect(headOf(checkout)).not.toBe(
        fixtureGit(checkout, ["rev-parse", "refs/remotes/origin/HEAD"]),
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("does not give pin guidance for an operational ref probe failure", async () => {
    const temporaryRoot = await temporaryDirectory(
      "tx-update-ref-read-failed-",
    );
    try {
      const { root, checkout } = await installClone(temporaryRoot);
      pin(checkout, "v1.0.0");
      const runWithFailedRefRead: RunGit = async (args, options) => {
        if (args.some((arg) => arg.startsWith("refs/tags/v1.0.0"))) {
          throw new Error("Git command failed: ref database unreadable");
        }
        return runGit(args, options);
      };
      const participant = new MarketplaceUpdater(root, {
        env: process.env,
        prepare: unprepared,
        runGit: runWithFailedRefRead,
      });

      const item = gathered(await participant.gather());
      expect(item.failure).toBe(
        'Git command failed: ref database unreadable. Run "tx marketplace remove tools" to remove it.',
      );
      expect(item.failure).not.toContain("tx marketplace pin");

      const failure = await participant
        .apply({ name: "tools", current: "v1.0.0" })
        .then(
          () => "",
          (error: Error) => error.message,
        );
      expect(failure).toBe("Git command failed: ref database unreadable");
      expect(failure).not.toContain("tx marketplace pin");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports a tag the remote withdrew after it was pinned", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-withdrawn-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      pin(checkout, "v1.0.0");
      // What yanking a bad release looks like: the tag the user pinned is not
      // published any more, though this checkout still holds a copy of it.
      fixtureGit(remote, ["tag", "--delete", "v1.0.0"]);

      const item = gathered(await updater(root, unprepared).gather());
      expect(item.failure).toBe(
        'Version "v1.0.0" is not published by the remote. Run "tx marketplace pin tools <ref>" or "tx marketplace unpin tools".',
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("does not answer a withdrawn branch pin from the clone's own branch", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-local-branch-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      const branch = fixtureGit(remote, ["symbolic-ref", "--short", "HEAD"]);
      pin(checkout, branch);
      // The remote renames the branch away. The clone still holds a local
      // branch of that name — cloning creates one — so a resolution that read
      // the checkout rather than the remote would report the pin as fine.
      fixtureGit(remote, ["branch", "--move", `${branch}-renamed`]);

      const item = gathered(await updater(root, unprepared).gather());
      expect(item.failure).toBe(
        `Version "${branch}" is not published by the remote. Run "tx marketplace pin tools <ref>" or "tx marketplace unpin tools".`,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("does not answer a hash pin the remote does not publish", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-local-commit-");
    try {
      const { root, checkout } = await installClone(temporaryRoot);
      // A commit that exists in this checkout's object database and nowhere on
      // the remote, which is what a hash has to be checked against.
      const local = await commitFixtureFiles(
        checkout,
        { "README.txt": "mine\n" },
        "mine",
      );
      fixtureGit(checkout, ["checkout", "--quiet", "--detach", "HEAD~1"]);
      pin(checkout, local);

      const item = gathered(await updater(root, unprepared).gather());
      expect(item.failure).toBe(
        `Version "${local}" is not published by the remote. Run "tx marketplace pin tools <ref>" or "tx marketplace unpin tools".`,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("names re-pinning when an unpinned checkout sits on a commit the remote still has", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-diverged-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      const branch = fixtureGit(remote, ["symbolic-ref", "--short", "HEAD"]);
      fixtureGit(remote, ["checkout", "--quiet", "-b", "release/1.4"]);
      await commitFixtureFiles(
        remote,
        { "README.txt": "release\n" },
        "release",
      );
      fixtureGit(remote, ["checkout", "--quiet", branch]);
      await publishSecondVersion(remote);
      // Where unpinning a marketplace pinned to a side branch leaves it: the
      // checkout is on a commit the remote publishes and the default branch
      // does not contain.
      pin(checkout, "release/1.4");
      const participant = updater(root, async () => {});
      await participant.apply(gathered(await participant.gather()));
      fixtureGit(checkout, ["config", "--local", "--unset", "tx.pin"]);
      const before = headOf(checkout);

      const item = gathered(await participant.gather());
      expect(item.detail).toBe(
        'blocked: the installed commit is not an ancestor of what this marketplace tracks; pin it with "tx marketplace pin tools <ref>", or run "tx marketplace remove tools" and add it again',
      );
      await expect(participant.apply(item)).rejects.toThrow(
        'pin it with "tx marketplace pin tools <ref>"',
      );
      expect(headOf(checkout)).toBe(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("resumes tracking the default branch once the pin is cleared", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-unpinned-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      pin(checkout, "v1.0.0");
      const target = await publishSecondVersion(remote);
      const participant = updater(root, async () => {});

      await new MarketplaceManager(root, {
        env: process.env,
        prepare: async () => {},
      }).unpin("tools");

      const item = gathered(await participant.gather());
      expect(item).toEqual({
        name: "tools",
        current: "v1.0.0",
        available: "v2.0.0",
      });
      expect(await participant.apply(item)).toEqual({
        applied: true,
        version: "v2.0.0",
      });
      expect(headOf(checkout)).toBe(target);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("marketplace update environment", () => {
  test("fetches non-interactively and reads everything else as tx was invoked", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-env-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const checkout = join(root, "stub");
      await mkdir(checkout, { recursive: true });
      const env = Object.freeze({ PATH: "/test/bin", TOKEN: "secret" });
      const calls: {
        readonly args: readonly string[];
        readonly env: Readonly<Record<string, string | undefined>>;
      }[] = [];
      const runGit: RunGit = async (args, options) => {
        calls.push({ args: [...args], env: options.env });
        // How `git config --get` reports a variable that is not set.
        if (args.includes("core.sshCommand")) {
          throw new Error("Git command failed");
        }
        const [command, ...rest] = args.slice(2);
        if (command === "rev-parse") {
          return { stdout: `${rest[0] === "HEAD" ? "aaaa" : "bbbb"}\n` };
        }
        if (command === "describe") {
          return {
            stdout: `${rest.at(-1) === "aaaa" ? "v1.0.0" : "v2.0.0"}\n`,
          };
        }
        if (command === "rev-list") return { stdout: "0\n" };
        return { stdout: "\n" };
      };

      expect(
        await new MarketplaceUpdater(root, { env, runGit }).gather(),
      ).toEqual([{ name: "stub", current: "v1.0.0", available: "v2.0.0" }]);

      expect(calls.map(({ args }) => args)).toEqual([
        ["-C", checkout, "rev-parse", "HEAD"],
        ["-C", checkout, "describe", "--tags", "--always", "aaaa"],
        // The checkout's own configuration is asked first: a fetch runs inside
        // it, so Git applies it and it outranks both files.
        ["-C", checkout, "config", "--local", "--get", "core.sshCommand"],
        ["config", "--global", "--get", "core.sshCommand"],
        ["config", "--system", "--get", "core.sshCommand"],
        // Forced and pruning, so the refs this checkout holds are the ones the
        // remote publishes now: a moved tag moves rather than failing the
        // fetch for clobbering a local one, and a withdrawn ref goes rather
        // than answering a pin nobody publishes any more.
        [
          "-C",
          checkout,
          "fetch",
          "--tags",
          "--force",
          "--prune",
          "--prune-tags",
          "origin",
        ],
        ["-C", checkout, "remote", "set-head", "origin", "--auto"],
        // Read again now the fetch has brought the tags in, since a tag added
        // to the installed commit changes what it is called.
        ["-C", checkout, "describe", "--tags", "--always", "aaaa"],
        ["-C", checkout, "config", "--local", "--null", "--list"],
        ["-C", checkout, "rev-parse", "refs/remotes/origin/HEAD"],
        ["-C", checkout, "diff", "--name-only", "HEAD", "--"],
        ["-C", checkout, "rev-list", "--count", "bbbb..aaaa", "--"],
        ["-C", checkout, "describe", "--tags", "--always", "bbbb"],
      ]);
      // Only the two operations that reach the remote are non-interactive.
      // `tx update` walks every installed marketplace, so one credential or
      // host-key prompt would stall the whole run.
      const nonInteractive = {
        PATH: "/test/bin",
        TOKEN: "secret",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      };
      expect(calls[5]?.env).toEqual(nonInteractive);
      expect(calls[6]?.env).toEqual(nonInteractive);
      // Everything else — the probes that settled that default included —
      // keeps the invoking environment, by reference and unmodified.
      for (const index of [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12]) {
        expect(calls[index]?.env).toBe(env);
      }
      expect(env).toEqual({ PATH: "/test/bin", TOKEN: "secret" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps an SSH command the checkout's own configuration names", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-local-ssh-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const checkout = join(root, "keyed");
      await mkdir(checkout, { recursive: true });
      const env = Object.freeze({ PATH: "/test/bin" });
      const calls: {
        readonly args: readonly string[];
        readonly env: Readonly<Record<string, string | undefined>>;
      }[] = [];
      const runGit: RunGit = async (args, options) => {
        calls.push({ args: [...args], env: options.env });
        if (args.includes("core.sshCommand")) {
          // Configured in the checkout's own repository, which is where a
          // per-marketplace deploy key is pinned.
          if (args.includes("--local")) {
            return { stdout: "ssh -i /run/secrets/deploy_key\n" };
          }
          throw new Error("Git command failed");
        }
        const [command] = args.slice(2);
        if (command === "rev-parse") return { stdout: "aaaa\n" };
        if (command === "describe") return { stdout: "v1.0.0\n" };
        return { stdout: "\n" };
      };

      await new MarketplaceUpdater(root, { env, runGit }).gather();

      // The global and system files are never reached, and the fetch runs
      // under the user's own SSH command rather than the batch-mode default.
      expect(
        calls.filter(({ args }) => args.includes("core.sshCommand")),
      ).toHaveLength(1);
      const fetched = calls.find(({ args }) => args.includes("fetch"));
      expect(fetched?.env).toEqual({
        PATH: "/test/bin",
        GIT_TERMINAL_PROMPT: "0",
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("marketplace update failures", () => {
  test("reports an unreachable remote as itself, without advising removal", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-unreachable-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      await mkdir(join(root, "stub"), { recursive: true });
      const runGit: RunGit = async (args) => {
        if (args.includes("core.sshCommand")) {
          throw new Error("Git command failed");
        }
        const [command, ...rest] = args.slice(2);
        if (command === "fetch") {
          throw new Error("Git command failed: could not read from remote");
        }
        // A checkout that cannot even name its remote still reports the
        // failure that matters, with nothing to redact against.
        if (rest.includes("remote.origin.url")) {
          throw new Error("Git command failed");
        }
        if (command === "rev-parse") return { stdout: "aaaa\n" };
        if (command === "describe") return { stdout: "v1.0.0\n" };
        return { stdout: "\n" };
      };

      expect(
        await new MarketplaceUpdater(root, { env: {}, runGit }).gather(),
      ).toEqual([
        {
          name: "stub",
          // The version the checkout is on is known before the remote is
          // asked, so a failed fetch still reports it.
          current: "v1.0.0",
          failure:
            "Git command failed: could not read from remote. Check that the marketplace's remote is reachable, then retry.",
        },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps the recorded remote's credential out of a fetch failure", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-secret-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      await mkdir(join(root, "stub"), { recursive: true });
      const source = "https://x-access-token:ghp_secret@example.com/acme/t.git";
      const runGit: RunGit = async (args) => {
        if (args.includes("core.sshCommand")) {
          throw new Error("Git command failed");
        }
        const [command, ...rest] = args.slice(2);
        if (command === "fetch") {
          // Git quotes the URL it was working with, credential and all.
          throw new Error(
            `Git command failed: fatal: could not read Username for '${source}'`,
          );
        }
        if (rest.includes("remote.origin.url"))
          return { stdout: `${source}\n` };
        if (command === "rev-parse") return { stdout: "aaaa\n" };
        if (command === "describe") return { stdout: "v1.0.0\n" };
        return { stdout: "\n" };
      };

      const [item] = await new MarketplaceUpdater(root, {
        env: {},
        runGit,
      }).gather();

      expect(item?.failure).not.toContain("ghp_secret");
      expect(item?.failure).not.toContain("x-access-token");
      // The host and path survive, because a user reads them to work out what
      // failed; only the credential run is taken out.
      expect(item?.failure).toContain("https://example.com/acme/t.git");
      expect(item?.failure).toEndWith(
        "Check that the marketplace's remote is reachable, then retry.",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("restores a checkout preparation left with modified tracked files", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-dirty-restore-");
    try {
      const { remote, root, checkout } = await installClone(temporaryRoot);
      await publishSecondVersion(remote, {
        "README.txt": "second\n",
        "lock.txt": "published\n",
      });
      const before = headOf(checkout);
      // What an ordinary dependency install does: rewrite a tracked file it
      // owns, and then fail. The rewritten file differs between the two
      // commits, so an unforced restoration refuses and leaves the checkout on
      // the commit that just failed validation.
      const participant = updater(root, async (moved) => {
        await writeFile(join(moved, "lock.txt"), "rewritten\n");
        throw new Error("trusted lifecycle failed");
      });

      const item = gathered(await participant.gather());
      await expect(participant.apply(item)).rejects.toThrow(
        "trusted lifecycle failed. The previous commit was restored; installed dependencies were not.",
      );

      expect(headOf(checkout)).toBe(before);
      expect(fixtureGit(checkout, ["status", "--porcelain"])).toBe("");
      expect(await readFile(join(checkout, "README.txt"), "utf8")).toBe(
        "first\n",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports the commit a failed restoration leaves the checkout on", async () => {
    const temporaryRoot = await temporaryDirectory("tx-update-restore-failed-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      await mkdir(join(root, "stub"), { recursive: true });
      const runGit: RunGit = async (args) => {
        const [command, ...rest] = args.slice(2);
        if (command === "rev-parse") {
          return { stdout: `${rest[0] === "HEAD" ? "aaaa" : "bbbb"}\n` };
        }
        if (command === "rev-list") return { stdout: "0\n" };
        // Moving forward works; putting the previous commit back does not.
        if (command === "checkout" && rest.at(-1) === "aaaa") {
          throw new Error("Git command failed: cannot restore");
        }
        return { stdout: "\n" };
      };

      const participant = new MarketplaceUpdater(root, {
        env: {},
        runGit,
        prepare: async () => {
          throw new Error("Invalid .tx/config.json");
        },
      });

      // The preparation failure stays the headline, the restoration failure is
      // reported beside it, and the commit the checkout is stuck on is named.
      await expect(
        participant.apply({ name: "stub", current: "aaaa" }),
      ).rejects.toThrow(
        "Invalid .tx/config.json. Restoring commit aaaa failed too, so the checkout is left on bbbb: Git command failed: cannot restore",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
