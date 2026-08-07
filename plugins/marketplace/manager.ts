import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  containedMarketplacePath,
  discoverInstalledMarketplaces,
  pathExists,
  prepareMarketplace,
  validateMarketplaceName,
} from "./storage.ts";

const executeFile = promisify(execFile);

export interface MarketplaceListing {
  readonly name: string;
  readonly source: string;
}

export interface MarketplaceOperations {
  add(source: string, requestedName?: string): Promise<string>;
  list(): Promise<readonly MarketplaceListing[]>;
  remove(name: string): Promise<void>;
}

export interface GitResult {
  readonly stdout: string;
}

export type RunGit = (
  args: readonly string[],
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
  },
) => Promise<GitResult>;

export interface MarketplaceManagerOptions {
  readonly runGit?: RunGit;
  readonly prepare?: (checkout: string) => Promise<void>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

const githubRepositoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const windowsDrivePattern = /^[A-Za-z]:[\\/]/;
const unknownSource = "<unknown>";
const defaultSshUser = "git";
const derivedSshUserPattern = new RegExp(`^(?!${defaultSshUser}@)[^@/]*@`);

export function normalizeMarketplaceRepository(repository: string): string {
  if (!githubRepositoryPattern.test(repository)) return repository;
  return `https://github.com/${repository}${repository.endsWith(".git") ? "" : ".git"}`;
}

/**
 * The SSH source for an already-normalized HTTP(S) repository, or undefined
 * for every other source form: an `ssh://` URL, SCP-style `host:path`,
 * `file://`, `git://`, a bare path, and a Windows drive letter all either
 * fail this parse or carry another protocol, and each of them is a source
 * Git can already reach as it was typed.
 *
 * SCP syntax is what a forge's own instructions and an `ssh_config` are
 * written in, so it is the normal spelling — but it has nowhere to put a
 * port, which is why a source carrying one becomes an `ssh://` URL instead.
 * The userinfo user is kept because an internal forge is exactly where a
 * user other than `git` occurs; the password is dropped because it is an
 * HTTP(S) credential that means nothing over SSH.
 */
export function deriveMarketplaceSshRepository(
  repository: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const path = url.pathname.replace(/^\/+/, "");
  if (!path) return undefined;
  const user = url.username || defaultSshUser;
  return url.port
    ? `ssh://${user}@${url.host}${url.pathname}`
    : `${user}@${url.hostname}:${path}`;
}

export function deriveMarketplaceName(repository: string): string {
  if (!repository) throw new Error("Repository must not be empty");

  let candidate = repository.replace(/[\\/]+$/, "");
  try {
    const url = new URL(candidate);
    candidate = url.pathname;
  } catch {
    const scpSeparator = candidate.indexOf(":");
    if (scpSeparator >= 0 && !/^[A-Za-z]:[\\/]/.test(candidate)) {
      candidate = candidate.slice(scpSeparator + 1);
    }
  }

  const components = candidate.split(/[\\/]/).filter(Boolean);
  const finalComponent = components.at(-1) ?? "";
  const name = finalComponent.endsWith(".git")
    ? finalComponent.slice(0, -4)
    : finalComponent;
  return validateMarketplaceName(name);
}

/**
 * A URL scheme and SCP-style `host:path` syntax both put a colon ahead of the
 * first slash, which is exactly when Git reads one as a remote; a Windows
 * drive letter is the one such colon that still names a local path. Git keeps
 * every source carrying either, which is what leaves `file://` a clone.
 */
function carriesGitSyntax(source: string): boolean {
  const separator = source.indexOf(":");
  if (separator < 0 || windowsDrivePattern.test(source)) return false;
  return !source.slice(0, separator).includes("/");
}

/**
 * A local source names a directory rather than a repository URL, so its final
 * component is taken as it is on disk: a directory called `tools.git` keeps
 * that suffix, unlike the Git source of the same spelling.
 */
function deriveLocalMarketplaceName(path: string): string {
  return validateMarketplaceName(basename(path));
}

function derivedName(source: string, derive: () => string): string {
  try {
    return derive();
  } catch (error) {
    throw new Error(
      `Cannot derive a safe marketplace name from "${source}"; pass --name <name>`,
      { cause: error },
    );
  }
}

/**
 * A source named without whatever credential its userinfo carries. Naming
 * the attempted sources is new here, and `https://<token>@host/owner/repo.git`
 * is a supported source, so reporting one as it was typed would newly write a
 * token to standard error.
 *
 * A derived SCP-syntax candidate does not parse as a URL, and its user is
 * `git` unless the HTTP(S) source supplied one — so `git@` is kept, being a
 * fixed default rather than anything the caller handed over, and any other
 * user is removed along with the userinfo it came from. Nothing distinguishes
 * a person's account name from a token used as one, so both go.
 */
function redactRepositoryCredentials(repository: string): string {
  try {
    const url = new URL(repository);
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return repository.replace(derivedSshUserPattern, "");
  }
}

/**
 * What to throw once every clone attempt is spent. A lone failure is reported
 * exactly as Git reported it, because there was no retry to describe. Two are
 * inlined into one message, since the CLI surfaces `error.message` and a user
 * looking at a failed private install needs to see that SSH was tried and how
 * it went; both errors survive as the cause so neither stack is lost.
 */
function cloneFailure(
  attempts: readonly string[],
  failures: readonly Error[],
): unknown {
  if (failures.length < 2) return failures.at(0);

  const [primary = "", fallback = ""] = attempts.map(
    redactRepositoryCredentials,
  );
  const detail = failures.map(({ message }) => message).join("; ");
  return new Error(
    `Cloning "${primary}" failed and the SSH retry "${fallback}" failed too: ${detail}`,
    { cause: new AggregateError(failures) },
  );
}

/**
 * The environment for a clone attempt. Git's own terminal prompt is switched
 * off and SSH is put in batch mode, because a private HTTP(S) clone without a
 * credential otherwise blocks on `/dev/tty` and the SSH retry never runs.
 * Credential helpers and `GIT_ASKPASS` are deliberately untouched, so a
 * credential the user did configure still resolves. A `GIT_SSH_COMMAND`
 * already in the environment is a deliberate SSH invocation — an identity
 * file, an alternate config, a proxy command — and is left exactly as it is,
 * because appending an option to an arbitrary shell string is guesswork.
 */
function nonInteractiveGitEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const { GIT_SSH_COMMAND: sshCommand } = env;
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: sshCommand || "ssh -o BatchMode=yes",
  };
}

export async function runGit(
  args: readonly string[],
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): Promise<GitResult> {
  try {
    const { stdout } = await executeFile("git", [...args], {
      env: options.env,
    });
    return { stdout };
  } catch (error) {
    const detail =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim()
        : "";
    throw new Error(`Git command failed${detail ? `: ${detail}` : ""}`);
  }
}

export class MarketplaceManager implements MarketplaceOperations {
  readonly #root: string;
  readonly #runGit: RunGit;
  readonly #prepare: ((checkout: string) => Promise<void>) | undefined;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #cwd: string;

  constructor(root: string, options: MarketplaceManagerOptions = {}) {
    this.#root = root;
    this.#runGit = options.runGit ?? runGit;
    this.#prepare = options.prepare;
    this.#env = options.env ?? process.env;
    this.#cwd = options.cwd ?? process.cwd();
  }

  async add(source: string, requestedName?: string): Promise<string> {
    // Rejected before anything is resolved: resolving an empty source yields
    // the working directory, which would install into wherever the user
    // happens to be standing.
    if (!source) throw new Error("Marketplace source must not be empty");

    const local = await this.#resolveLocalSource(source);
    const name =
      requestedName ??
      derivedName(source, () =>
        local === undefined
          ? deriveMarketplaceName(source)
          : deriveLocalMarketplaceName(local),
      );
    const target = containedMarketplacePath(this.#root, name);
    await mkdir(this.#root, { recursive: true });
    await this.#requireAvailable(name, target);

    if (local !== undefined) return this.#reference(local, name, target);
    return this.#clone(source, name, target);
  }

  /**
   * The real path of a local source, or undefined when the source belongs to
   * Git. Only `ENOENT` counts as absence — reporting any other inspection
   * failure as itself keeps an unreadable path from resurfacing as an
   * unrelated clone error.
   */
  async #resolveLocalSource(source: string): Promise<string | undefined> {
    if (carriesGitSyntax(source)) return undefined;

    const candidate = resolve(this.#cwd, source);
    let metadata: Stats;
    try {
      metadata = await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Marketplace source "${source}" is not a directory`);
    }
    return realpath(candidate);
  }

  /**
   * A reference is the author's own tree, so there is nothing to stage and
   * nothing to roll back: preparation runs in that tree, and a failure
   * withholds the reference while leaving the directory exactly as it is.
   */
  async #reference(
    source: string,
    name: string,
    target: string,
  ): Promise<string> {
    await this.#prepareCheckout(source);
    await this.#requireAvailable(name, target);
    await symlink(source, target);
    return name;
  }

  /**
   * The staging checkout of the first candidate source that clones. An HTTP(S)
   * source is followed by the SSH source derived from it, so a repository the
   * user can reach over SSH but not over HTTP(S) still installs; every other
   * source form is its own only candidate.
   *
   * Each attempt gets a fresh staging directory and removes it before the next
   * one starts, because `git clone` refuses a destination that is not empty and
   * a failed clone can leave a partial checkout behind — reusing one directory
   * would fail the retry for a reason that has nothing to do with SSH.
   */
  async #cloneStaging(
    source: string,
    name: string,
    parent: string,
  ): Promise<string> {
    const repository = normalizeMarketplaceRepository(source);
    const ssh = deriveMarketplaceSshRepository(repository);
    const attempts = ssh === undefined ? [repository] : [repository, ssh];
    const failures: Error[] = [];

    for (const candidate of attempts) {
      const staging = await mkdtemp(join(parent, `.${name}-staging-`));
      try {
        await this.#runGit(["clone", "--", candidate, staging], {
          env: nonInteractiveGitEnv(this.#env),
        });
        return staging;
      } catch (error) {
        failures.push(error as Error);
        await rm(staging, { recursive: true, force: true });
      }
    }
    throw cloneFailure(attempts, failures);
  }

  /**
   * Publication is deliberately outside the retry: preparation runs a trusted
   * lifecycle script and the name check reports a marketplace someone else
   * installed, and neither becomes true by cloning the same commit again.
   */
  async #clone(source: string, name: string, target: string): Promise<string> {
    const staging = await this.#cloneStaging(source, name, dirname(target));
    try {
      await this.#prepareCheckout(staging);
      await this.#requireAvailable(name, target);
      await rename(staging, target);
      return name;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async #prepareCheckout(checkout: string): Promise<void> {
    if (this.#prepare) await this.#prepare(checkout);
    else await prepareMarketplace(checkout, { env: this.#env });
  }

  async #requireAvailable(name: string, target: string): Promise<void> {
    if (await pathExists(target)) {
      throw new Error(`Marketplace "${name}" is already installed`);
    }
  }

  async list(): Promise<readonly MarketplaceListing[]> {
    const marketplaces = await discoverInstalledMarketplaces(this.#root);
    return Promise.all(
      marketplaces.map(
        async ({ name, checkout }): Promise<MarketplaceListing> => {
          let source = unknownSource;
          try {
            if ((await lstat(checkout)).isSymbolicLink()) {
              // A reference reports the directory tx reads, not the remote
              // that directory happens to have configured.
              source = await readlink(checkout);
            } else {
              const result = await this.#runGit(
                ["-C", checkout, "config", "--get", "remote.origin.url"],
                { env: this.#env },
              );
              source = result.stdout.trim() || unknownSource;
            }
          } catch {
            // A corrupt checkout remains visible and removable.
          }
          return { name, source };
        },
      ),
    );
  }

  async remove(name: string): Promise<void> {
    const target = containedMarketplacePath(this.#root, name);
    let metadata: Stats;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Marketplace "${name}" is not installed`);
      }
      throw error;
    }
    await rm(target, { recursive: metadata.isDirectory(), force: false });
  }
}
