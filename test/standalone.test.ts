import { expect, test } from "bun:test";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

test("the production build is a standalone executable", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tx-standalone-"));

  try {
    const stagedProject = join(temporaryRoot, "project");
    const stagedSource = join(stagedProject, "src");
    const stagedPlugins = join(stagedProject, "plugins");
    const stagedNodeModules = join(stagedProject, "node_modules");
    const binaryPath = join(stagedProject, "dist", "tx");
    const runtimeDirectory = join(temporaryRoot, "runtime");
    await mkdir(stagedProject);
    await Promise.all([
      mkdir(runtimeDirectory),
      cp(join(repositoryRoot, "src"), stagedSource, { recursive: true }),
      cp(join(repositoryRoot, "plugins"), stagedPlugins, { recursive: true }),
      copyFile(
        join(repositoryRoot, "package.json"),
        join(stagedProject, "package.json"),
      ),
      copyFile(
        join(repositoryRoot, "build.ts"),
        join(stagedProject, "build.ts"),
      ),
      symlink(join(repositoryRoot, "node_modules"), stagedNodeModules, "dir"),
    ]);

    const build = Bun.spawnSync([process.execPath, "run", "build"], {
      cwd: stagedProject,
    });

    expect(build.exitCode).toBe(0);
    await Promise.all([
      rm(stagedSource, { recursive: true }),
      rm(stagedPlugins, { recursive: true }),
      rm(stagedNodeModules),
    ]);

    const result = Bun.spawnSync([binaryPath], {
      cwd: runtimeDirectory,
      env: { ...process.env, DEV: "true", PATH: runtimeDirectory },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      "Usage: tx <command>\n\nCommands:\n  marketplace\n",
    );
    expect(result.stderr.toString()).toBe("");

    const marketplace = join(temporaryRoot, "marketplace");
    const dependency = join(marketplace, "dependency");
    const dataDirectory = join(temporaryRoot, "data");
    await mkdir(dependency, { recursive: true });
    await Promise.all([
      writeFile(
        join(marketplace, "tx.marketplace.json"),
        '{"plugins":[{"name":"fixture","entry":"plugin.ts"}]}',
      ),
      writeFile(
        join(marketplace, "package.json"),
        '{"type":"module","dependencies":{"fixture-dependency":"file:./dependency"}}',
      ),
      writeFile(
        join(dependency, "package.json"),
        '{"name":"fixture-dependency","version":"1.0.0","type":"module","exports":"./index.ts"}',
      ),
      writeFile(
        join(dependency, "index.ts"),
        'export const message = "loaded dependency";',
      ),
      writeFile(
        join(marketplace, "plugin.ts"),
        'import { message } from "fixture-dependency"; export default ({ command }) => command("fixture", (_args, context) => context.stdout.write(message + "\\n"));',
      ),
    ]);

    for (const args of [
      ["init"],
      ["add", "."],
      [
        "-c",
        "user.name=tx",
        "-c",
        "user.email=tx@example.com",
        "commit",
        "-m",
        "fixture",
      ],
    ]) {
      expect(
        Bun.spawnSync(["git", ...args], { cwd: marketplace }).exitCode,
      ).toBe(0);
    }

    const { PATH } = process.env;
    const env = {
      ...process.env,
      DEV: "true",
      PATH: `${dirname(process.execPath)}:${PATH ?? ""}`,
      XDG_DATA_HOME: dataDirectory,
    };
    const add = Bun.spawnSync(
      [binaryPath, "marketplace", "add", marketplace, "--name", "fixture"],
      { env },
    );
    expect(add.exitCode).toBe(0);
    expect(add.stderr.toString()).toBe("");

    const run = Bun.spawnSync([binaryPath, "fixture"], { env });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("loaded dependency\n");
    expect(run.stderr.toString()).toBe("");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
