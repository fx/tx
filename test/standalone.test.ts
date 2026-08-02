import { expect, test } from "bun:test";
import { copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

test("the production build is a standalone executable", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tx-standalone-"));

  try {
    const stagedProject = join(temporaryRoot, "project");
    const stagedSource = join(stagedProject, "src");
    const binaryPath = join(stagedProject, "dist", "tx");
    const runtimeDirectory = join(temporaryRoot, "runtime");
    await mkdir(stagedProject);
    await Promise.all([
      mkdir(runtimeDirectory),
      cp(join(repositoryRoot, "src"), stagedSource, { recursive: true }),
      copyFile(
        join(repositoryRoot, "package.json"),
        join(stagedProject, "package.json"),
      ),
    ]);

    const build = Bun.spawnSync([process.execPath, "run", "build"], {
      cwd: stagedProject,
    });

    expect(build.exitCode).toBe(0);
    await rm(stagedSource, { recursive: true });

    const result = Bun.spawnSync([binaryPath], {
      cwd: runtimeDirectory,
      env: { ...process.env, PATH: runtimeDirectory },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("Usage: tx <command>\n");
    expect(result.stderr.toString()).toBe("");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
