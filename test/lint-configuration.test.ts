import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./helpers.ts";

/**
 * Biome is the linter the documented validation command runs, and it reads no
 * `.gitignore`, so anything the repository ignores is still walked unless the
 * configuration excludes it. Agent worktrees live under `.claude/worktrees/`
 * and each carries its own copy of `biome.json`, which Biome rejects as a
 * nested root configuration — a checkout with one present could not be linted
 * at all until the configuration excluded the directory.
 *
 * These run the real Biome over a fixture rather than asserting the glob's
 * text, because the two mistakes worth catching are both invisible in the
 * text: an exclusion that misses the nested configuration, and one anchored so
 * loosely that it matches an ancestor directory and excludes the whole tree
 * when the linter is run from inside a worktree.
 */
const repositoryRoot = join(import.meta.dir, "..");
const biome = join(repositoryRoot, "node_modules", ".bin", "biome");
const worktree = join(".claude", "worktrees", "0000");

let fixture = "";

function check(directory: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync([biome, "check", "."], { cwd: directory });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

beforeAll(async () => {
  fixture = await temporaryDirectory("tx-lint-configuration-");
  await mkdir(join(fixture, worktree, "src"), { recursive: true });
  await mkdir(join(fixture, "src"), { recursive: true });
  for (const root of ["", worktree]) {
    await cp(
      join(repositoryRoot, "biome.json"),
      join(fixture, root, "biome.json"),
    );
    await writeFile(
      join(fixture, root, "src", "module.ts"),
      "export const a = 1;\n",
    );
  }
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("the lint configuration", () => {
  test("lints a checkout that has an agent worktree in it", () => {
    const { exitCode, output } = check(fixture);

    expect(output).not.toContain("nested root configuration");
    expect(output).toContain("Checked 2 files");
    expect(exitCode).toBe(0);
  });

  test("lints from inside an agent worktree", () => {
    const { exitCode, output } = check(join(fixture, worktree));

    expect(output).not.toContain("No files were processed");
    expect(output).toContain("Checked 2 files");
    expect(exitCode).toBe(0);
  });
});
