import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createGitRepository, temporaryDirectory } from "./helpers.ts";

const repositoryRoot = join(import.meta.dir, "..");
const cliPath = join(repositoryRoot, "cli.ts");

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(dataHome: string, ...args: string[]): CliResult {
  const result = Bun.spawnSync([process.execPath, "run", cliPath, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, XDG_DATA_HOME: dataHome },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function expectNoMarketplaceArtifacts(
  dataHome: string,
  name: string,
): Promise<void> {
  const root = join(dataHome, "tx", "marketplaces");
  const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  expect(entries).not.toContain(name);
  expect(entries.filter((entry) => entry.includes("staging"))).toEqual([]);
}

function manifest(plugin: string, entry = "plugin.ts"): string {
  return JSON.stringify({ plugins: [{ name: plugin, entry }] });
}

describe("source CLI marketplace installation failures", () => {
  test("rejects an unsafe name without writing outside marketplace storage", async () => {
    const root = await temporaryDirectory("tx-plugin-system-unsafe-");
    try {
      const dataHome = join(root, "data");
      const source = await createGitRepository(root, "source", {
        "plugin.ts": "export default () => {};\n",
        ".tx/config.json": manifest("fixture"),
      });

      const result = runCli(
        dataHome,
        "marketplace",
        "add",
        source,
        "--name",
        "../escape",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('Invalid marketplace name "../escape"');
      await expectNoMarketplaceArtifacts(dataHome, "escape");
      await expect(
        lstat(join(dataHome, "tx", "escape")),
      ).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: "a malformed manifest",
      name: "malformed",
      files: { ".tx/config.json": "{" },
      error: "Invalid .tx/config.json",
    },
    {
      label: "an invalid manifest",
      name: "invalid",
      files: { ".tx/config.json": "{}" },
      error: ".tx/config.json must contain a plugins array",
    },
    {
      label: "a missing plugin entry",
      name: "missing-entry",
      files: { ".tx/config.json": manifest("missing", "missing.ts") },
      error: 'Plugin "missing" entry does not exist: missing.ts',
    },
    {
      label: "a failing local file dependency install",
      name: "install-failure",
      files: {
        "package.json": JSON.stringify({
          private: true,
          dependencies: { missing: "file:./does-not-exist" },
        }),
        "plugin.ts": "export default () => {};\n",
        ".tx/config.json": manifest("fixture"),
      },
      error: "Bun dependency installation failed",
    },
  ])(
    "publishes nothing and leaves no staging after $label",
    async ({ name, files, error }) => {
      const root = await temporaryDirectory(`tx-plugin-system-${name}-`);
      try {
        const dataHome = join(root, "data");
        const source = await createGitRepository(root, "source", files);
        const result = runCli(
          dataHome,
          "marketplace",
          "add",
          source,
          "--name",
          name,
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(error);
        await expectNoMarketplaceArtifacts(dataHome, name);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("cleans staging and final paths after a local clone failure", async () => {
    const root = await temporaryDirectory("tx-plugin-system-clone-");
    try {
      const dataHome = join(root, "data");
      const missingRepository = join(root, "not-a-repository");
      const result = runCli(
        dataHome,
        "marketplace",
        "add",
        missingRepository,
        "--name",
        "clone-failure",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Git command failed");
      await expectNoMarketplaceArtifacts(dataHome, "clone-failure");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("source CLI local marketplace sources", () => {
  test("dispatches an uncommitted edit on the next invocation", async () => {
    const root = await temporaryDirectory("tx-plugin-system-live-");
    try {
      const dataHome = join(root, "data");
      // A plain directory, never a Git repository and never committed: the
      // author's working tree is the marketplace.
      const source = join(root, "workspace");
      const writePlugin = (output: string) =>
        writeFile(
          join(source, "plugin.ts"),
          `export default ({ command, context }) => {
            command((namespace) => namespace
              .command("run")
              .action(() => context.stdout.write("${output}\\n")));
          };\n`,
        );
      await mkdir(join(source, ".tx"), { recursive: true });
      await Promise.all([
        writePlugin("original"),
        writeFile(join(source, ".tx/config.json"), manifest("live")),
      ]);

      expect(runCli(dataHome, "marketplace", "add", source)).toEqual({
        exitCode: 0,
        stdout: 'Added marketplace "workspace".\n',
        stderr: "",
      });
      expect(
        (
          await lstat(join(dataHome, "tx", "marketplaces", "workspace"))
        ).isSymbolicLink(),
      ).toBe(true);
      expect(runCli(dataHome, "marketplace", "list").stdout).toBe(
        `workspace\tlive\t${source}\n`,
      );
      expect(runCli(dataHome, "live", "run")).toEqual({
        exitCode: 0,
        stdout: "original\n",
        stderr: "",
      });

      await writePlugin("edited");

      expect(runCli(dataHome, "live", "run")).toEqual({
        exitCode: 0,
        stdout: "edited\n",
        stderr: "",
      });

      expect(runCli(dataHome, "marketplace", "remove", "workspace")).toEqual({
        exitCode: 0,
        stdout: 'Removed marketplace "workspace".\n',
        stderr: "",
      });
      await expectNoMarketplaceArtifacts(dataHome, "workspace");
      expect((await readdir(source)).toSorted()).toEqual([".tx", "plugin.ts"]);
      expect(await readFile(join(source, "plugin.ts"), "utf8")).toContain(
        'context.stdout.write("edited\\n")',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("source CLI namespace ownership", () => {
  test("rejects a plugin that renames the namespace it was handed", async () => {
    const root = await temporaryDirectory("tx-plugin-system-rename-");
    try {
      const dataHome = join(root, "data");
      const source = await createGitRepository(root, "source", {
        "plugin.ts": `export default ({ command, context }) => {
          command((namespace) => {
            namespace.command("valid").action(() => context.stdout.write("ghost\\n"));
            namespace.name("other");
          });
        };\n`,
        ".tx/config.json": manifest("renamer"),
      });
      expect(
        runCli(dataHome, "marketplace", "add", source, "--name", "renaming")
          .exitCode,
      ).toBe(0);

      for (const namespace of ["renamer", "other"]) {
        const result = runCli(dataHome, namespace, "valid");
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          'Error loading plugin marketplace/installed/renaming/renamer: Plugin marketplace/installed/renaming/renamer renamed its namespace to "other"; a namespace must stay reachable as "renamer"',
        );
        expect(result.stderr).toContain(
          `Error: Unknown command "${namespace}". Run "tx --help" for usage.`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the bundled namespace and diagnoses an external claim on it", async () => {
    const root = await temporaryDirectory("tx-plugin-system-core-collision-");
    try {
      const dataHome = join(root, "data");
      const source = await createGitRepository(root, "source", {
        "plugin.ts": `export default ({ command }) => {
          command((namespace) => namespace.command("list"));
        };\n`,
        ".tx/config.json": manifest("marketplace"),
      });
      expect(
        runCli(dataHome, "marketplace", "add", source, "--name", "external")
          .exitCode,
      ).toBe(0);

      const list = runCli(dataHome, "marketplace", "list");
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain(`external\tlive\t${source}\n`);
      expect(list.stderr).toContain(
        'Error loading plugin marketplace/installed/external/marketplace: Namespace "marketplace" is already claimed by marketplace; cannot claim it for marketplace/installed/external/marketplace',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the first committed external namespace and diagnoses a later claim", async () => {
    const root = await temporaryDirectory(
      "tx-plugin-system-external-collision-",
    );
    try {
      const dataHome = join(root, "data");
      const [alpha, beta] = await Promise.all([
        createGitRepository(root, "alpha-source", {
          "plugin.ts": `export default ({ command, context }) => {
            command((namespace) => namespace.action(() => context.stdout.write("alpha\\n")));
          };\n`,
          ".tx/config.json": manifest("shared"),
        }),
        createGitRepository(root, "beta-source", {
          "plugin.ts": `export default ({ command, context }) => {
            command((namespace) => namespace.action(() => context.stdout.write("beta\\n")));
          };\n`,
          ".tx/config.json": manifest("shared"),
        }),
      ]);
      expect(
        runCli(dataHome, "marketplace", "add", alpha, "--name", "alpha")
          .exitCode,
      ).toBe(0);
      expect(
        runCli(dataHome, "marketplace", "add", beta, "--name", "beta").exitCode,
      ).toBe(0);

      const shared = runCli(dataHome, "shared");
      expect(shared.exitCode).toBe(0);
      expect(shared.stdout).toBe("alpha\n");
      expect(shared.stderr).toContain(
        'Error loading plugin marketplace/installed/beta/shared: Namespace "shared" is already claimed by marketplace/installed/alpha/shared; cannot claim it for marketplace/installed/beta/shared',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("broken marketplaces remain removable without blocking healthy plugins", async () => {
  const root = await temporaryDirectory("tx-plugin-system-isolation-");
  try {
    const dataHome = join(root, "data");
    const [healthy, broken] = await Promise.all([
      createGitRepository(root, "healthy-source", {
        "plugin.ts": `export default ({ command, context }) => {
          command((namespace) => namespace
            .command("run")
            .action(() => context.stdout.write("healthy\\n")));
        };\n`,
        ".tx/config.json": manifest("healthy"),
      }),
      createGitRepository(root, "broken-source", {
        "plugin.ts": "export default 42;\n",
        ".tx/config.json": manifest("broken"),
      }),
    ]);

    expect(
      runCli(dataHome, "marketplace", "add", healthy, "--name", "healthy")
        .exitCode,
    ).toBe(0);
    expect(
      runCli(dataHome, "marketplace", "add", broken, "--name", "broken")
        .exitCode,
    ).toBe(0);

    const isolated = runCli(dataHome, "healthy", "run");
    expect(isolated.exitCode).toBe(0);
    expect(isolated.stdout).toBe("healthy\n");
    expect(isolated.stderr).toBe(
      'Error loading plugin marketplace/installed/broken/broken: Marketplace "broken" plugin "broken" failed: Plugin broken must default-export a function. Run "tx marketplace remove broken" to remove it.\n',
    );

    const removeBroken = runCli(dataHome, "marketplace", "remove", "broken");
    expect(removeBroken.exitCode).toBe(0);
    expect(removeBroken.stdout).toBe('Removed marketplace "broken".\n');
    expect(removeBroken.stderr).toContain(
      "Error loading plugin marketplace/installed/broken/broken",
    );
    await expectNoMarketplaceArtifacts(dataHome, "broken");

    const recovered = runCli(dataHome, "healthy", "run");
    expect(recovered).toEqual({
      exitCode: 0,
      stdout: "healthy\n",
      stderr: "",
    });

    const removeHealthy = runCli(dataHome, "marketplace", "remove", "healthy");
    expect(removeHealthy).toEqual({
      exitCode: 0,
      stdout: 'Removed marketplace "healthy".\n',
      stderr: "",
    });

    const unavailable = runCli(dataHome, "healthy", "run");
    expect(unavailable.exitCode).toBe(1);
    expect(unavailable.stdout).toBe("");
    expect(unavailable.stderr).toContain(
      'Error: Unknown command "healthy". Run "tx --help" for usage.',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
