import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import {
  createExecutablePlugin,
  type ExecutableUpdaterOptions,
} from "../plugins/executable/index.ts";
import {
  type CommandResult,
  detectManager,
  discardStaged,
  ExecutableUpdater,
  type FetchResource,
  isCompiledModulePath,
  isNewerRelease,
  type ManagerKind,
  publishedChecksum,
  type RunCommand,
  runCommand,
  stagingPath,
} from "../plugins/executable/updater.ts";
import updatePlugin from "../plugins/update/index.ts";
import { createRootProgram, dispatch, EXIT_SUCCESS } from "../src/commands.ts";
import type { UpdateItem } from "../src/plugin.ts";
import { coreDependencies, initializePlugins } from "../src/plugins.ts";
import {
  type CapturedContext,
  captureContext,
  temporaryDirectory,
  writeFixtureFiles,
} from "./helpers.ts";

const runningVersion = "1.2.0";
const publishedVersion = "1.3.0";
const releaseUrl = "https://api.github.com/repos/fx/tx/releases/latest";
const assetName = "tx-linux-x64";
const checksumName = "SHA256SUMS";
/** A stub standing in for the published executable. Nothing in this suite
 * downloads, executes, or replaces a real one. */
const stubExecutable = "#!/bin/sh\necho 1.3.0\n";
const installedBytes = "the executable that is already installed\n";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace(prefix: string): Promise<string> {
  const root = await temporaryDirectory(`tx-executable-${prefix}-`);
  roots.push(root);
  return root;
}

/** An installed executable the test owns, so replacement is asserted against a
 * filesystem rather than a mock. */
async function installedExecutable(
  root: string,
  path: string,
): Promise<string> {
  const target = join(root, path);
  await writeFixtureFiles(root, { [path]: installedBytes });
  await chmod(target, 0o755);
  return target;
}

function downloadUrl(tag: string, asset: string): string {
  return `https://github.com/fx/tx/releases/download/${tag}/${asset}`;
}

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function checksumDocument(digest: string, asset = assetName): string {
  return `${digest}  ${asset}\n${digestOf("unrelated")}  tx-linux-arm64\n`;
}

interface RecordedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

function header(
  request: RecordedRequest | undefined,
  name: string,
): string | undefined {
  return request?.headers[name];
}

interface StubbedFetch {
  readonly fetch: FetchResource;
  readonly requests: RecordedRequest[];
  urls(): readonly string[];
}

function stubFetch(
  routes: Readonly<Record<string, () => Response>>,
): StubbedFetch {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    urls: () => requests.map(({ url }) => url),
    fetch: (url, init) => {
      requests.push({ url, headers: { ...init.headers } });
      const route = routes[url];
      if (!route) throw new Error(`unexpected request to ${url}`);
      return Promise.resolve(route());
    },
  };
}

function releaseRoutes(tag: string): Record<string, () => Response> {
  return { [releaseUrl]: () => Response.json({ tag_name: tag }) };
}

function downloadRoutes(
  tag: string,
  executable: string,
  document: string,
): Record<string, () => Response> {
  return {
    [downloadUrl(tag, assetName)]: () => new Response(executable),
    [downloadUrl(tag, checksumName)]: () => new Response(document),
  };
}

const silentResult: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

interface StubbedRun {
  readonly run: RunCommand;
  readonly commands: string[][];
}

function recorder(
  answer: (
    command: readonly string[],
  ) => CommandResult | Promise<CommandResult> = () => silentResult,
): StubbedRun {
  const commands: string[][] = [];
  return {
    commands,
    run: (command) => {
      commands.push([...command]);
      return answer(command);
    },
  };
}

/** A compiled `tx` on the one platform an executable is published for. */
function options(
  overrides: ExecutableUpdaterOptions = {},
): ExecutableUpdaterOptions {
  return { compiled: true, platform: "linux-x64", env: {}, ...overrides };
}

const availableItem: UpdateItem = {
  name: "tx",
  current: runningVersion,
  available: publishedVersion,
};

describe("semantic version ordering", () => {
  test.each([
    ["1.3.0", "1.2.0", true],
    ["v1.3.0", "1.3.0", false],
    ["1.9.0", "1.10.0", false],
    ["2.0.0", "1.99.99", true],
    ["1.2.1", "1.2.0", true],
    ["1.3.0", "1.3.0-rc.1", true],
    ["1.3.0-rc.1", "1.3.0", false],
    ["1.3.0-rc.2", "1.3.0-rc.1", true],
    ["1.3.0-rc.1.1", "1.3.0-rc.1", true],
    ["1.3.0-alpha", "1.3.0-1", true],
    ["1.3.0-alpha", "1.3.0-beta", false],
    ["1.3.0+build.5", "1.3.0", false],
  ])("reads %p against %p as newer: %p", (published, running, newer) => {
    expect(isNewerRelease(published, running)).toBe(newer);
  });

  test.each(["", "1", "1.2", "1.2.3.4", "latest", "v1.2.x", "1.2.3-"])(
    "offers nothing for the unreadable version %p",
    (text) => {
      // Neither side may be coerced: reading `v1.2.x` as something above
      // `1.2.0` would offer an update from a tag nothing can download.
      expect(isNewerRelease(text, "1.2.0")).toBe(false);
      expect(isNewerRelease("9.9.9", text)).toBe(false);
    },
  );
});

describe("executable update gathering", () => {
  test("offers a strictly newer published release", async () => {
    const { fetch, urls } = stubFetch(releaseRoutes("v1.3.0"));
    const { run, commands } = recorder();
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ fetch, run }),
    );

    expect(await updater.gather()).toEqual([availableItem]);
    expect(urls()).toEqual([releaseUrl]);
    expect(commands).toEqual([]);
  });

  test.each(["v1.2.0", "v1.1.0", "nightly"])(
    "reports nothing to apply for the release %p",
    async (tag) => {
      const { fetch } = stubFetch(releaseRoutes(tag));
      const updater = new ExecutableUpdater(runningVersion, options({ fetch }));

      expect(await updater.gather()).toEqual([
        { name: "tx", current: runningVersion, detail: `latest ${tag}` },
      ]);
    },
  );

  test("reports nothing to apply when the running version is unreadable", async () => {
    const { fetch } = stubFetch(releaseRoutes("v1.3.0"));
    const updater = new ExecutableUpdater("dev", options({ fetch }));

    expect(await updater.gather()).toEqual([
      { name: "tx", current: "dev", detail: "latest v1.3.0" },
    ]);
  });

  test("accepts a published tag spelled without its v prefix", async () => {
    const { fetch } = stubFetch(releaseRoutes("1.3.0"));
    const updater = new ExecutableUpdater(runningVersion, options({ fetch }));

    expect(await updater.gather()).toEqual([availableItem]);
  });

  test.each([
    {
      env: {} as Record<string, string>,
      authorization: undefined as string | undefined,
    },
    { env: { GH_TOKEN: "first" }, authorization: "Bearer first" },
    { env: { GITHUB_TOKEN: "second" }, authorization: "Bearer second" },
    {
      env: { GH_TOKEN: "first", GITHUB_TOKEN: "second" },
      authorization: "Bearer first",
    },
    {
      env: { GH_TOKEN: "", GITHUB_TOKEN: "second" },
      authorization: "Bearer second",
    },
  ])(
    "sends the token $env names as $authorization",
    async ({ env, authorization }) => {
      const { fetch, requests } = stubFetch(releaseRoutes("v1.3.0"));
      const updater = new ExecutableUpdater(
        runningVersion,
        options({ fetch, env }),
      );

      await updater.gather();
      expect(header(requests[0], "authorization")).toBe(authorization);
      expect(header(requests[0], "user-agent")).toBe(`tx/${runningVersion}`);
    },
  );

  test("sends no token from any variable but the two it names", async () => {
    const { fetch, requests } = stubFetch(releaseRoutes("v1.3.0"));
    // The registry credential the installation guide has users configure is
    // exactly the one that must never reach the release host.
    const updater = new ExecutableUpdater(
      runningVersion,
      options({
        fetch,
        env: {
          GITHUB_PACKAGES_TOKEN: "secret",
          NPM_TOKEN: "secret",
          GH_ENTERPRISE_TOKEN: "secret",
          TOKEN: "secret",
        },
      }),
    );

    await updater.gather();
    expect(JSON.stringify(requests)).not.toContain("secret");
  });

  test.each([
    [
      (): Response => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
      "getaddrinfo ENOTFOUND",
    ],
    [(): Response => new Response("no", { status: 403 }), "403"],
    [(): Response => Response.json({}), "named no tag"],
    [(): Response => Response.json({ tag_name: "" }), "named no tag"],
  ])("fails a lookup that cannot answer (%#)", async (route, expected) => {
    const { fetch } = stubFetch({ [releaseUrl]: route });
    const updater = new ExecutableUpdater(runningVersion, options({ fetch }));

    await expect(updater.gather()).rejects.toThrow(expected);
  });
});

describe("executable update guards", () => {
  test.each([
    {
      guard: { compiled: false, platform: "linux-x64" },
      reason:
        "tx is running from a source checkout rather than as a compiled executable",
    },
    {
      guard: { compiled: true, platform: "darwin-arm64" },
      reason:
        "no executable is published for darwin-arm64 (published: linux-x64)",
    },
  ])(
    "withholds an available version and applies nothing ($reason)",
    async ({ guard, reason }) => {
      const { fetch, urls } = stubFetch(releaseRoutes("v1.3.0"));
      const { run, commands } = recorder();
      const root = await workspace("guard");
      const target = await installedExecutable(root, join("bin", "tx"));
      const updater = new ExecutableUpdater(
        runningVersion,
        options({ fetch, run, executablePath: target, ...guard }),
      );

      expect(await updater.gather()).toEqual([
        {
          name: "tx",
          current: runningVersion,
          detail: `${publishedVersion} is published but ${reason}`,
        },
      ]);
      expect(await updater.apply(availableItem)).toEqual({
        applied: false,
        detail: reason,
      });
      // Nothing is downloaded, executed, or replaced. Overwriting the Bun
      // runtime a source checkout is running on is the worst outcome available
      // here, so it is asserted directly.
      expect(urls()).toEqual([releaseUrl]);
      expect(commands).toEqual([]);
      expect(await readFile(target, "utf8")).toBe(installedBytes);
      expect(await readdir(dirname(target))).toEqual(["tx"]);
    },
  );

  test("applies nothing for an item carrying no available version", async () => {
    const { run, commands } = recorder();
    const updater = new ExecutableUpdater(runningVersion, options({ run }));

    expect(
      await updater.apply({ name: "tx", current: runningVersion }),
    ).toEqual({ applied: false, detail: "no published version to install" });
    expect(commands).toEqual([]);
  });
});

describe("executable update delegation", () => {
  test("runs mise's own upgrade for the tool mise says owns the path", async () => {
    const root = await workspace("mise");
    const store = join(root, ".local", "share", "mise", "installs");
    const target = await installedExecutable(
      root,
      join(
        ".local",
        "share",
        "mise",
        "installs",
        "github-fx-tx",
        "1.2.0",
        "bin",
        "tx",
      ),
    );
    const listing = JSON.stringify({
      bun: [{ version: "1.3.14", install_path: join(store, "bun", "1.3.14") }],
      "github:fx/tx": [
        {
          version: "1.2.0",
          install_path: join(store, "github-fx-tx", "1.2.0"),
        },
      ],
    });
    const { run, commands } = recorder((command) =>
      command[1] === "ls"
        ? { exitCode: 0, stdout: listing, stderr: "" }
        : { exitCode: 0, stdout: "mise github:fx/tx@1.3.0\n", stderr: "" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toEqual({
      applied: true,
      detail: '"mise upgrade github:fx/tx": mise github:fx/tx@1.3.0',
    });
    expect(commands).toEqual([
      ["mise", "ls", "--installed", "--json"],
      ["mise", "upgrade", "github:fx/tx"],
    ]);
    // No file inside the manager's store is replaced by tx.
    expect(await readFile(target, "utf8")).toBe(installedBytes);
  });

  test("runs npm's own install for the package npm says owns the path", async () => {
    const root = await workspace("npm");
    const target = await installedExecutable(
      root,
      join("lib", "node_modules", "@fx", "tx", "dist", "tx"),
    );
    const library = join(root, "lib");
    const listing = [
      `${library}:lib@`,
      `${join(library, "node_modules", "npm")}:npm@10.9.3`,
      `${join(library, "node_modules", "@fx", "tx")}:@fx/tx@1.2.0`,
      "not a listing line",
      "",
    ].join("\n");
    const { run, commands } = recorder((command) =>
      command[1] === "ls"
        ? { exitCode: 0, stdout: listing, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "added 1 package\n" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toEqual({
      applied: true,
      detail: '"npm install --global @fx/tx": added 1 package',
    });
    expect(commands).toEqual([
      ["npm", "ls", "--global", "--parseable", "--long"],
      ["npm", "install", "--global", "@fx/tx"],
    ]);
    expect(await readFile(target, "utf8")).toBe(installedBytes);
  });

  test.each([
    [
      { exitCode: 1, stdout: "", stderr: "mise: command not found\n" },
      "mise could not report which tool owns",
    ],
    [
      { exitCode: 0, stdout: "not json", stderr: "" },
      "mise did not report a readable list of installed tools",
    ],
    [
      { exitCode: 0, stdout: "null", stderr: "" },
      "mise did not report a readable list of installed tools",
    ],
    [
      {
        exitCode: 0,
        stdout: '{"bun":[{"install_path":"/elsewhere"},{}],"node":"broken"}',
        stderr: "",
      },
      "mise reported no tool owning",
    ],
  ])(
    "fails without replacing anything when mise cannot be interrogated (%#)",
    async (listing, expected) => {
      const root = await workspace("mise-broken");
      const target = await installedExecutable(
        root,
        join("mise", "installs", "github-fx-tx", "1.2.0", "bin", "tx"),
      );
      const { run, commands } = recorder(() => listing);
      const updater = new ExecutableUpdater(
        runningVersion,
        options({ run, executablePath: target }),
      );

      await expect(updater.apply(availableItem)).rejects.toThrow(expected);
      // The interrogation is the only command run: the participant never
      // writes into a store it does not own.
      expect(commands).toEqual([["mise", "ls", "--installed", "--json"]]);
      expect(await readFile(target, "utf8")).toBe(installedBytes);
    },
  );

  test.each([
    [
      { exitCode: 1, stdout: "", stderr: "npm ERR! code EACCES\n" },
      "npm could not report which package owns",
    ],
    [
      { exitCode: 0, stdout: "/elsewhere:elsewhere@1.0.0\n", stderr: "" },
      "npm reported no package owning",
    ],
  ])(
    "fails without replacing anything when npm cannot be interrogated (%#)",
    async (listing, expected) => {
      const root = await workspace("npm-broken");
      const target = await installedExecutable(
        root,
        join("lib", "node_modules", "@fx", "tx", "dist", "tx"),
      );
      const { run, commands } = recorder(() => listing);
      const updater = new ExecutableUpdater(
        runningVersion,
        options({ run, executablePath: target }),
      );

      await expect(updater.apply(availableItem)).rejects.toThrow(expected);
      expect(commands).toEqual([
        ["npm", "ls", "--global", "--parseable", "--long"],
      ]);
      expect(await readFile(target, "utf8")).toBe(installedBytes);
    },
  );

  test("fails when the manager's own upgrade fails", async () => {
    const root = await workspace("mise-upgrade");
    const target = await installedExecutable(
      root,
      join("mise", "installs", "tx", "1.2.0", "bin", "tx"),
    );
    const listing = JSON.stringify({
      tx: [{ install_path: join(root, "mise", "installs", "tx", "1.2.0") }],
    });
    const { run } = recorder((command) =>
      command[1] === "ls"
        ? { exitCode: 0, stdout: listing, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "no such tool\n" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    await expect(updater.apply(availableItem)).rejects.toThrow(
      '"mise upgrade tx" failed: no such tool',
    );
    expect(await readFile(target, "utf8")).toBe(installedBytes);
  });
});

describe("executable replacement", () => {
  interface Replacement {
    readonly updater: ExecutableUpdater;
    readonly target: string;
    readonly directory: string;
    readonly urls: () => readonly string[];
    readonly commands: string[][];
    readonly staged: { path: string; mode: number }[];
  }

  async function replacement(
    prefix: string,
    overrides: ExecutableUpdaterOptions = {},
    document = checksumDocument(digestOf(stubExecutable)),
    reported = publishedVersion,
  ): Promise<Replacement> {
    const root = await workspace(prefix);
    const target = await installedExecutable(root, join("bin", "tx"));
    const { fetch, urls } = stubFetch(
      downloadRoutes(`v${publishedVersion}`, stubExecutable, document),
    );
    const staged: { path: string; mode: number }[] = [];
    const { run, commands } = recorder(async (command) => {
      const path = command[0] ?? "";
      staged.push({ path, mode: (await stat(path)).mode });
      return { exitCode: 0, stdout: `${reported}\n`, stderr: "" };
    });
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ fetch, run, executablePath: target, ...overrides }),
    );
    return {
      updater,
      target,
      directory: dirname(target),
      urls,
      commands,
      staged,
    };
  }

  test("verifies, stages, runs, and renames the published executable", async () => {
    const { updater, target, urls, commands, staged, directory } =
      await replacement("replace");

    expect(await updater.apply(availableItem)).toEqual({
      applied: true,
      version: publishedVersion,
    });
    expect(urls()).toEqual([
      downloadUrl("v1.3.0", assetName),
      downloadUrl("v1.3.0", checksumName),
    ]);
    // Staged beside the target, with the executable bit set before it is run.
    expect(staged).toHaveLength(1);
    expect(dirname(staged[0]?.path ?? "")).toBe(directory);
    expect((staged[0]?.mode ?? 0) & 0o111).toBeGreaterThan(0);
    expect(commands[0]?.[1]).toBe("--version");
    expect(await readFile(target, "utf8")).toBe(stubExecutable);
    expect((await stat(target)).mode & 0o111).toBeGreaterThan(0);
    // One rename, and nothing staged survives it.
    expect(await readdir(directory)).toEqual(["tx"]);
  });

  test("refuses a download that does not match its published checksum", async () => {
    const { updater, target, commands, directory } = await replacement(
      "checksum",
      {},
      checksumDocument(digestOf("something else entirely")),
    );

    await expect(updater.apply(availableItem)).rejects.toThrow(
      "does not match its published checksum",
    );
    expect(await readFile(target, "utf8")).toBe(installedBytes);
    expect(commands).toEqual([]);
    expect(await readdir(directory)).toEqual(["tx"]);
  });

  test("refuses a checksum document publishing no asset for this platform", async () => {
    const { updater, target, directory } = await replacement(
      "checksum-missing",
      {},
      checksumDocument(digestOf(stubExecutable), "tx-linux-arm64"),
    );

    await expect(updater.apply(availableItem)).rejects.toThrow(
      "SHA256SUMS for v1.3.0 publishes no tx-linux-x64",
    );
    expect(await readFile(target, "utf8")).toBe(installedBytes);
    expect(await readdir(directory)).toEqual(["tx"]);
  });

  test("refuses a staged executable reporting another version", async () => {
    const { updater, target, directory } = await replacement(
      "version",
      {},
      undefined,
      "9.9.9",
    );

    await expect(updater.apply(availableItem)).rejects.toThrow(
      'reported "9.9.9" rather than 1.3.0',
    );
    expect(await readFile(target, "utf8")).toBe(installedBytes);
    expect(await readdir(directory)).toEqual(["tx"]);
  });

  test("refuses a staged executable that will not run at all", async () => {
    const root = await workspace("unrunnable");
    const target = await installedExecutable(root, join("bin", "tx"));
    const { fetch } = stubFetch(
      downloadRoutes(
        `v${publishedVersion}`,
        stubExecutable,
        checksumDocument(digestOf(stubExecutable)),
      ),
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({
        fetch,
        executablePath: target,
        run: () => ({
          exitCode: 126,
          stdout: "",
          stderr: "cannot execute binary file\n",
        }),
      }),
    );

    await expect(updater.apply(availableItem)).rejects.toThrow(
      'reported "cannot execute binary file" rather than 1.3.0',
    );
    expect(await readFile(target, "utf8")).toBe(installedBytes);
    expect(await readdir(dirname(target))).toEqual(["tx"]);
  });

  test("reports a location it cannot write to, without acquiring privileges", async () => {
    const { updater, target, commands, directory } = await replacement(
      "unwritable",
      // A directory that does not exist stands in for any location the
      // filesystem refuses; the failure names the installed path either way,
      // and this one holds however the suite is run.
      { staging: (path) => join(dirname(path), "unwritable", "staged") },
    );

    await expect(updater.apply(availableItem)).rejects.toThrow(
      `Cannot stage a replacement beside "${target}"`,
    );
    expect(commands).toEqual([]);
    expect(await readFile(target, "utf8")).toBe(installedBytes);
    expect(await readdir(directory)).toEqual(["tx"]);
  });

  test("keeps the failure a refused cleanup would have replaced", async () => {
    // Forced through a property of the path rather than a permission bit, so
    // it holds for a suite running as root as well as for one that is not: a
    // staged path whose parent is a file can be neither written nor unlinked,
    // so the removal in the exit path is refused and must not surface.
    const { updater, target, directory } = await replacement("cleanup", {
      staging: (path) => join(path, "child"),
    });

    await expect(updater.apply(availableItem)).rejects.toThrow(
      `Cannot stage a replacement beside "${target}"`,
    );
    expect(await readFile(target, "utf8")).toBe(installedBytes);
    expect(await readdir(directory)).toEqual(["tx"]);
  });

  test("fails a download the release does not serve", async () => {
    const root = await workspace("missing-asset");
    const target = await installedExecutable(root, join("bin", "tx"));
    const { fetch } = stubFetch({
      [downloadUrl("v1.3.0", assetName)]: () =>
        new Response("nope", { status: 404, statusText: "Not Found" }),
    });
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ fetch, executablePath: target }),
    );

    await expect(updater.apply(availableItem)).rejects.toThrow("404");
    expect(await readFile(target, "utf8")).toBe(installedBytes);
  });
});

describe("executable update effects", () => {
  test.each([
    ["/$bunfs/root", true],
    ["/$bunfs/root/nested", true],
    ["B:/~BUN/root", true],
    ["B:\\~BUN\\root", true],
    ["/home/user/project/plugins/executable", false],
    ["/opt/bunfs/root", false],
  ])("reads %p as a compiled program: %p", (path, compiled) => {
    expect(isCompiledModulePath(path)).toBe(compiled);
  });

  test("stages beside the target under a name of its own", () => {
    const staged = stagingPath("/usr/local/bin/tx");
    expect(dirname(staged)).toBe("/usr/local/bin");
    expect(staged).toContain("/.tx-update-");
    expect(staged).not.toBe(stagingPath("/usr/local/bin/tx"));
  });

  test.each([
    ["/home/user/.local/share/mise/installs/github-fx-tx/1.2.0/bin/tx", "mise"],
    [
      "/home/user/.local/share/mise/installs/npm-fx-tx/1.2.0/node_modules/tx",
      "mise",
    ],
    ["/usr/lib/node_modules/@fx/tx/dist/tx", "npm"],
    ["/usr/local/bin/tx", undefined],
    ["/home/mise/bin/tx", undefined],
  ])("detects the manager owning %p", (path, manager) => {
    expect(detectManager(path)).toBe(manager as ManagerKind | undefined);
  });

  test.each([
    [`${"a".repeat(64)}  tx-linux-x64`, "a".repeat(64)],
    [`${"b".repeat(64)} *tx-linux-x64`, "b".repeat(64)],
    ["", undefined],
    ["   ", undefined],
    [`${"c".repeat(64)}  tx-linux-arm64`, undefined],
  ])("reads a published checksum out of %p", (document, digest) => {
    expect(publishedChecksum(document, assetName)).toBe(digest);
  });

  test("reports what a command wrote and how it exited", async () => {
    const root = await workspace("run");
    const script = join(root, "stub");
    await writeFile(script, '#!/bin/sh\necho out\necho err >&2\nexit "$1"\n');
    await chmod(script, 0o755);

    expect(await runCommand([script, "0"])).toEqual({
      exitCode: 0,
      stdout: "out\n",
      stderr: "err\n",
    });
    expect(await runCommand([script, "3"])).toMatchObject({ exitCode: 3 });
    // A manager that is not installed is a failed run rather than a thrown
    // error, so every caller reads one shape.
    const missing = await runCommand([join(root, "absent")]);
    expect(missing.exitCode).toBe(127);
    expect(missing.stderr).not.toBe("");
  });

  test("lets a refused removal stand rather than becoming the failure", async () => {
    const root = await workspace("discard");
    const file = join(root, "file");
    await writeFile(file, "x");

    // Removing through a path whose parent is a file is refused for every
    // user, root included.
    expect(await discardStaged(join(file, "child"))).toBeUndefined();
    expect(await discardStaged(join(root, "never-existed"))).toBeUndefined();
  });
});

describe("bundled executable plugin", () => {
  async function setup(
    context: CapturedContext,
    overrides: ExecutableUpdaterOptions,
  ) {
    const { namespaces, failures } = await initializePlugins(
      [
        createExecutablePlugin({
          compiled: true,
          platform: "linux-x64",
          ...overrides,
        }),
        updatePlugin,
      ],
      { context },
    );
    expect(failures).toEqual([]);
    return createRootProgram(coreDependencies, namespaces);
  }

  test("contributes a participant, claims no namespace, and defines no command", async () => {
    const context = captureContext();
    const { fetch } = stubFetch(releaseRoutes("v99.0.0"));
    const { namespaces } = await initializePlugins(
      [createExecutablePlugin(options({ fetch }))],
      { context },
    );

    expect(namespaces).toEqual([]);
  });

  test("gathers the running version and performs the lookup on a dry run", async () => {
    const context = captureContext();
    const { fetch, urls } = stubFetch(releaseRoutes("v99.0.0"));
    const { run, commands } = recorder();
    const program = await setup(context, { fetch, run, env: {} });

    expect(await dispatch(program, ["update", "--dry-run"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    // The running version comes from the injected dependencies, and the lookup
    // is all a dry run does: no download, no subprocess, no write.
    expect(context.stdoutText()).toBe(
      `tx\t${packageMetadata.version}\t-> 99.0.0\n`,
    );
    expect(context.stderrText()).toBe("");
    expect(urls()).toEqual([releaseUrl]);
    expect(commands).toEqual([]);
  });

  test("takes the environment from the host when none is injected", async () => {
    const context = captureContext({ GH_TOKEN: "from-the-host" });
    const { fetch, requests } = stubFetch(releaseRoutes("v99.0.0"));
    const program = await setup(context, { fetch });

    expect(await dispatch(program, ["update", "--dry-run"], context)).toEqual({
      exitCode: EXIT_SUCCESS,
    });
    expect(header(requests[0], "authorization")).toBe("Bearer from-the-host");
  });
});
