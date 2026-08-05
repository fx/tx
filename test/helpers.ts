import { expect } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandProcessContext } from "../src/context.ts";

export interface CapturedContext extends CommandProcessContext {
  stdoutText(): string;
  stderrText(): string;
}

/**
 * A process context whose streams are captured rather than shared with the
 * test runner. Dispatch assertions use it so an escape from output routing
 * fails the suite instead of quietly polluting real process streams.
 */
export function captureContext(
  env: Record<string, string | undefined> = {},
): CapturedContext {
  let stdout = "";
  let stderr = "";
  return {
    cwd: "/work",
    env,
    stdin: {} as NodeJS.ReadStream,
    stdout: {
      write(value: string) {
        stdout += value;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write(value: string) {
        stderr += value;
        return true;
      },
    } as NodeJS.WriteStream,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

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
  const configuration = [
    "-c",
    "user.name=TX Tests",
    "-c",
    "user.email=tx@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "-c",
    `core.hooksPath=${join(checkout, ".git", "disabled-hooks")}`,
  ];

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "TX Tests",
    GIT_AUTHOR_EMAIL: "tx@example.invalid",
    GIT_COMMITTER_NAME: "TX Tests",
    GIT_COMMITTER_EMAIL: "tx@example.invalid",
  };

  for (const args of [["init"], ["add", "."], ["commit", "-m", "fixture"]]) {
    expect(
      Bun.spawnSync(["git", ...configuration, ...args], {
        cwd: checkout,
        env,
      }).exitCode,
    ).toBe(0);
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
