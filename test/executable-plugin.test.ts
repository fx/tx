import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
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
  detectManagers,
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

type ChildEnvironment =
  | Readonly<Record<string, string | undefined>>
  | undefined;

interface StubbedRun {
  readonly run: RunCommand;
  readonly commands: string[][];
  /** What each command was handed as its own environment, in order, so an
   * override that stopped being passed cannot pass unnoticed. */
  readonly environments: ChildEnvironment[];
}

function recorder(
  answer: (
    command: readonly string[],
  ) => CommandResult | Promise<CommandResult> = () => silentResult,
): StubbedRun {
  const commands: string[][] = [];
  const environments: ChildEnvironment[] = [];
  return {
    commands,
    environments,
    run: (command, env) => {
      commands.push([...command]);
      environments.push(env);
      return answer(command);
    },
  };
}

/**
 * A manager that answers its listing with `before` until its upgrade has run
 * and with `after` from then on, so the post-upgrade observation reads a
 * listing of its own rather than the one the interrogation read.
 *
 * `listing` overlays the rest of the listing's result, for a manager that
 * prints its answer and then exits non-zero over something else entirely.
 */
function upgrading(
  before: string,
  after: string,
  upgrade: CommandResult,
  listing: Partial<CommandResult> = {},
): StubbedRun {
  let applied = false;
  return recorder((command) => {
    if (command[1] !== "ls") {
      applied = true;
      return upgrade;
    }
    return {
      exitCode: 0,
      stderr: "",
      ...listing,
      stdout: applied ? after : before,
    };
  });
}

/** The layout the mise delegation tests share: a `github:fx/tx` install of the
 * running version inside a mise store. */
async function miseInstallation(
  prefix: string,
): Promise<{ store: string; target: string }> {
  const root = await workspace(prefix);
  return {
    store: join(root, "mise", "installs"),
    target: await installedExecutable(
      root,
      join("mise", "installs", "github-fx-tx", runningVersion, "bin", "tx"),
    ),
  };
}

/** What mise reports for that store, one entry per version it has installed. */
function miseListing(store: string, ...versions: readonly string[]): string {
  return JSON.stringify({
    "github:fx/tx": versions.map((version) => ({
      version,
      install_path: join(store, "github-fx-tx", version),
    })),
  });
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

  test.each([
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "latest",
    "v1.2.x",
    "1.2.3-",
    // Leading zeros and empty identifiers are not semantic versions, and the
    // ordering below coerces anything it cannot parse rather than refusing it.
    "01.3.0",
    "1.03.0",
    "1.3.0-01",
    "1.3.0-a..b",
    "1.3.0+",
  ])("offers nothing for the unreadable version %p", (text) => {
    // Neither side may be coerced: reading `v1.2.x` as something above
    // `1.2.0` would offer an update from a tag nothing can download.
    expect(isNewerRelease(text, "1.2.0")).toBe(false);
    expect(isNewerRelease("9.9.9", text)).toBe(false);
  });
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

  test("offers nothing for a release tagged without its v prefix", async () => {
    // Applying rebuilds the tag from the version, so a tag spelled any other
    // way would name assets nothing could fetch.
    const { fetch } = stubFetch(releaseRoutes("1.3.0"));
    const updater = new ExecutableUpdater(runningVersion, options({ fetch }));

    expect(await updater.gather()).toEqual([
      { name: "tx", current: runningVersion, detail: "latest 1.3.0" },
    ]);
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

  test("sends the token to the API and to no other host", async () => {
    // An asset download redirects to a separate host, and the assets are
    // public, so the token belongs on the lookup that is rate limited without
    // it and on nothing else.
    const root = await workspace("token-scope");
    const target = await installedExecutable(root, join("bin", "tx"));
    const { fetch, requests } = stubFetch({
      ...releaseRoutes(`v${publishedVersion}`),
      ...downloadRoutes(
        `v${publishedVersion}`,
        stubExecutable,
        checksumDocument(digestOf(stubExecutable)),
      ),
    });
    const updater = new ExecutableUpdater(
      runningVersion,
      options({
        fetch,
        executablePath: target,
        env: { GH_TOKEN: "secret" },
        run: () => ({
          exitCode: 0,
          stdout: `${publishedVersion}\n`,
          stderr: "",
        }),
      }),
    );

    const [item] = await updater.gather();
    if (!item) throw new Error("nothing was gathered");
    expect(await updater.apply(item)).toMatchObject({ applied: true });

    expect(requests).toHaveLength(3);
    expect(header(requests[0], "authorization")).toBe("Bearer secret");
    expect(requests[0]?.url).toBe(releaseUrl);
    for (const request of requests.slice(1)) {
      expect(request.url).toStartWith("https://github.com/fx/tx/releases/");
      expect(header(request, "authorization")).toBeUndefined();
      expect(JSON.stringify(request.headers)).not.toContain("secret");
    }
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
    const miseListing = (...versions: readonly string[]) =>
      JSON.stringify({
        bun: [
          { version: "1.3.14", install_path: join(store, "bun", "1.3.14") },
        ],
        "github:fx/tx": versions.map((version) => ({
          version,
          install_path: join(store, "github-fx-tx", version),
        })),
      });
    const { run, commands } = upgrading(
      miseListing(runningVersion),
      // mise leaves the version that was running installed beside the one it
      // just installed, so the newest of what it reports is the answer.
      miseListing(runningVersion, publishedVersion),
      { exitCode: 0, stdout: "mise github:fx/tx@1.3.0\n", stderr: "" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toEqual({
      applied: true,
      version: publishedVersion,
      detail: '"mise upgrade github:fx/tx": mise github:fx/tx@1.3.0',
    });
    expect(commands).toEqual([
      ["mise", "ls", "--installed", "--json"],
      ["mise", "upgrade", "github:fx/tx"],
      ["mise", "ls", "--installed", "--json"],
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
    const npmListing = (version: string) =>
      [
        `${library}:lib@`,
        `${join(library, "node_modules", "npm")}:npm@10.9.3`,
        `${join(library, "node_modules", "@fx", "tx")}:@fx/tx@${version}`,
        "not a listing line",
        "",
      ].join("\n");
    const { run, commands } = upgrading(
      npmListing(runningVersion),
      npmListing(publishedVersion),
      { exitCode: 0, stdout: "", stderr: "added 1 package\n" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toEqual({
      applied: true,
      version: publishedVersion,
      detail: '"npm install --global @fx/tx": added 1 package',
    });
    expect(commands).toEqual([
      ["npm", "ls", "--global", "--parseable", "--long"],
      ["npm", "install", "--global", "@fx/tx"],
      ["npm", "ls", "--global", "--parseable", "--long"],
    ]);
    expect(await readFile(target, "utf8")).toBe(installedBytes);
  });

  test("reads npm's listing even when npm exits over an unrelated tree problem", async () => {
    // `npm ls` exits non-zero for any problem anywhere in the global tree —
    // an extraneous package somebody else installed — after printing the
    // answer being asked for.
    const root = await workspace("npm-noisy");
    const target = await installedExecutable(
      root,
      join("lib", "node_modules", "@fx", "tx", "dist", "tx"),
    );
    const installed = join(root, "lib", "node_modules", "@fx", "tx");
    const { run, commands } = upgrading(
      `${installed}:@fx/tx@${runningVersion}\n`,
      `${installed}:@fx/tx@${publishedVersion}\n`,
      { exitCode: 0, stdout: "changed 1 package\n", stderr: "" },
      { exitCode: 1, stderr: "npm ERR! ELSPROBLEMS\n" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toMatchObject({
      applied: true,
      version: publishedVersion,
    });
    expect(commands[1]).toEqual(["npm", "install", "--global", "@fx/tx"]);
  });

  test("asks npm before mise for a node_modules tree inside a mise store", async () => {
    // A global npm install under a Node that mise installed. Asking mise
    // first would upgrade Node and report that as having updated tx.
    const root = await workspace("mise-node");
    const store = join(root, "mise", "installs");
    const target = await installedExecutable(
      root,
      join(
        "mise",
        "installs",
        "node",
        "22.18.0",
        "lib",
        "node_modules",
        "@fx",
        "tx",
        "dist",
        "tx",
      ),
    );
    const prefix = join(store, "node", "22.18.0", "lib");
    const npmListing = (version: string) =>
      [
        `${prefix}:lib@`,
        `${join(prefix, "node_modules", "@fx", "tx")}:@fx/tx@${version}`,
      ].join("\n");
    const { run, commands } = upgrading(
      npmListing(runningVersion),
      npmListing(publishedVersion),
      { exitCode: 0, stdout: "changed 1 package\n", stderr: "" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toEqual({
      applied: true,
      version: publishedVersion,
      detail: '"npm install --global @fx/tx": changed 1 package',
    });
    expect(commands).toEqual([
      ["npm", "ls", "--global", "--parseable", "--long"],
      ["npm", "install", "--global", "@fx/tx"],
      ["npm", "ls", "--global", "--parseable", "--long"],
    ]);
  });

  test("delegates for a store mise reports through the link it was given", async () => {
    // mise echoes back the spelling it was configured with, while the target
    // is compared as its real path, so an unresolved comparison would report
    // no owner for an installation mise plainly owns.
    const root = await workspace("mise-link-owner");
    const store = join(root, "store");
    const installed = join(store, "installs", "github-fx-tx", "1.2.0");
    const target = await installedExecutable(
      root,
      join("store", "installs", "github-fx-tx", "1.2.0", "bin", "tx"),
    );
    await symlink(store, join(root, "link"));
    const linked = join(root, "link", "installs", "github-fx-tx", "1.2.0");
    const { run, commands } = upgrading(
      JSON.stringify({ "github:fx/tx": [{ install_path: linked }] }),
      JSON.stringify({
        "github:fx/tx": [{ install_path: linked, version: publishedVersion }],
      }),
      { exitCode: 0, stdout: "upgraded\n", stderr: "" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({
        run,
        executablePath: target,
        env: { MISE_DATA_DIR: join(root, "link") },
      }),
    );

    expect(await updater.apply(availableItem)).toMatchObject({ applied: true });
    expect(commands[1]).toEqual(["mise", "upgrade", "github:fx/tx"]);
    expect(installed).toContain("store");
  });

  test("reports what the manager wrote on both of its streams", async () => {
    const root = await workspace("both-streams");
    const target = await installedExecutable(
      root,
      join("lib", "node_modules", "@fx", "tx", "dist", "tx"),
    );
    const installed = join(root, "lib", "node_modules", "@fx", "tx");
    const { run } = upgrading(
      `${installed}:@fx/tx@${runningVersion}\n`,
      `${installed}:@fx/tx@${publishedVersion}\n`,
      {
        exitCode: 0,
        stdout: "changed 1 package\n",
        stderr: "npm warn deprecated\n",
      },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toEqual({
      applied: true,
      version: publishedVersion,
      detail:
        '"npm install --global @fx/tx": changed 1 package; npm warn deprecated',
    });
  });

  test("stops rather than asking mise when npm cannot be interrogated", async () => {
    // The next candidate would answer about the Node this install sits
    // inside, and upgrading that would report success while leaving tx where
    // it was.
    const root = await workspace("npm-unanswerable");
    const target = await installedExecutable(
      root,
      join(
        "mise",
        "installs",
        "node",
        "22.18.0",
        "lib",
        "node_modules",
        "@fx",
        "tx",
        "dist",
        "tx",
      ),
    );
    const { run, commands } = recorder(() => ({
      exitCode: 127,
      stdout: "",
      stderr: "npm: command not found\n",
    }));
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    await expect(updater.apply(availableItem)).rejects.toThrow(
      "npm could not report which package owns",
    );
    expect(commands).toEqual([
      ["npm", "ls", "--global", "--parseable", "--long"],
    ]);
    expect(await readFile(target, "utf8")).toBe(installedBytes);
  });

  test("falls back to mise for a store npm does not claim", async () => {
    // mise's own npm backend installs into a prefix of its own, which the
    // ambient npm knows nothing about, so mise is the owner after all.
    const root = await workspace("mise-npm-backend");
    const installed = join(root, "mise", "installs", "npm-fx-tx", "1.2.0");
    const target = await installedExecutable(
      root,
      join(
        "mise",
        "installs",
        "npm-fx-tx",
        "1.2.0",
        "lib",
        "node_modules",
        "@fx",
        "tx",
        "dist",
        "tx",
      ),
    );
    let upgraded = false;
    const { run, commands } = recorder((command) => {
      if (command[0] === "npm") {
        return { exitCode: 0, stdout: "/usr/lib:lib@\n", stderr: "" };
      }
      if (command[1] !== "ls") {
        upgraded = true;
        return { exitCode: 0, stdout: "mise npm:@fx/tx@1.3.0\n", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          "npm:@fx/tx": [
            {
              install_path: installed,
              version: upgraded ? publishedVersion : runningVersion,
            },
          ],
        }),
        stderr: "",
      };
    });
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toEqual({
      applied: true,
      version: publishedVersion,
      detail: '"mise upgrade npm:@fx/tx": mise npm:@fx/tx@1.3.0',
    });
    expect(commands).toEqual([
      ["npm", "ls", "--global", "--parseable", "--long"],
      ["mise", "ls", "--installed", "--json"],
      ["mise", "upgrade", "npm:@fx/tx"],
      ["mise", "ls", "--installed", "--json"],
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

  test("runs the delegated mise upgrade without the minimum release age", async () => {
    // mise withholds a release younger than `minimum_release_age`, which this
    // participant cannot see: without the override the upgrade declines to
    // install the very version the same command has just offered.
    const { store, target } = await miseInstallation("mise-release-age");
    const { run, commands, environments } = upgrading(
      miseListing(store, runningVersion),
      miseListing(store, publishedVersion),
      { exitCode: 0, stdout: "mise github:fx/tx@1.3.0\n", stderr: "" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target, env: { PATH: "/usr/bin" } }),
    );

    expect(await updater.apply(availableItem)).toMatchObject({
      applied: true,
      version: publishedVersion,
    });
    expect(commands[1]).toEqual(["mise", "upgrade", "github:fx/tx"]);
    // Asserted rather than inferred from the command succeeding: an override
    // that stopped being passed would reintroduce the defect silently. It
    // reaches that one child, and the listings run as they always have.
    expect(environments).toEqual([
      undefined,
      { PATH: "/usr/bin", MISE_MINIMUM_RELEASE_AGE: "0" },
      undefined,
    ]);
  });

  test("runs npm's own install with no override of its own", async () => {
    // npm has no release-age policy, so its upgrade gets the environment it
    // was given and nothing more.
    const root = await workspace("npm-no-override");
    const target = await installedExecutable(
      root,
      join("lib", "node_modules", "@fx", "tx", "dist", "tx"),
    );
    const installed = join(root, "lib", "node_modules", "@fx", "tx");
    const { run, commands, environments } = upgrading(
      `${installed}:@fx/tx@${runningVersion}\n`,
      `${installed}:@fx/tx@${publishedVersion}\n`,
      { exitCode: 0, stdout: "added 1 package\n", stderr: "" },
    );
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target, env: { PATH: "/usr/bin" } }),
    );

    expect(await updater.apply(availableItem)).toMatchObject({
      applied: true,
      version: publishedVersion,
    });
    expect(commands[1]).toEqual(["npm", "install", "--global", "@fx/tx"]);
    expect(environments).toEqual([undefined, { PATH: "/usr/bin" }, undefined]);
  });

  test("reports nothing applied when a successful upgrade installed nothing", async () => {
    // The reported defect: mise warns that it ignored the release, exits zero,
    // and leaves the executable at the version that was running.
    const { store, target } = await miseInstallation("mise-unmoved");
    const listing = miseListing(store, runningVersion);
    const warning =
      "mise WARN newer github:fx/tx release 1.3.0 ignored by minimum_release_age (24h)";
    const { run } = upgrading(listing, listing, {
      exitCode: 0,
      stdout: "",
      stderr: `${warning}\n`,
    });
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    // Nothing applied rather than a failure, carrying the manager's own words
    // and the version still installed, and naming no version it did not
    // observe.
    expect(await updater.apply(availableItem)).toEqual({
      applied: false,
      detail: `"mise upgrade github:fx/tx": ${warning}; still ${runningVersion}`,
    });
    expect(await readFile(target, "utf8")).toBe(installedBytes);
  });

  test("reports nothing applied when the newer version was installed all along", async () => {
    // mise lists every installed version, so a newer one already on disk —
    // here the user has pinned the tool to the version they are running — is
    // not evidence that this upgrade installed anything.
    const { store, target } = await miseInstallation("mise-pinned");
    const listing = miseListing(store, runningVersion, publishedVersion);
    const output = "mise github:fx/tx is pinned; nothing to upgrade";
    const { run } = upgrading(listing, listing, {
      exitCode: 0,
      stdout: `${output}\n`,
      stderr: "",
    });
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toEqual({
      applied: false,
      detail: `"mise upgrade github:fx/tx": ${output}; still ${runningVersion}`,
    });
    expect(await readFile(target, "utf8")).toBe(installedBytes);
  });

  test("reports the running version when mise names only newer ones", async () => {
    // mise tolerates an entry naming no version, so the install that is
    // running can be reported without one while a version pinned away is
    // reported with one. Nothing appeared, and the only version reported is
    // one the user is not running: naming it would be the very untruth this
    // reports around.
    const { store, target } = await miseInstallation("mise-unversioned");
    const listing = JSON.stringify({
      "github:fx/tx": [
        { install_path: join(store, "github-fx-tx", runningVersion) },
        {
          version: publishedVersion,
          install_path: join(store, "github-fx-tx", publishedVersion),
        },
      ],
    });
    const pinned = "mise github:fx/tx is pinned; nothing to upgrade";
    const { run } = upgrading(listing, listing, {
      exitCode: 0,
      stdout: `${pinned}\n`,
      stderr: "",
    });
    const updater = new ExecutableUpdater(
      runningVersion,
      options({ run, executablePath: target }),
    );

    expect(await updater.apply(availableItem)).toEqual({
      applied: false,
      detail: `"mise upgrade github:fx/tx": ${pinned}; still ${runningVersion}`,
    });
  });

  test.each([
    [["ref:main", runningVersion, publishedVersion]],
    [[publishedVersion, runningVersion, "ref:main"]],
  ])(
    "observes the newest orderable version whatever order mise lists it in (%#)",
    async (after) => {
      // mise lists a `ref:` install beside released versions, and nothing
      // orders it. Folding the listing through one accumulator would latch on
      // it and report a real upgrade as having moved nothing.
      const { store, target } = await miseInstallation("mise-unorderable");
      const { run } = upgrading(
        miseListing(store, runningVersion),
        miseListing(store, ...after),
        { exitCode: 0, stdout: "mise github:fx/tx@1.3.0\n", stderr: "" },
      );
      const updater = new ExecutableUpdater(
        runningVersion,
        options({ run, executablePath: target }),
      );

      expect(await updater.apply(availableItem)).toEqual({
        applied: true,
        version: publishedVersion,
        detail: '"mise upgrade github:fx/tx": mise github:fx/tx@1.3.0',
      });
    },
  );

  test.each([
    [
      "not json",
      `mise reports no installed version of github:fx/tx; still ${runningVersion}`,
    ],
    [
      JSON.stringify({ "github:fx/tx": [{ install_path: "/elsewhere" }] }),
      `mise reports no installed version of github:fx/tx; still ${runningVersion}`,
    ],
    [
      JSON.stringify({
        "github:fx/tx": [{ version: "dev", install_path: "/elsewhere" }],
      }),
      "still dev",
    ],
    [
      JSON.stringify({
        "github:fx/tx": [
          { version: "ref:main", install_path: "/elsewhere" },
          { version: "system", install_path: "/elsewhere" },
        ],
      }),
      "still ref:main",
    ],
  ])(
    "reports nothing applied when the upgrade cannot be observed (%#)",
    async (after, expected) => {
      const { store, target } = await miseInstallation("mise-unobserved");
      const { run } = upgrading(miseListing(store, runningVersion), after, {
        exitCode: 0,
        stdout: "upgraded\n",
        stderr: "",
      });
      const updater = new ExecutableUpdater(
        runningVersion,
        options({ run, executablePath: target }),
      );

      expect(await updater.apply(availableItem)).toEqual({
        applied: false,
        detail: `"mise upgrade github:fx/tx": upgraded; ${expected}`,
      });
    },
  );
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
      downloadUrl("v1.3.0", checksumName),
      downloadUrl("v1.3.0", assetName),
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
    const root = await workspace("cleanup");
    const target = await installedExecutable(root, join("bin", "tx"));
    const staged = join(dirname(target), "staged");
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
        staging: () => staged,
        // The file really is staged, and then — between the staging and the
        // rename — the path becomes a non-empty directory, which the removal
        // on the way out cannot unlink. Forced through a property of the path
        // rather than a permission bit, so it holds for a suite running as
        // root as well as for one that is not.
        run: async () => {
          await rm(staged);
          await mkdir(join(staged, "occupied"), { recursive: true });
          return { exitCode: 0, stdout: "9.9.9\n", stderr: "" };
        },
      }),
    );

    // The verification failure is what surfaces, not the refused removal.
    await expect(updater.apply(availableItem)).rejects.toThrow(
      'reported "9.9.9" rather than 1.3.0',
    );
    expect(await readFile(target, "utf8")).toBe(installedBytes);
    expect((await stat(staged)).isDirectory()).toBe(true);
  });

  test("fails a download the release does not serve", async () => {
    const root = await workspace("missing-asset");
    const target = await installedExecutable(root, join("bin", "tx"));
    const { fetch } = stubFetch({
      [downloadUrl("v1.3.0", checksumName)]: () =>
        new Response(checksumDocument(digestOf(stubExecutable))),
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
    {
      path: "/home/user/.local/share/mise/installs/github-fx-tx/1.2.0/bin/tx",
      env: {} as Record<string, string>,
      managers: ["mise"],
    },
    // Both markers: mise's npm backend and a global npm install under a
    // mise-managed Node produce the same shape, so npm is asked first.
    {
      path: "/home/user/.local/share/mise/installs/npm-fx-tx/1.2.0/lib/node_modules/@fx/tx/dist/tx",
      env: {},
      managers: ["npm", "mise"],
    },
    {
      path: "/home/user/.local/share/mise/installs/node/22.18.0/lib/node_modules/@fx/tx/dist/tx",
      env: {},
      managers: ["npm", "mise"],
    },
    {
      path: "/usr/lib/node_modules/@fx/tx/dist/tx",
      env: {},
      managers: ["npm"],
    },
    { path: "/usr/local/bin/tx", env: {}, managers: [] },
    { path: "/home/mise/bin/tx", env: {}, managers: [] },
    // A store the environment moved carries no `mise` component of its own,
    // so it would look unmanaged and be written into rather than delegated to.
    {
      path: "/opt/tool-cache/installs/github-fx-tx/1.2.0/bin/tx",
      env: { MISE_DATA_DIR: "/opt/tool-cache" },
      managers: ["mise"],
    },
    {
      path: "/opt/tools/github-fx-tx/1.2.0/bin/tx",
      env: { MISE_INSTALLS_DIR: "/opt/tools" },
      managers: ["mise"],
    },
    {
      path: "/opt/elsewhere/github-fx-tx/1.2.0/bin/tx",
      env: { MISE_DATA_DIR: "/opt/tool-cache" },
      managers: [],
    },
  ])(
    "detects the managers that could own $path",
    async ({ path, env, managers }) => {
      expect(await detectManagers(path, env)).toEqual(
        managers as readonly ManagerKind[],
      );
    },
  );

  test("resolves a configured mise store reached through a symbolic link", async () => {
    // The target is compared as its real path, so a store the environment
    // names through a link has to be resolved too, or its own installs would
    // look unmanaged and be written into.
    const root = await workspace("mise-link");
    const store = join(root, "store");
    await mkdir(join(store, "installs", "github-fx-tx", "1.2.0"), {
      recursive: true,
    });
    await symlink(store, join(root, "link"));

    expect(
      await detectManagers(
        join(store, "installs", "github-fx-tx", "1.2.0", "bin", "tx"),
        { MISE_DATA_DIR: join(root, "link") },
      ),
    ).toEqual(["mise"]);
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

  test("gives a child the environment it was handed", async () => {
    // The seam an override rides on: what is passed is the whole environment
    // of that one child, and a call naming none spawns as it always did.
    const root = await workspace("run-env");
    const script = join(root, "stub");
    await writeFile(script, '#!/bin/sh\necho "$TX_TEST_MARKER"\n');
    await chmod(script, 0o755);

    expect(await runCommand([script], { TX_TEST_MARKER: "given" })).toEqual({
      exitCode: 0,
      stdout: "given\n",
      stderr: "",
    });
    // The environment given is the whole of the child's: nothing this process
    // holds leaks into a command that named one.
    expect(await runCommand([script], {})).toMatchObject({ stdout: "\n" });
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
