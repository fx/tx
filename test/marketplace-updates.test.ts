import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { UpdateItem } from "@fx/tx/plugin";
import type { RunGit } from "../plugins/marketplace/manager.ts";
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
        ["-C", checkout, "fetch", "--tags", "origin"],
        ["-C", checkout, "remote", "set-head", "origin", "--auto"],
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
      for (const index of [0, 1, 2, 3, 4, 7, 8, 9, 10]) {
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
        const [command] = args.slice(2);
        if (command === "fetch") {
          throw new Error("Git command failed: could not read from remote");
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
