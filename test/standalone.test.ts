import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

test("the production build is a standalone executable", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tx-standalone-"));

  try {
    const binaryPath = join(temporaryRoot, "tx");
    const emptyCwd = join(temporaryRoot, "cwd");
    const emptyPath = join(temporaryRoot, "path");
    await Promise.all([mkdir(emptyCwd), mkdir(emptyPath)]);

    const build = Bun.spawnSync(
      [process.execPath, "run", "build", "--outfile", binaryPath],
      { cwd: repositoryRoot },
    );

    expect(build.exitCode).toBe(0);
    expect(await readdir(emptyCwd)).toEqual([]);

    const result = Bun.spawnSync([binaryPath], {
      cwd: emptyCwd,
      env: { ...process.env, PATH: emptyPath },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("Usage: tx <command>\n");
    expect(result.stderr.toString()).toBe("");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
