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
const batchModeSshCommand = "ssh -o BatchMode=yes";

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
 * The result is always `git@host:path` in the SCP syntax a forge's own
 * instructions and an `ssh_config` are written in. Nothing from the HTTP(S)
 * authority beyond the host survives: userinfo is an HTTP credential rather
 * than an SSH login, which every forge that matters answers as `git` anyway,
 * and an HTTP(S) port is not an SSH port, so carrying one would open an SSH
 * handshake against the HTTPS listener. A user needing another login or
 * another port types that SSH source themselves.
 *
 * The path is decoded because Git decodes percent-escapes in an `ssh://` URL
 * but not in SCP syntax, where `my%20repo.git` would ask the remote for a
 * repository spelled exactly that; a malformed escape derives nothing rather
 * than a source that is wrong.
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

  const encoded = url.pathname.replace(/^\/+/, "");
  if (!encoded) return undefined;
  try {
    return `${defaultSshUser}@${url.hostname}:${decodeURIComponent(encoded)}`;
  } catch {
    return undefined;
  }
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
 * Every literal a source's userinfo puts into text written about that source:
 * the `userinfo@` run as the source spells it, the `user@` run Git echoes
 * after dropping the password itself, and the user and the password alone.
 * A source without userinfo, and anything that is not a URL, carries nothing.
 *
 * `https://<token>@host/owner/repository.git` is a supported source, so a
 * failure that quotes it — the attempts this reports by name, and Git's own
 * stderr, which repeats the clone URL minus only its password — would write
 * a live credential to standard error. Nothing distinguishes a person's
 * account name from a token used as one, so both go.
 */
function sourceCredentials(repository: string): readonly string[] {
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return [];
  }
  const { username, password } = url;
  const userinfo = password ? `${username}:${password}` : username;
  const literals = new Set(
    [userinfo && `${userinfo}@`, username && `${username}@`, password, username]
      .filter((literal) => literal !== "")
      .sort((left, right) => right.length - left.length),
  );
  return [...literals];
}

/** Text with every one of a source's credential literals taken out of it. */
function withoutCredentials(
  text: string,
  credentials: readonly string[],
): string {
  return credentials.reduce(
    (redacted, credential) => redacted.split(credential).join(""),
    text,
  );
}

/**
 * A failure carrying no credential. The error is returned as it is when there
 * was nothing to remove, so the common case keeps its original stack; an error
 * whose message quoted a credential is replaced rather than sanitized in
 * place, because its own stack repeats that message.
 */
function withoutCredentialsInFailure(
  failure: Error,
  credentials: readonly string[],
): Error {
  const message = withoutCredentials(failure.message, credentials);
  return message === failure.message ? failure : new Error(message);
}

/**
 * What to throw once every clone attempt is spent. A lone failure is reported
 * exactly as Git reported it, because there was no retry to describe. Two are
 * inlined into one message, since the CLI surfaces `error.message` and a user
 * looking at a failed private install needs to see that SSH was tried and how
 * it went; both errors survive as the cause so neither is lost. The source's
 * credential is taken out of all of it — the attempt names, the Git output
 * quoted between them, and the errors kept as the cause alike.
 */
function cloneFailure(
  attempts: readonly string[],
  failures: readonly Error[],
  credentials: readonly string[],
): unknown {
  if (failures.length < 2) return failures.at(0);

  const [primary = "", fallback = ""] = attempts;
  const detail = failures.map(({ message }) => message).join("; ");
  return new Error(
    withoutCredentials(
      `Cloning "${primary}" failed and the SSH retry "${fallback}" failed too: ${detail}`,
      credentials,
    ),
    {
      cause: new AggregateError(
        failures.map((failure) =>
          withoutCredentialsInFailure(failure, credentials),
        ),
      ),
    },
  );
}

/**
 * Removes a staging directory without letting the removal become the failure.
 * A partial checkout the filesystem refuses to unlink is a directory left
 * behind; reporting that instead of the clone error, and abandoning the retry
 * this whole path exists for, would lose the failure the user needs and the
 * install they asked for while leaving the directory behind anyway.
 */
async function discardStaging(staging: string): Promise<void> {
  try {
    await rm(staging, { recursive: true, force: true });
  } catch {
    // The clone failure stands, and the next attempt stages elsewhere.
  }
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
    const derived = deriveMarketplaceSshRepository(repository);
    const attempts =
      derived === undefined ? [repository] : [repository, derived];
    const credentials = sourceCredentials(repository);
    // Git's own terminal prompt is off for every attempt, because a private
    // HTTP(S) clone without a credential otherwise blocks on `/dev/tty` and
    // the SSH retry never runs. Credential helpers and `GIT_ASKPASS` are
    // deliberately untouched, so a credential the user did configure still
    // resolves. Only the derived retry asks for more than that, and only
    // once it is reached.
    const promptless = { ...this.#env, GIT_TERMINAL_PROMPT: "0" };
    const failures: Error[] = [];

    for (const candidate of attempts) {
      const env =
        candidate === derived
          ? await this.#sshAttemptEnv(promptless)
          : promptless;
      const staging = await mkdtemp(join(parent, `.${name}-staging-`));
      try {
        await this.#runGit(["clone", "--", candidate, staging], { env });
        return staging;
      } catch (error) {
        failures.push(error as Error);
        await discardStaging(staging);
      }
    }
    throw cloneFailure(attempts, failures, credentials);
  }

  /**
   * The environment for the derived SSH attempt: batch mode by default, so a
   * missing key or an unknown host key fails rather than asking, but never in
   * place of an SSH command the caller configured. Git takes one from
   * `GIT_SSH_COMMAND`, from `GIT_SSH`, or from `core.sshCommand`, and each is
   * a deliberate invocation — an identity file, an alternate config, a proxy
   * command. Overriding one would drop the deploy key of exactly the setup
   * this retry exists to serve.
   */
  async #sshAttemptEnv(
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<Readonly<Record<string, string | undefined>>> {
    const { GIT_SSH_COMMAND: sshCommand, GIT_SSH: sshProgram } = env;
    if (sshCommand || sshProgram) return env;
    if (await this.#hasConfiguredSshCommand()) return env;
    return { ...env, GIT_SSH_COMMAND: batchModeSshCommand };
  }

  /**
   * Whether Git configuration names an SSH command. `git config --get` exits
   * non-zero for a variable that is not set, which `runGit` reports as a
   * failure, so an unset variable and an unreadable configuration are alike
   * here: nothing is configured, and the default applies.
   */
  async #hasConfiguredSshCommand(): Promise<boolean> {
    try {
      const { stdout } = await this.#runGit(
        ["config", "--get", "core.sshCommand"],
        { env: this.#env },
      );
      return stdout.trim() !== "";
    } catch {
      return false;
    }
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
