import { expect } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function temporaryDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function writeFixtureFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([path, contents]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }),
  );
}

export function initializeGitRepository(checkout: string): void {
  for (const args of [
    ["init"],
    ["add", "."],
    [
      "-c",
      "user.name=TX Tests",
      "-c",
      "user.email=tx@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
  ]) {
    expect(Bun.spawnSync(["git", ...args], { cwd: checkout }).exitCode).toBe(0);
  }
}

export async function createGitRepository(
  root: string,
  name: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const checkout = join(root, name);
  await mkdir(checkout, { recursive: true });
  await writeFixtureFiles(checkout, files);
  initializeGitRepository(checkout);
  return checkout;
}
