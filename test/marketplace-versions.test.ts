import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MarketplaceManager,
  type RunGit,
} from "../plugins/marketplace/manager.ts";
import {
  carriesGitSyntax,
  parseGitSourceVersion,
} from "../plugins/marketplace/source.ts";
import {
  commitFixtureFiles,
  createGitRepository,
  fixtureGit,
  temporaryDirectory,
  writeFixtureFiles,
} from "./helpers.ts";

const manifest = '{"plugins":[{"name":"tools","entry":"plugin.ts"}]}';
const entry = "export default () => {};\n";

/**
 * Every source form `marketplace add` accepts, each one exercised below with
 * and without a version suffix. `git@host:owner/repository.git` is the case
 * that matters most: a parser reading the last `@` anywhere in the string
 * takes its SSH login for a version and fails this table.
 */
const sourceForms: readonly (readonly [string, string, boolean])[] = [
  ["bare shorthand", "fx/cc", false],
  ["HTTP(S)", "https://example.com/owner/repository.git", true],
  ["HTTP(S) with userinfo", "https://token@example.com/owner/repo.git", true],
  ["HTTP(S) with a password", "https://me:pw@example.com/owner/repo.git", true],
  ["SCP-style", "git@example.com:owner/repository.git", true],
  ["SCP-style without a user", "example.com:owner/repository.git", true],
  ["ssh://", "ssh://git@example.com/owner/repository.git", true],
  ["file://", "file:///srv/git/repository.git", true],
  ["bare path", "/srv/git/repository.git", false],
  ["Windows drive letter", "C:\\repos\\repository", false],
];

const rejectGit: RunGit = async () => {
  throw new Error("Git must not run");
};

/**
 * A remote publishing everything a version can name: a tagged first commit, a
 * branch whose name contains `/`, and a second commit tagged on the default
 * branch. Every source below is a `file://` URL onto it, so the clones are
 * real Git clones that reach no network.
 */
async function createVersionedRemote(root: string): Promise<{
  readonly remote: string;
  readonly first: string;
  readonly release: string;
  readonly second: string;
  readonly branch: string;
}> {
  const remote = await createGitRepository(root, "tools", {
    ".tx/config.json": manifest,
    "plugin.ts": entry,
    "README.txt": "first\n",
  });
  const branch = fixtureGit(remote, ["symbolic-ref", "--short", "HEAD"]);
  fixtureGit(remote, ["tag", "v1.0.0"]);
  const first = fixtureGit(remote, ["rev-parse", "HEAD"]);

  fixtureGit(remote, ["checkout", "--quiet", "-b", "release/1.4"]);
  const release = await commitFixtureFiles(
    remote,
    { "README.txt": "release\n" },
    "release",
  );

  fixtureGit(remote, ["checkout", "--quiet", branch]);
  const second = await commitFixtureFiles(
    remote,
    { "README.txt": "second\n" },
    "second",
  );
  fixtureGit(remote, ["tag", "v2.0.0"]);
  return { remote, first, release, second, branch };
}

function manager(root: string, cwd: string): MarketplaceManager {
  return new MarketplaceManager(root, {
    cwd,
    env: process.env,
    prepare: async () => {},
  });
}

function pinOf(checkout: string): string {
  return fixtureGit(checkout, ["config", "--local", "--get", "tx.pin"]);
}

describe("Git source version suffixes", () => {
  test.each(sourceForms)("reads %s as unpinned", (_label, source) => {
    expect(parseGitSourceVersion(source)).toEqual({ source });
  });

  test.each(sourceForms)("reads a version suffix on %s", (_label, source) => {
    expect(parseGitSourceVersion(`${source}@1.4.0`)).toEqual({
      source,
      ref: "1.4.0",
    });
  });

  // The case an authority-blind separator rule silently gets wrong: the ref's
  // own `/` moves the source's last slash past the `@`.
  test.each(sourceForms)("reads a ref containing / on %s", (_label, source) => {
    expect(parseGitSourceVersion(`${source}@release/1.4`)).toEqual({
      source,
      ref: "release/1.4",
    });
  });

  test.each(sourceForms)(
    "classifies %s as Git syntax or not",
    (_label, source, git) => {
      expect(carriesGitSyntax(source)).toBe(git);
      // The suffix never changes what a source is: classification decides that
      // from the argument as typed, and both read the same authority rule.
      expect(carriesGitSyntax(`${source}@1.4.0`)).toBe(git);
    },
  );

  test.each(["fx/cc@", "git@example.com:owner/repository.git@"])(
    "rejects the empty version in %s",
    (source) =>
      expect(() => parseGitSourceVersion(source)).toThrow(
        "names an empty version",
      ),
  );

  test("leaves an authority with no path unsplit", () => {
    const source = "https://user@example.com";
    expect(parseGitSourceVersion(source)).toEqual({ source });
  });

  test("leaves a leading separator alone rather than emptying the source", () => {
    expect(parseGitSourceVersion("@1.4.0")).toEqual({ source: "@1.4.0" });
  });

  test("splits a ref whose own name contains @ in the wrong place, loudly", () => {
    // The documented limitation: no separator rule can tell which `@` was
    // meant, so the addition fails against a source the user can read back
    // rather than silently installing something else. `marketplace pin` takes
    // such a ref as an argument of its own.
    expect(parseGitSourceVersion("fx/cc@release@beta")).toEqual({
      source: "fx/cc@release",
      ref: "beta",
    });
  });
});

describe("adding a pinned marketplace", () => {
  test("installs the commit a tag names, records the pin, and drops the suffix from the name", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-add-tag-");
    try {
      const { remote, first } = await createVersionedRemote(temporaryRoot);
      const root = join(temporaryRoot, "marketplaces");
      const source = `${pathToFileURL(remote).href}@v1.0.0`;

      expect(await manager(root, temporaryRoot).add(source)).toBe("tools");

      const checkout = join(root, "tools");
      expect(fixtureGit(checkout, ["rev-parse", "HEAD"])).toBe(first);
      expect(pinOf(checkout)).toBe("v1.0.0");
      expect(await manager(root, temporaryRoot).list()).toEqual([
        {
          name: "tools",
          source: pathToFileURL(remote).href,
          version: "v1.0.0",
        },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("retries a numeric version with a v prefix and records what the user typed", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-add-numeric-");
    try {
      const { remote, first } = await createVersionedRemote(temporaryRoot);
      const root = join(temporaryRoot, "marketplaces");

      await manager(root, temporaryRoot).add(
        `${pathToFileURL(remote).href}@1.0.0`,
      );

      const checkout = join(root, "tools");
      expect(fixtureGit(checkout, ["rev-parse", "HEAD"])).toBe(first);
      // As the user spelled it: the pin is re-resolved on every update, and
      // the retry that found `v1.0.0` runs again there.
      expect(pinOf(checkout)).toBe("1.0.0");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("installs a branch whose name contains a slash", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-add-branch-");
    try {
      const { remote, release } = await createVersionedRemote(temporaryRoot);
      const root = join(temporaryRoot, "marketplaces");

      await manager(root, temporaryRoot).add(
        `${pathToFileURL(remote).href}@release/1.4`,
      );

      const checkout = join(root, "tools");
      expect(fixtureGit(checkout, ["rev-parse", "HEAD"])).toBe(release);
      expect(pinOf(checkout)).toBe("release/1.4");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("installs a commit named by its hash", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-add-commit-");
    try {
      const { remote, first } = await createVersionedRemote(temporaryRoot);
      const root = join(temporaryRoot, "marketplaces");

      await manager(root, temporaryRoot).add(
        `${pathToFileURL(remote).href}@${first}`,
      );

      const checkout = join(root, "tools");
      expect(fixtureGit(checkout, ["rev-parse", "HEAD"])).toBe(first);
      expect(pinOf(checkout)).toBe(first);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("publishes nothing when the version resolves nowhere", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-add-missing-");
    try {
      const { remote } = await createVersionedRemote(temporaryRoot);
      const root = join(temporaryRoot, "marketplaces");

      await expect(
        manager(root, temporaryRoot).add(
          `${pathToFileURL(remote).href}@v9.9.9`,
        ),
      ).rejects.toThrow('Version "v9.9.9" is not published by the remote');

      // Staging is discarded exactly as it is for any other publication
      // failure, so nothing is left behind under the marketplace root.
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects an empty version before Git runs", async () => {
    const rejecting = new MarketplaceManager("/unused", {
      runGit: rejectGit,
      prepare: async () => {},
    });

    await expect(rejecting.add("fx/cc@")).rejects.toThrow(
      'Marketplace source "fx/cc@" names an empty version; write "<source>@<ref>"',
    );
  });

  test("rejects a version on a source that names a local directory", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-add-local-");
    try {
      const source = join(temporaryRoot, "tools");
      await writeFixtureFiles(source, {
        ".tx/config.json": manifest,
        "plugin.ts": entry,
      });
      const root = join(temporaryRoot, "marketplaces");
      const rejecting = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async () => {},
      });

      await expect(rejecting.add("./tools@v1.0.0")).rejects.toThrow(
        'Marketplace source "./tools" is a local directory, so version "v1.0.0" cannot be pinned to it; a local marketplace is referenced live',
      );
      await expect(lstat(join(root, "tools"))).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("takes a real directory whose name contains @ as that directory", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-add-precedence-");
    try {
      const source = join(temporaryRoot, "tools@2");
      await writeFixtureFiles(source, {
        ".tx/config.json": manifest,
        "plugin.ts": entry,
      });
      const root = join(temporaryRoot, "marketplaces");
      const rejecting = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async () => {},
      });

      // Classification runs first and on the argument as typed, so no ref is
      // parsed and no Git command runs at all.
      expect(await rejecting.add("./tools@2")).toBe("tools@2");
      expect((await lstat(join(root, "tools@2"))).isSymbolicLink()).toBe(true);
      expect(await rejecting.list()).toEqual([
        { name: "tools@2", source, version: "live" },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("marketplace pin and unpin", () => {
  test("records a ref published after installation, without moving the checkout", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-command-");
    try {
      const { remote } = await createVersionedRemote(temporaryRoot);
      const root = join(temporaryRoot, "marketplaces");
      const installed = manager(root, temporaryRoot);
      await installed.add(pathToFileURL(remote).href);
      const checkout = join(root, "tools");
      const before = fixtureGit(checkout, ["rev-parse", "HEAD"]);
      // Published after the clone, so only the fetch `pin` runs can find it.
      await commitFixtureFiles(remote, { "README.txt": "third\n" }, "third");
      fixtureGit(remote, ["tag", "v3.0.0"]);

      expect(await installed.pin("tools", "v3.0.0")).toBe("v3.0.0");

      expect(pinOf(checkout)).toBe("v3.0.0");
      // Pinning states an intention; `tx update` is where intentions become
      // checkouts, with its own validation and restoration.
      expect(fixtureGit(checkout, ["rev-parse", "HEAD"])).toBe(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("leaves the previous pin in place when a ref resolves nowhere", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-rejected-");
    try {
      const { remote } = await createVersionedRemote(temporaryRoot);
      const root = join(temporaryRoot, "marketplaces");
      const installed = manager(root, temporaryRoot);
      await installed.add(`${pathToFileURL(remote).href}@v1.0.0`);

      await expect(installed.pin("tools", "v9.9.9")).rejects.toThrow(
        'Version "v9.9.9" is not published by the remote',
      );

      expect(pinOf(join(root, "tools"))).toBe("v1.0.0");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("clears a pin, and clearing an unpinned marketplace changes nothing", async () => {
    const temporaryRoot = await temporaryDirectory("tx-unpin-");
    try {
      const { remote } = await createVersionedRemote(temporaryRoot);
      const root = join(temporaryRoot, "marketplaces");
      const installed = manager(root, temporaryRoot);
      await installed.add(`${pathToFileURL(remote).href}@v1.0.0`);
      const checkout = join(root, "tools");

      await installed.unpin("tools");
      expect(
        fixtureGit(checkout, ["config", "--local", "--list"]),
      ).not.toContain("tx.pin");

      // Clearing a pin that is already clear is not a failure: `git config
      // --unset` would report one, so it is never reached twice.
      await installed.unpin("tools");
      expect(
        fixtureGit(checkout, ["config", "--local", "--list"]),
      ).not.toContain("tx.pin");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects pinning and unpinning a referenced local marketplace", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-reference-");
    try {
      const source = join(temporaryRoot, "linked");
      await writeFixtureFiles(source, {
        ".tx/config.json": manifest,
        "plugin.ts": entry,
      });
      const root = join(temporaryRoot, "marketplaces");
      await mkdir(root, { recursive: true });
      await symlink(source, join(root, "linked"));
      const rejecting = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async () => {},
      });

      const reason =
        'Marketplace "linked" is a live local reference, so there is no version to pin it to';
      await expect(rejecting.pin("linked", "v1.0.0")).rejects.toThrow(reason);
      await expect(rejecting.unpin("linked")).rejects.toThrow(reason);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("reports a marketplace that is not installed", async () => {
    const temporaryRoot = await temporaryDirectory("tx-pin-absent-");
    try {
      const root = join(temporaryRoot, "marketplaces");
      const rejecting = new MarketplaceManager(root, {
        cwd: temporaryRoot,
        runGit: rejectGit,
        prepare: async () => {},
      });

      await expect(rejecting.pin("tools", "v1.0.0")).rejects.toThrow(
        'Marketplace "tools" is not installed',
      );
      await expect(rejecting.unpin("tools")).rejects.toThrow(
        'Marketplace "tools" is not installed',
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
