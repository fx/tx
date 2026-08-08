import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { UpdateItem } from "@fx/tx/plugin";
import {
  MarketplaceManager,
  type RunGit,
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
        ["-C", checkout, "config", "--local", "--get", "tx.pin"],
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
