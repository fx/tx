import { describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createGitRepository, temporaryDirectory } from "./helpers.ts";

const repositoryRoot = join(import.meta.dir, "..");
const cliPath = join(repositoryRoot, "src", "cli.ts");

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
        "tx.marketplace.json": manifest("fixture"),
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
      expect(await Bun.file(join(dataHome, "tx", "escape")).exists()).toBe(
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: "a malformed manifest",
      name: "malformed",
      files: { "tx.marketplace.json": "{" },
      error: "Invalid tx.marketplace.json",
    },
    {
      label: "an invalid manifest",
      name: "invalid",
      files: { "tx.marketplace.json": "{}" },
      error: "tx.marketplace.json must contain a plugins array",
    },
    {
      label: "a missing plugin entry",
      name: "missing-entry",
      files: { "tx.marketplace.json": manifest("missing", "missing.ts") },
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
        "tx.marketplace.json": manifest("fixture"),
      },
      error: "Bun dependency installation failed",
    },
  ])(
    "cleans staging and final paths after $label",
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

describe("source CLI plugin registration", () => {
  test("rolls back every command when a plugin registers an empty segment", async () => {
    const root = await temporaryDirectory("tx-plugin-system-segment-");
    try {
      const dataHome = join(root, "data");
      const source = await createGitRepository(root, "source", {
        "plugin.ts": `export default ({ command }) => {
          command("ghost valid", (_args, context) => context.stdout.write("ghost\\n"));
          command(["ghost", "   "], () => {});
        };\n`,
        "tx.marketplace.json": manifest("invalid-path"),
      });
      expect(
        runCli(dataHome, "marketplace", "add", source, "--name", "invalid-path")
          .exitCode,
      ).toBe(0);

      const result = runCli(dataHome, "ghost", "valid");
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Error loading plugin invalid-path/invalid-path: Command path must contain one or more non-empty segments",
      );
      expect(result.stderr).toContain('Unknown command "ghost valid"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps bundled commands and diagnoses an external collision", async () => {
    const root = await temporaryDirectory("tx-plugin-system-core-collision-");
    try {
      const dataHome = join(root, "data");
      const source = await createGitRepository(root, "source", {
        "plugin.ts": `export default ({ command }) => {
          command("ghost bundled-collision", () => {});
          command("marketplace list", () => {});
        };\n`,
        "tx.marketplace.json": manifest("collision"),
      });
      expect(
        runCli(dataHome, "marketplace", "add", source, "--name", "external")
          .exitCode,
      ).toBe(0);

      const list = runCli(dataHome, "marketplace", "list");
      expect(list.exitCode).toBe(1);
      expect(list.stdout).toContain(`external\t${source}\n`);
      expect(list.stderr).toContain(
        'Error loading plugin external/collision: Command "marketplace list" is already registered by core/marketplace; cannot register it for external/collision',
      );

      const rolledBack = runCli(dataHome, "ghost", "bundled-collision");
      expect(rolledBack.exitCode).toBe(2);
      expect(rolledBack.stdout).toBe("");
      expect(rolledBack.stderr).toContain(
        'Unknown command "ghost bundled-collision"',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps earlier external commands and diagnoses a later collision", async () => {
    const root = await temporaryDirectory(
      "tx-plugin-system-external-collision-",
    );
    try {
      const dataHome = join(root, "data");
      const source = await createGitRepository(root, "source", {
        "alpha.ts": `export default ({ command }) => {
          command("shared", (_args, context) => context.stdout.write("alpha\\n"));
          command("alpha only", (_args, context) => context.stdout.write("kept\\n"));
        };\n`,
        "beta.ts": `export default ({ command }) => {
          command("beta only", () => {});
          command("shared", () => {});
        };\n`,
        "tx.marketplace.json": JSON.stringify({
          plugins: [
            { name: "alpha", entry: "alpha.ts" },
            { name: "beta", entry: "beta.ts" },
          ],
        }),
      });
      expect(
        runCli(dataHome, "marketplace", "add", source, "--name", "personal")
          .exitCode,
      ).toBe(0);

      const shared = runCli(dataHome, "shared");
      expect(shared.exitCode).toBe(1);
      expect(shared.stdout).toBe("alpha\n");
      expect(shared.stderr).toContain(
        'Error loading plugin personal/beta: Command "shared" is already registered by personal/alpha; cannot register it for personal/beta',
      );

      const earlier = runCli(dataHome, "alpha", "only");
      expect(earlier.exitCode).toBe(1);
      expect(earlier.stdout).toBe("kept\n");

      const rolledBack = runCli(dataHome, "beta", "only");
      expect(rolledBack.exitCode).toBe(2);
      expect(rolledBack.stdout).toBe("");
      expect(rolledBack.stderr).toContain('Unknown command "beta only"');
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
        "plugin.ts":
          'export default ({ command }) => command("healthy run", (_args, context) => context.stdout.write("healthy\\n"));\n',
        "tx.marketplace.json": manifest("healthy"),
      }),
      createGitRepository(root, "broken-source", {
        "plugin.ts": "export default 42;\n",
        "tx.marketplace.json": manifest("broken"),
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
    expect(isolated.exitCode).toBe(1);
    expect(isolated.stdout).toBe("healthy\n");
    expect(isolated.stderr).toBe(
      "Error loading plugin broken/broken: Plugin broken/broken must default-export a function\n",
    );

    const removeBroken = runCli(dataHome, "marketplace", "remove", "broken");
    expect(removeBroken.exitCode).toBe(1);
    expect(removeBroken.stdout).toBe('Removed marketplace "broken".\n');
    expect(removeBroken.stderr).toContain("Error loading plugin broken/broken");
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
    expect(unavailable.exitCode).toBe(2);
    expect(unavailable.stdout).toBe("");
    expect(unavailable.stderr).toContain('Unknown command "healthy run"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
