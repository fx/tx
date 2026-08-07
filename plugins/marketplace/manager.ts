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
const sshCommandScopes = ["--global", "--system"] as const;

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
 * The name a failure reports an attempt by: the source with its userinfo
 * cleared, or the source itself when it is not a URL. The label is built this
 * way rather than scrubbed, because scrubbing a username out of text rewrites
 * the text around it — `git`, `me` and `com` are all real HTTP(S) usernames
 * and all occur in the hosts and paths a user needs to read back.
 */
function credentialFreeSource(repository: string): string {
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return repository;
  }
  url.username = "";
  url.password = "";
  return url.href;
}

interface RawUserinfo {
  readonly prefix: string;
  readonly userinfo: string;
  readonly suffix: string;
}

/**
 * A source's userinfo exactly as the source spells it, read from the string
 * rather than from a parsed `URL`: `URL` percent-encodes what it parses, while
 * Git is handed the raw string and echoes it back raw, so a literal taken from
 * the parse matches nothing the moment the credential holds a character `URL`
 * escapes (`@`, a space, `:` and the rest).
 *
 * The authority is what stands between `://` and the first `/`, `?` or `#`;
 * userinfo is everything before its last `@`, since an unescaped `@` inside a
 * password is precisely the case the parse cannot describe.
 */
function rawUserinfo(repository: string): RawUserinfo | undefined {
  const scheme = repository.indexOf("://");
  if (scheme < 0) return undefined;
  const start = scheme + 3;
  const delimiter = repository.slice(start).search(/[/?#]/);
  const end = delimiter < 0 ? repository.length : start + delimiter;
  const separator = repository.slice(start, end).lastIndexOf("@");
  if (separator < 0) return undefined;
  return {
    prefix: repository.slice(0, start),
    userinfo: repository.slice(start, start + separator),
    suffix: repository.slice(start + separator + 1),
  };
}

/**
 * What to take out of Git's own output for a source that carries a credential,
 * as `[literal, replacement]` pairs applied longest first.
 *
 * Git repeats the clone URL it was given, so the thing to remove is that whole
 * URL rather than a fragment of it: the source as it was handed over, and the
 * same source with its password component dropped, which is the form Git
 * echoes. Both are replaced by the credential-free label, so the message still
 * names the repository. The password alone follows as a safety net for output
 * that quotes it outside a URL.
 *
 * The bare username is deliberately never removed. It is an identifier rather
 * than the secret, and removing it is what corrupts the surrounding text. The
 * accepted cost is cosmetic: if Git quotes a password-stripped URL in some
 * third form, the username may survive in it.
 */
function credentialRedactions(
  repository: string,
): readonly (readonly [string, string])[] {
  const raw = rawUserinfo(repository);
  if (raw === undefined) return [];

  const label = credentialFreeSource(repository);
  const separator = raw.userinfo.indexOf(":");
  const password = separator < 0 ? "" : raw.userinfo.slice(separator + 1);
  const redactions: (readonly [string, string])[] = [[repository, label]];
  if (password) {
    const user = raw.userinfo.slice(0, separator);
    redactions.push(
      [`${raw.prefix}${user}@${raw.suffix}`, label],
      [password, ""],
    );
  }
  return redactions.sort(([left], [right]) => right.length - left.length);
}

/** Text with every one of a source's credential literals taken out of it. */
function withoutCredentials(
  text: string,
  redactions: readonly (readonly [string, string])[],
): string {
  return redactions.reduce(
    (redacted, [literal, replacement]) =>
      redacted.split(literal).join(replacement),
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
  redactions: readonly (readonly [string, string])[],
): Error {
  const message = withoutCredentials(failure.message, redactions);
  return message === failure.message ? failure : new Error(message);
}

/**
 * What to throw once every clone attempt is spent. A lone failure is reported
 * exactly as Git reported it, because there was no retry to describe. Two are
 * inlined into one message, since the CLI surfaces `error.message` and a user
 * looking at a failed private install needs to see that SSH was tried and how
 * it went; both errors survive as the cause so neither is lost.
 *
 * The labels arrive already credential-free and the Git output is scrubbed
 * before it is inlined, so no redaction ever runs over the composed sentence
 * and none of them can damage the names it reports.
 */
function cloneFailure(
  labels: readonly string[],
  failures: readonly Error[],
  redactions: readonly (readonly [string, string])[],
): unknown {
  if (failures.length < 2) return failures.at(0);

  const [primary = "", fallback = ""] = labels;
  const detail = failures
    .map(({ message }) => withoutCredentials(message, redactions))
    .join("; ");
  return new Error(
    `Cloning "${primary}" failed and the SSH retry "${fallback}" failed too: ${detail}`,
    {
      cause: new AggregateError(
        failures.map((failure) =>
          withoutCredentialsInFailure(failure, redactions),
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
export async function discardStaging(staging: string): Promise<void> {
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
    // What the failure names the attempts by. The derived candidate is always
    // `git@host:path` under the derivation rule, so it carries nothing; only
    // the source it came from has userinfo to leave out.
    const labels = [credentialFreeSource(repository), ...attempts.slice(1)];
    const redactions = credentialRedactions(repository);
    // One environment, settled before the first attempt and used by all of
    // them. Batch mode is deliberately not confined to the derived retry: an
    // `url.<base>.insteadOf` rule rewrites an HTTP(S) source to SSH on the
    // way into the *first* clone, and ssh(1) reads its own host-key and
    // passphrase prompts straight from `/dev/tty`, where Git's
    // `GIT_TERMINAL_PROMPT` cannot reach them — so scoping batch mode to the
    // retry would hang the attempt before any retry could run. An SSH command
    // is inert for a clone that really does speak HTTP(S), so applying it
    // throughout costs nothing.
    const env = await this.#cloneEnv();
    const failures: Error[] = [];

    for (const candidate of attempts) {
      const staging = await mkdtemp(join(parent, `.${name}-staging-`));
      try {
        await this.#runGit(["clone", "--", candidate, staging], { env });
        return staging;
      } catch (error) {
        failures.push(error as Error);
        await discardStaging(staging);
      }
    }
    throw cloneFailure(labels, failures, redactions);
  }

  /**
   * The environment every clone attempt runs in. Git's own terminal prompt is
   * always off, because a private HTTP(S) clone without a credential would
   * otherwise block on `/dev/tty` and the SSH retry would never run;
   * credential helpers and `GIT_ASKPASS` stay untouched, so a credential the
   * user did configure still resolves.
   *
   * On top of that, batch mode by default — a missing key or an unknown host
   * key fails rather than asking — but never in place of an SSH command the
   * caller configured. Git takes one from `GIT_SSH_COMMAND`, from `GIT_SSH`,
   * or from `core.sshCommand`, and each is a deliberate invocation: an
   * identity file, an alternate config, a proxy command. Overriding one would
   * drop the deploy key of exactly the setup this retry exists to serve. The
   * two environment variables settle the question without reading any
   * configuration, so the probe below runs only when neither is set.
   */
  async #cloneEnv(): Promise<Readonly<Record<string, string | undefined>>> {
    const promptless = { ...this.#env, GIT_TERMINAL_PROMPT: "0" };
    const { GIT_SSH_COMMAND: sshCommand, GIT_SSH: sshProgram } = this.#env;
    if (sshCommand || sshProgram) return promptless;
    if (await this.#hasConfiguredSshCommand()) return promptless;
    return { ...promptless, GIT_SSH_COMMAND: batchModeSshCommand };
  }

  /**
   * Whether Git configuration names an SSH command in a scope a clone applies.
   * Only the global and system files are read, and `--local` MUST NOT be added
   * to them: `git clone` creates the repository it writes into, so it never
   * applies the local configuration of whatever repository the caller happens
   * to be standing in. Reading that scope would report a command the clone
   * will not use, suppress batch mode for nothing, and leave ssh(1) free to
   * block on the host-key prompt the default exists to prevent.
   *
   * Each scope is asked for separately rather than parsed out of
   * `--show-scope`, which works on every Git version and leaves no output
   * format to misread. `git config --get` exits non-zero for a variable that
   * is not set, which `runGit` reports as a failure, so an unset variable and
   * a configuration file that cannot be read are alike here: nothing is
   * configured, and the default applies.
   */
  async #hasConfiguredSshCommand(): Promise<boolean> {
    for (const scope of sshCommandScopes) {
      try {
        const { stdout } = await this.#runGit(
          ["config", scope, "--get", "core.sshCommand"],
          { env: this.#env },
        );
        if (stdout.trim() !== "") return true;
      } catch {
        // Unset in this scope, or a file this process cannot read.
      }
    }
    return false;
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
