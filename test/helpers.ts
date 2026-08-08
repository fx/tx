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

/**
 * One Git command against a fixture, answered by its trimmed output. The test
 * identity and the disabled hooks are supplied on the command line, so a
 * developer's own configuration cannot change what a fixture commit is.
 */
export function fixtureGit(cwd: string, args: readonly string[]): string {
  const configuration = [
    "-c",
    "user.name=TX Tests",
    "-c",
    "user.email=tx@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "-c",
    `core.hooksPath=${join(cwd, ".git", "disabled-hooks")}`,
  ];

  const result = Bun.spawnSync(["git", ...configuration, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "TX Tests",
      GIT_AUTHOR_EMAIL: "tx@example.invalid",
      GIT_COMMITTER_NAME: "TX Tests",
      GIT_COMMITTER_EMAIL: "tx@example.invalid",
    },
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

export function initializeGitRepository(checkout: string): void {
  for (const args of [["init"], ["add", "."], ["commit", "-m", "fixture"]]) {
    fixtureGit(checkout, args);
  }
}

/** Another commit on a fixture repository's checked-out branch. */
export async function commitFixtureFiles(
  checkout: string,
  files: Readonly<Record<string, string>>,
  message: string,
): Promise<string> {
  await writeFixtureFiles(checkout, files);
  fixtureGit(checkout, ["add", "--all"]);
  fixtureGit(checkout, ["commit", "-m", message]);
  return fixtureGit(checkout, ["rev-parse", "HEAD"]);
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
