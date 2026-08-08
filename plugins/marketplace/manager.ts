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
  carriesGitSyntax,
  parseGitSourceVersion,
  windowsDrivePattern,
} from "./source.ts";
import {
  containedMarketplacePath,
  discoverInstalledMarketplaces,
  isMarketplaceReference,
  pathExists,
  prepareMarketplace,
  validateMarketplaceName,
} from "./storage.ts";

const executeFile = promisify(execFile);

export interface MarketplaceListing {
  readonly name: string;
  readonly source: string;
  readonly version: string;
}

export interface MarketplaceOperations {
  add(source: string, requestedName?: string): Promise<string>;
  list(): Promise<readonly MarketplaceListing[]>;
  pin(name: string, ref: string): Promise<string>;
  remove(name: string): Promise<void>;
  unpin(name: string): Promise<void>;
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

/** How a Git command is run, and the environment it inherits. Every read and
 * write below takes one, so a caller outside this module drives Git exactly as
 * the manager does. */
export interface GitExecution {
  readonly runGit: RunGit;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface MarketplaceManagerOptions {
  readonly runGit?: RunGit;
  readonly prepare?: (checkout: string) => Promise<void>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

const githubRepositoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const unknownSource = "<unknown>";
/** What a marketplace whose checkout cannot be read reports as its version. */
export const unknownMarketplaceVersion = "<unknown>";
/** What a referenced local marketplace reports instead of a version: its
 * contents are whatever its directory holds, so there is nothing to compare. */
export const liveMarketplaceVersion = "live";
const originRemote = "origin";
const remoteHeadRef = "refs/remotes/origin/HEAD";
const defaultSshUser = "git";
const batchModeSshCommand = "ssh -o BatchMode=yes";
const sshCommandScopes = ["--global", "--system"] as const;
const sshCommandVariable = "core.sshcommand";
/**
 * Where a pin lives: the checkout's own Git configuration, so it has the
 * lifetime of the checkout — `marketplace remove` deletes the directory and
 * the pin goes with it, with no index to keep consistent and no format to
 * migrate.
 */
const pinVariable = "tx.pin";
/**
 * A semantic version, optionally spelled with the `v` release tags carry,
 * implemented with the exclusions the specification makes so a leading zero or
 * an empty pre-release identifier is rejected rather than coerced by the
 * runtime's comparison. The marketplace plugin carries its own copy because a
 * bundled plugin's module graph stays inside that plugin; sharing one would
 * put marketplace-and-release vocabulary into feature-neutral core.
 */
const numericIdentifier = "0|[1-9]\\d*";
const prereleaseIdentifier = `${numericIdentifier}|\\d*[A-Za-z-][0-9A-Za-z-]*`;
const buildIdentifier = "[0-9A-Za-z-]+";
const versionPattern = new RegExp(
  `^v?(?:${numericIdentifier})\\.(?:${numericIdentifier})\\.(?:${numericIdentifier})` +
    `(?:-(?:${prereleaseIdentifier})(?:\\.(?:${prereleaseIdentifier}))*)?` +
    `(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`,
);

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
    if (scpSeparator >= 0 && !windowsDrivePattern.test(candidate)) {
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
function rawUserinfo(repository: string): string | undefined {
  const scheme = repository.indexOf("://");
  if (scheme < 0) return undefined;
  const start = scheme + 3;
  const delimiter = repository.slice(start).search(/[/?#]/);
  const end = delimiter < 0 ? repository.length : start + delimiter;
  const separator = repository.slice(start, end).lastIndexOf("@");
  if (separator < 0) return undefined;
  return repository.slice(start, start + separator);
}

/**
 * The literals to delete from Git's own output for a source that carries a
 * credential, longest first: the userinfo run including its trailing `@`, and
 * the same run with the password component dropped.
 *
 * Git only ever spells a credential as a `userinfo@host` run, and it spells it
 * that way in every shape it prints — the URL it was handed, the URL it echoes
 * with the password stripped, and the host-only form `credential_describe`
 * produces when it has a username but no password ("could not read Password
 * for 'https://<token>@host'", which omits the path unless
 * `credential.useHttpPath` is set). Anchoring on the run rather than
 * enumerating whole URL shapes therefore covers all of them, the host-only one
 * included, and the trailing `@` keeps a literal from colliding with host or
 * path text, which carries none.
 *
 * Two losses are accepted, both better than the alternative:
 *
 * - A userinfo *user* quoted without its `@` — a server message naming the
 *   account — survives. Deleting a bare identifier is exactly what rewrites the
 *   text around it and reports repositories nobody typed. The password is
 *   covered regardless, because Git never spells one outside a userinfo run.
 * - When the source's user is literally `git`, deleting `git@` also takes it
 *   out of Git's own quoted SSH output (`git@host:path` becomes `host:path`).
 *   Cosmetic, confined to text Git quoted, and the reported SSH name is
 *   composed separately and stays exact.
 * - An empty userinfo component contributes no literal at all. A source may
 *   legitimately leave the user out and carry the token as the password
 *   (`https://:token@host/path`, which GitHub and GitLab both accept), or
 *   spell an empty userinfo outright (`https://@host/path`); the run built
 *   from such a component would be the bare string `@`, and deleting that
 *   takes every `@` out of Git's output — `git@host` becomes `githost`, a
 *   host that does not exist, in the composed message and in the failures
 *   kept as its cause. The secret is covered regardless: the run Git actually
 *   quotes for the first form is `:token@`, the whole userinfo, and if Git
 *   ever quotes the password-stripped `https://@host/path` there is no
 *   credential left in it to remove.
 */
export function credentialRedactions(repository: string): readonly string[] {
  const userinfo = rawUserinfo(repository);
  if (userinfo === undefined) return [];

  const separator = userinfo.indexOf(":");
  const user = separator < 0 ? userinfo : userinfo.slice(0, separator);
  const runs = new Set(
    [userinfo, user].filter(Boolean).map((run) => `${run}@`),
  );
  return [...runs].sort((left, right) => right.length - left.length);
}

/** Text with every one of a source's credential literals taken out of it. */
export function withoutCredentials(
  text: string,
  redactions: readonly string[],
): string {
  return redactions.reduce(
    (redacted, literal) => redacted.split(literal).join(""),
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
  redactions: readonly string[],
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
  redactions: readonly string[],
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

/**
 * Whether an environment configures `core.sshCommand` through Git's
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` protocol
 * (Git 2.31 and later), the documented way to supply configuration without
 * writing a file.
 *
 * This is *command*-scope configuration, and a clone applies it: it outranks
 * the global and system files, and unlike the local scope it is not tied to
 * whatever repository the caller happens to be standing in. So a deploy key
 * pinned this way names a command the clone really does run, and injecting a
 * default over it would drop the key — which is why command scope is read here
 * while local scope deliberately is not. It is also the only such scope
 * reachable without a Git call, since this code builds the clone's argv itself
 * and passes no `-c` of its own.
 *
 * Section and variable names are case-insensitive in Git configuration, so the
 * key is compared that way. A `GIT_CONFIG_COUNT` that is not a whole number —
 * absent, malformed, fractional — describes no entries and is scanned as none;
 * a negative one needs no guard of its own, since the scan starts at zero.
 *
 * A value is trimmed before it counts, so that a blank one reads as
 * unconfigured in this scope exactly as it does in the file scopes below,
 * which compare the trimmed output of `git config --get`.
 */
function hasEnvironmentSshCommand(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const { GIT_CONFIG_COUNT: declared } = env;
  const count = Number(declared);
  if (!Number.isInteger(count)) return false;
  for (let index = 0; index < count; index += 1) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    if (key?.toLowerCase() === sshCommandVariable) {
      if (env[`GIT_CONFIG_VALUE_${index}`]?.trim()) return true;
    }
  }
  return false;
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

/**
 * Whether Git configuration names an SSH command in a scope the operation
 * about to run applies. The environment's own command-scope entries are
 * scanned first, because they outrank every file and cost no Git call; after
 * them the configuration files are read, one scope at a time.
 *
 * Which files those are is exactly the difference between an operation that
 * runs *inside* a repository and one that creates it. A fetch runs inside the
 * checkout it names, so that checkout's own `--local` configuration applies
 * and outranks both files — it is asked first, and a per-checkout deploy key
 * set there is honoured rather than overridden. A clone passes no checkout,
 * and `--local` MUST NOT be read for it: `git clone` creates the repository it
 * writes into, so it never applies the local configuration of whatever
 * repository the caller happens to be standing in. Reading that scope for a
 * clone would report a command the clone will not use, suppress batch mode for
 * nothing, and leave ssh(1) free to block on the host-key prompt the default
 * exists to prevent.
 *
 * Each scope is asked for separately rather than parsed out of
 * `--show-scope`, which works on every Git version and leaves no output
 * format to misread. `git config --get` exits non-zero for a variable that is
 * not set, which `runGit` reports as a failure, so an unset variable and a
 * configuration file that cannot be read are alike here: nothing is
 * configured, and the default applies.
 *
 * The probe itself reads configuration rather than reaching a remote, so it
 * runs under the invoking environment.
 */
async function hasConfiguredSshCommand(
  execution: GitExecution,
  checkout?: string,
): Promise<boolean> {
  if (hasEnvironmentSshCommand(execution.env)) return true;
  const probes = [
    ...(checkout === undefined ? [] : [["-C", checkout, "config", "--local"]]),
    ...sshCommandScopes.map((scope) => ["config", scope]),
  ];
  for (const probe of probes) {
    try {
      const { stdout } = await execution.runGit(
        [...probe, "--get", "core.sshCommand"],
        { env: execution.env },
      );
      if (stdout.trim() !== "") return true;
    } catch {
      // Unset in this scope, or a file this process cannot read.
    }
  }
  return false;
}

/**
 * The environment every operation against a remote runs in — a clone attempt
 * and a fetch alike, which is why there is one definition of it. Git's own
 * terminal prompt is always off, because a private HTTP(S) clone without a
 * credential would otherwise block on `/dev/tty` and the SSH retry would never
 * run, and because `tx update` walks every installed marketplace, where one
 * prompt would stall the whole run; credential helpers and `GIT_ASKPASS` stay
 * untouched, so a credential the user did configure still resolves.
 *
 * On top of that, batch mode by default — a missing key or an unknown host key
 * fails rather than asking — but never in place of an SSH command the caller
 * configured. Git takes one from `GIT_SSH_COMMAND`, from `GIT_SSH`, or from
 * `core.sshCommand`, and each is a deliberate invocation: an identity file, an
 * alternate config, a proxy command. Overriding one would drop the deploy key
 * of exactly the setup the SSH retry exists to serve. The two environment
 * variables settle the question without reading any configuration, so the
 * probe runs only when neither is set.
 *
 * A checkout is given by an operation that runs inside one, so its own
 * configuration counts among the scopes probed; a clone passes none.
 */
export async function nonInteractiveGitEnvironment(
  execution: GitExecution,
  checkout?: string,
): Promise<Readonly<Record<string, string | undefined>>> {
  const promptless = { ...execution.env, GIT_TERMINAL_PROMPT: "0" };
  const { GIT_SSH_COMMAND: sshCommand, GIT_SSH: sshProgram } = execution.env;
  if (sshCommand || sshProgram) return promptless;
  if (await hasConfiguredSshCommand(execution, checkout)) return promptless;
  return { ...promptless, GIT_SSH_COMMAND: batchModeSshCommand };
}

/**
 * A Git read whose failure and whose blank answer mean the same thing: the
 * thing asked about is not there. One definition, because every caller of it
 * is asking Git a question it answers by exit status — an unset configuration
 * variable, a revision that names nothing, a checkout too broken to say — and
 * each would otherwise repeat the same swallow.
 */
async function readOptional(
  read: () => Promise<string>,
): Promise<string | undefined> {
  try {
    return (await read()) || undefined;
  } catch {
    return undefined;
  }
}

/** One Git command inside a checkout, answered by its trimmed output. */
async function readCheckout(
  checkout: string,
  args: readonly string[],
  execution: GitExecution,
): Promise<string> {
  const { stdout } = await execution.runGit(["-C", checkout, ...args], {
    env: execution.env,
  });
  return stdout.trim();
}

/** The commit a checkout currently holds. */
export async function readCheckoutCommit(
  checkout: string,
  execution: GitExecution,
): Promise<string> {
  return readCheckout(checkout, ["rev-parse", "HEAD"], execution);
}

/**
 * A commit's version label: a tag reachable from it where the marketplace
 * publishes tags, and an abbreviated hash where it does not, so a user reads
 * `v1.4.0` rather than a hash whenever there is something better to read.
 */
export async function readCommitLabel(
  checkout: string,
  commit: string,
  execution: GitExecution,
): Promise<string> {
  return readCheckout(
    checkout,
    ["describe", "--tags", "--always", commit],
    execution,
  );
}

/**
 * The tracked paths a checkout has modified, staged or not. Untracked files
 * are deliberately absent: dependency installation writes them into every
 * checkout, so blocking on one would fire on tx's own side effect.
 */
export async function readModifiedTrackedFiles(
  checkout: string,
  execution: GitExecution,
): Promise<readonly string[]> {
  const output = await readCheckout(
    checkout,
    ["diff", "--name-only", "HEAD", "--"],
    execution,
  );
  return output === "" ? [] : output.split("\n");
}

/**
 * Whether one commit is an ancestor of another, a commit counting as its own.
 * Counted rather than asked through `merge-base --is-ancestor`, which answers
 * by exit status: a failed Git command is indistinguishable from a negative
 * answer here, and reporting a broken checkout as a rewritten upstream would
 * name the wrong remedy.
 */
export async function isCommitAncestor(
  checkout: string,
  ancestor: string,
  descendant: string,
  execution: GitExecution,
): Promise<boolean> {
  const count = await readCheckout(
    checkout,
    ["rev-list", "--count", `${descendant}..${ancestor}`, "--"],
    execution,
  );
  return count === "0";
}

/**
 * Brings a checkout's view of its remote up to date, tags included, and
 * re-resolves the remote's default branch. Re-resolution is what keeps a
 * marketplace installed before its remote renamed its default branch from
 * reporting a missing ref forever.
 *
 * Tags are taken as the remote publishes them now: a fetch that is not forced
 * refuses to update a tag that already exists locally and fails the whole
 * fetch for it, which would report an unreachable remote for a publisher who
 * merely moved a tag, and would leave a pin naming a ref whose local answer is
 * stale. Tag immutability is the remote's contract rather than tx's, and the
 * checkout is tx's own, so following what the remote says is both the honest
 * reading and the only one that keeps the fetch working.
 *
 * Both commands reach the remote, so both run non-interactively.
 */
export async function fetchCheckoutRemote(
  checkout: string,
  execution: GitExecution,
): Promise<void> {
  const remote: GitExecution = {
    runGit: execution.runGit,
    // The checkout is named, so an SSH command configured in its own
    // repository counts: a fetch runs inside it and Git applies it.
    env: await nonInteractiveGitEnvironment(execution, checkout),
  };
  await readCheckout(
    checkout,
    ["fetch", "--tags", "--force", originRemote],
    remote,
  );
  await readCheckout(
    checkout,
    ["remote", "set-head", originRemote, "--auto"],
    remote,
  );
}

/**
 * The commit the remote's default branch points at, as the last fetch
 * resolved it. This is the whole of what an unpinned marketplace tracks; a pin
 * replaces this resolution and nothing else.
 */
export async function readRemoteDefaultCommit(
  checkout: string,
  execution: GitExecution,
): Promise<string> {
  return readCheckout(checkout, ["rev-parse", remoteHeadRef], execution);
}

/** The remote a checkout was cloned from, exactly as it is recorded. */
export async function readRemoteSource(
  checkout: string,
  execution: GitExecution,
): Promise<string> {
  return readCheckout(
    checkout,
    ["config", "--get", "remote.origin.url"],
    execution,
  );
}

/**
 * Moves a checkout onto a commit, detached. One operation covers an update, a
 * pin, and the restoration of a previous commit, and it leaves "did the
 * checkout move" a single commit comparison. An ordinary checkout refuses
 * rather than overwriting an untracked file in the way, which is the refusal
 * the caller reports instead of forcing past.
 */
export async function moveCheckout(
  checkout: string,
  commit: string,
  execution: GitExecution,
): Promise<void> {
  await readCheckout(checkout, ["checkout", "--detach", commit], execution);
}

/**
 * Puts a checkout back on a commit it is known to have held cleanly, and
 * forces it, which `moveCheckout` deliberately does not.
 *
 * The two are asymmetric because what stands in the way is. A move forward
 * refuses to overwrite anything, because whatever it would overwrite is the
 * user's. A restoration runs only after the blocking checks found the checkout
 * clean and only after tx moved it itself, so every tracked modification it
 * would discard was made after that point by the preparation now being undone
 * — trusted code writing into a checkout tx owns. Refusing there would leave
 * the marketplace on a commit that failed validation, which is the one outcome
 * the restoration exists to prevent, and it is what an ordinary checkout does
 * the moment a dependency install rewrites a tracked lockfile before failing.
 */
export async function restoreCheckout(
  checkout: string,
  commit: string,
  execution: GitExecution,
): Promise<void> {
  await readCheckout(
    checkout,
    ["checkout", "--force", "--detach", commit],
    execution,
  );
}

/**
 * The ref a checkout is pinned to, as the user spelled it, or nothing when it
 * tracks its remote's default branch. `git config --get` exits non-zero for a
 * variable that is not set, which is indistinguishable here from a
 * configuration this process cannot read — and both mean the same thing: no
 * pin, so the default branch is what this marketplace follows.
 */
export async function readMarketplacePin(
  checkout: string,
  execution: GitExecution,
): Promise<string | undefined> {
  return readOptional(() =>
    readCheckout(
      checkout,
      ["config", "--local", "--get", pinVariable],
      execution,
    ),
  );
}

/**
 * Records a pin, as the user spelled it. `--end-of-options` is what keeps a
 * ref beginning with `-` a ref rather than an option Git would try to read.
 */
export async function writeMarketplacePin(
  checkout: string,
  ref: string,
  execution: GitExecution,
): Promise<void> {
  await readCheckout(
    checkout,
    ["config", "--local", "--end-of-options", pinVariable, ref],
    execution,
  );
}

/** Clears a pin, returning the marketplace to its remote's default branch. */
export async function clearMarketplacePin(
  checkout: string,
  execution: GitExecution,
): Promise<void> {
  await readCheckout(
    checkout,
    ["config", "--local", "--unset", pinVariable],
    execution,
  );
}

/**
 * One revision, resolved to the commit it names, or nothing — which is how
 * `rev-parse --quiet` answers a revision that names nothing, and the only
 * outcome this has to tell apart. `--end-of-options` keeps a revision
 * beginning with `-` a revision rather than an option.
 */
async function readResolvedCommit(
  checkout: string,
  revision: string,
  execution: GitExecution,
): Promise<string | undefined> {
  return readOptional(() =>
    readCheckout(
      checkout,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", revision],
      execution,
    ),
  );
}

/**
 * The commit a ref names, resolved against what the remote published into this
 * repository: a tag first, then a remote branch, then the ref as a commit,
 * which is the order the spec fixes. A ref beginning with a digit is tried
 * once more with a `v` prefix, because `@1.4.0` is what a user types and
 * `v1.4.0` is what almost every repository tags — bounded to one extra
 * attempt, after the literal ref failed everywhere, so it can shadow nothing.
 *
 * Each candidate is peeled to a commit, so an annotated tag resolves to what
 * it points at rather than to the tag object.
 */
export async function resolveMarketplaceRef(
  checkout: string,
  ref: string,
  execution: GitExecution,
): Promise<string> {
  const attempts = /^\d/.test(ref) ? [ref, `v${ref}`] : [ref];
  for (const attempt of attempts) {
    for (const revision of [
      `refs/tags/${attempt}`,
      `refs/remotes/${originRemote}/${attempt}`,
      attempt,
    ]) {
      const commit = await readResolvedCommit(
        checkout,
        `${revision}^{commit}`,
        execution,
      );
      if (commit !== undefined) return commit;
    }
  }
  throw new Error(`Version "${ref}" is not published by the remote`);
}

/** Whether a tag is a version this plugin may order at all. */
function isSemanticVersion(tag: string): boolean {
  return versionPattern.test(tag);
}

/** A validated version's numeric components, and whether it carries a
 * pre-release — read ahead of the build metadata, which may itself contain the
 * `-` that introduces one. */
function versionParts(version: string): {
  readonly core: readonly number[];
  readonly prerelease: boolean;
} {
  const [withoutBuild = ""] = version.split("+");
  const core = withoutBuild.replace(/^v/, "");
  const separator = core.indexOf("-");
  return {
    core: (separator < 0 ? core : core.slice(0, separator))
      .split(".")
      .map(Number),
    prerelease: separator >= 0,
  };
}

/**
 * Whether a release version is higher than another version, as semantic
 * versions. The candidate carries no pre-release — every caller excludes one
 * before comparing, because a pre-release is the version its publisher has not
 * offered yet — so identical cores are decided by the other side alone: a
 * pre-release precedes the release it leads to, and two releases with the same
 * core are the same version. That is the whole ordering this plugin needs, and
 * it is written out rather than delegated because the marketplace plugin is
 * type-checked by consumers who have no Bun types.
 */
function isHigherRelease(candidate: string, version: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(version);
  for (let index = 0; index < left.core.length; index += 1) {
    const [leading, trailing] = [left.core[index] ?? 0, right.core[index] ?? 0];
    if (leading !== trailing) return leading > trailing;
  }
  return right.prerelease;
}

/**
 * The highest release tag the remote publishes above a pin, or nothing.
 *
 * Only a tag that parses as a semantic version may be reported, and only a pin
 * that parses as one may be compared against: creation time, lexical order and
 * reachability each order tags differently, and only one of them answers the
 * question a user asks about a release. A pre-release is never reported,
 * whatever the pin is — it is precisely the version its publisher has not
 * offered yet — while a pin may name one, and the first ordinary release above
 * it is then reported normally.
 */
export async function readHigherReleaseTag(
  checkout: string,
  pin: string,
  execution: GitExecution,
): Promise<string | undefined> {
  if (!isSemanticVersion(pin)) return undefined;

  const listed = await readCheckout(checkout, ["tag", "--list"], execution);
  let highest: string | undefined;
  for (const line of listed.split("\n")) {
    const tag = line.trim();
    if (!isSemanticVersion(tag) || versionParts(tag).prerelease) continue;
    if (!isHigherRelease(tag, pin)) continue;
    if (highest === undefined || isHigherRelease(tag, highest)) highest = tag;
  }
  return highest;
}

/**
 * One column of a listing, or the placeholder that stands for what a corrupt
 * checkout could not answer. Blank counts as unanswered, so the listing never
 * leaves a column empty or varies its wording between rows.
 */
async function listedColumn(
  read: () => Promise<string>,
  placeholder: string,
): Promise<string> {
  return (await readOptional(read)) ?? placeholder;
}

export class MarketplaceManager implements MarketplaceOperations {
  readonly #root: string;
  readonly #runGit: RunGit;
  readonly #prepare: ((checkout: string) => Promise<void>) | undefined;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #cwd: string;
  /** How this manager drives Git, for the shared operations above. */
  readonly #execution: GitExecution;

  constructor(root: string, options: MarketplaceManagerOptions = {}) {
    this.#root = root;
    this.#runGit = options.runGit ?? runGit;
    this.#prepare = options.prepare;
    this.#env = options.env ?? process.env;
    this.#cwd = options.cwd ?? process.cwd();
    this.#execution = { runGit: this.#runGit, env: this.#env };
  }

  async add(source: string, requestedName?: string): Promise<string> {
    // Rejected before anything is resolved: resolving an empty source yields
    // the working directory, which would install into wherever the user
    // happens to be standing.
    if (!source) throw new Error("Marketplace source must not be empty");

    // Classification first, on the argument exactly as it was typed: a
    // directory named `tools@2` is that directory, so only a source Git is
    // being handed is examined for a version at all.
    const local = await this.#resolveLocalSource(source);
    const { source: repository, ref } =
      local === undefined
        ? parseGitSourceVersion(source)
        : { source, ref: undefined };
    if (ref !== undefined)
      await this.#requireVersionableSource(repository, ref);

    const name =
      requestedName ??
      derivedName(source, () =>
        local === undefined
          ? deriveMarketplaceName(repository)
          : deriveLocalMarketplaceName(local),
      );
    const target = containedMarketplacePath(this.#root, name);
    await mkdir(this.#root, { recursive: true });
    await this.#requireAvailable(name, target);

    if (local !== undefined) return this.#reference(local, name, target);
    return this.#clone(repository, name, target, ref);
  }

  /**
   * Refuses a version suffix whose source turns out to name a local directory.
   * Classification already decided this argument belongs to Git — the literal
   * the user typed does not exist — so this probe never changes which source is
   * installed; it only reports the version the user asked for as impossible,
   * which is what `./tools@v1` beside a `./tools` directory means, rather than
   * quietly cloning a snapshot of a directory that would have been referenced
   * live.
   */
  async #requireVersionableSource(
    repository: string,
    ref: string,
  ): Promise<void> {
    if ((await this.#resolveLocalSource(repository)) === undefined) return;
    throw new Error(
      `Marketplace source "${repository}" is a local directory, so version "${ref}" cannot be pinned to it; a local marketplace is referenced live`,
    );
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
    const env = await nonInteractiveGitEnvironment(this.#execution);
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
   * Publication is deliberately outside the retry: preparation runs a trusted
   * lifecycle script and the name check reports a marketplace someone else
   * installed, and neither becomes true by cloning the same commit again.
   */
  async #clone(
    source: string,
    name: string,
    target: string,
    ref?: string,
  ): Promise<string> {
    const staging = await this.#cloneStaging(source, name, dirname(target));
    try {
      if (ref !== undefined) await this.#stageVersion(staging, ref);
      await this.#prepareCheckout(staging);
      await this.#requireAvailable(name, target);
      await rename(staging, target);
      return name;
    } finally {
      // Through the helper rather than `rm` directly: preparation and the name
      // check both throw failures the user needs to read, and a removal the
      // filesystem refuses would replace them from inside this `finally`.
      await discardStaging(staging);
    }
  }

  /**
   * Moves the staged clone onto the ref the user named and records the pin
   * there, before anything is validated or published. The clone itself is
   * unchanged — one clone, retry included — and only what is checked out
   * afterwards differs; a ref that resolves nowhere fails the addition, and
   * staging is discarded exactly as it is for any other publication failure.
   */
  async #stageVersion(staging: string, ref: string): Promise<void> {
    const commit = await resolveMarketplaceRef(staging, ref, this.#execution);
    await moveCheckout(staging, commit, this.#execution);
    await writeMarketplacePin(staging, ref, this.#execution);
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
        async ({ name, checkout }): Promise<MarketplaceListing> => ({
          name,
          // One column cannot cost the other: a checkout whose remote was
          // removed still holds a commit worth reporting, and one that cannot
          // answer either is still listed and still removable.
          source: await listedColumn(
            () => this.#listedSource(checkout),
            unknownSource,
          ),
          version: await listedColumn(
            () => this.#listedVersion(checkout),
            unknownMarketplaceVersion,
          ),
        }),
      ),
    );
  }

  /**
   * A reference reports the directory tx reads, not the remote that directory
   * happens to have configured.
   */
  async #listedSource(checkout: string): Promise<string> {
    return (await isMarketplaceReference(checkout))
      ? readlink(checkout)
      : readRemoteSource(checkout, this.#execution);
  }

  /**
   * The participant's own label, read out of the checkout, so listing stays
   * offline. A reference has no version: its contents are whatever its
   * directory holds when tx runs.
   */
  async #listedVersion(checkout: string): Promise<string> {
    return (await isMarketplaceReference(checkout))
      ? liveMarketplaceVersion
      : readCommitLabel(checkout, "HEAD", this.#execution);
  }

  /**
   * Records a pin against a ref the remote really publishes, and answers with
   * the version label the next update will move to.
   *
   * The remote is fetched first, so a ref published since the marketplace was
   * installed resolves; the pin is written only once the ref resolved, so a
   * typo is rejected while the previous pin stands. The checkout is
   * deliberately not moved: moving one runs validation and a trusted
   * dependency installation, which is `tx update`'s job and carries its
   * failure handling, and a pin command that quietly did all that would be an
   * update with a different name.
   */
  async pin(name: string, ref: string): Promise<string> {
    const checkout = await this.#pinnableCheckout(name);
    await fetchCheckoutRemote(checkout, this.#execution);
    const commit = await resolveMarketplaceRef(checkout, ref, this.#execution);
    await writeMarketplacePin(checkout, ref, this.#execution);
    return readCommitLabel(checkout, commit, this.#execution);
  }

  /** Clears a pin, if one is set, so the marketplace tracks its remote's
   * default branch again on the next update. */
  async unpin(name: string): Promise<void> {
    const checkout = await this.#pinnableCheckout(name);
    if ((await readMarketplacePin(checkout, this.#execution)) !== undefined) {
      await clearMarketplacePin(checkout, this.#execution);
    }
  }

  /** An installed marketplace a pin can be about at all. */
  async #pinnableCheckout(name: string): Promise<string> {
    const checkout = containedMarketplacePath(this.#root, name);
    if (!(await pathExists(checkout))) {
      throw new Error(`Marketplace "${name}" is not installed`);
    }
    if (await isMarketplaceReference(checkout)) {
      throw new Error(
        `Marketplace "${name}" is a live local reference, so there is no version to pin it to`,
      );
    }
    return checkout;
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
