import { createHash, randomUUID } from "node:crypto";
import { chmod, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import type {
  UpdateItem,
  UpdateParticipant,
  UpdateResult,
} from "@fx/tx/plugin";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Every effect this participant has on the world outside itself. The
 * environment, when given, is the complete environment for that one child; an
 * absent one leaves the child inheriting this process's. */
export type RunCommand = (
  command: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
) => Promise<CommandResult> | CommandResult;
export type FetchResource = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<Response>;
export type StagingPath = (target: string) => string;

export interface ExecutableUpdaterOptions {
  readonly fetch?: FetchResource;
  readonly run?: RunCommand;
  /** The running program's own file. Its real path is what a manager is asked
   * about and what a replacement renames onto. */
  readonly executablePath?: string;
  readonly compiled?: boolean;
  readonly platform?: string;
  /** The environment this participant reads, and the one a delegated upgrade's
   * child is given in full. An injected environment must therefore be
   * complete: a partial one — no `HOME`, no `PATH` — is not merged over the
   * ambient environment, so it would change where a delegated upgrade installs
   * rather than only what it reads. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly staging?: StagingPath;
}

const itemName = "tx";
const repository = "fx/tx";
const releaseEndpoint = `https://api.github.com/repos/${repository}/releases/latest`;
const downloadPrefix = `https://github.com/${repository}/releases/download`;
const checksumAsset = "SHA256SUMS";
/** [Architecture: Runtime and Distribution] decides what is published; the
 * asset for a platform is named after it. */
const publishedPlatforms: readonly string[] = ["linux-x64"];
/** Exactly these two, in this order, and no other variable: a token is sent to
 * the release host, so a credential configured for a package registry or
 * another forge is not one the user offered to this request. */
const tokenVariables = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
/** A compiled Bun executable roots its own modules in Bun's virtual
 * filesystem, which is a property of the running program rather than of its
 * filename — a `bun` someone renamed to `tx` fails this and is left alone. */
const compiledModulePattern = /^(?:\/\$bunfs[/\\]|[A-Za-z]:[/\\]~BUN[/\\])/;
/**
 * A semantic version, optionally spelled with the `v` the release tags carry.
 *
 * The grammar is implemented with the exclusions the specification makes, so
 * a leading zero in any numeric component and an empty pre-release identifier
 * are both rejected. That matters because the ordering below coerces what it
 * cannot parse rather than refusing it: without this, a tag like `v01.3.0`
 * would be read as newer and offered as an update whose assets nothing could
 * then fetch.
 */
const numericIdentifier = "0|[1-9]\\d*";
const prereleaseIdentifier = `${numericIdentifier}|\\d*[A-Za-z-][0-9A-Za-z-]*`;
const buildIdentifier = "[0-9A-Za-z-]+";
const versionPattern = new RegExp(
  `^v?(?:${numericIdentifier})\\.(?:${numericIdentifier})\\.(?:${numericIdentifier})` +
    `(?:-(?:${prereleaseIdentifier})(?:\\.(?:${prereleaseIdentifier}))*)?` +
    `(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`,
);

interface Installation {
  readonly name: string;
  readonly path: string;
  /** The version this listing reports for that installation, where it reports
   * one: what an upgrade is afterwards observed against. */
  readonly version?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Everything a command wrote, on both streams, as the one line of detail an
 * item may carry: a manager that warns on one and answers on the other has
 * said both things, and reporting its output means reporting all of it. */
function oneLine(result: CommandResult): string {
  return [result.stdout, result.stderr]
    .flatMap((stream) => stream.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ");
}

export function isCompiledModulePath(path: string): boolean {
  return compiledModulePattern.test(path);
}

export function stagingPath(target: string): string {
  // Beside the target, so the replacement is a rename within one directory:
  // that is atomic, while a rename across filesystems is not.
  return join(dirname(target), `.${basename(target)}-update-${randomUUID()}`);
}

/**
 * Runs a command, reporting a command that cannot be spawned at all — a
 * manager that is not installed — as a failed run, so every caller reads one
 * shape rather than two.
 */
export async function runCommand(
  command: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<CommandResult> {
  try {
    const child = Bun.spawn([...command], {
      stdout: "pipe",
      stderr: "pipe",
      // Spread rather than passed as undefined, so a call that names no
      // environment spawns exactly as it did before there was one.
      ...(env === undefined ? {} : { env: { ...env } }),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: errorMessage(error) };
  }
}

/**
 * Removes a staged download without letting the removal become the failure. A
 * file the filesystem refuses to unlink is a file left behind; reporting that
 * instead of the verification error would lose the failure the user needs
 * while leaving the file behind anyway.
 */
export async function discardStaged(staged: string): Promise<void> {
  try {
    await rm(staged, { force: true });
  } catch {
    // The failure that brought us here stands.
  }
}

function isWithin(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${sep}`);
}

async function resolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * The installation containing the target, longest path first: a manager's own
 * root contains every tool it installed, so the innermost match is the owner.
 *
 * A path that does not contain the target as it was spelled is resolved before
 * it is ruled out. The target is compared as its real path, while a manager
 * echoes back the spelling it was configured with, so a store reached through
 * a symbolic link would otherwise not contain its own installs.
 */
async function owner(
  target: string,
  installations: readonly Installation[],
): Promise<string | undefined> {
  let best: Installation | undefined;
  for (const installation of installations) {
    const path = isWithin(installation.path, target)
      ? installation.path
      : await resolvedPath(installation.path);
    if (!isWithin(path, target)) continue;
    if (best === undefined || path.length > best.path.length) {
      best = { name: installation.name, path };
    }
  }
  return best?.name;
}

export type ManagerKind = "mise" | "npm";

interface Manager {
  readonly name: string;
  /** What this manager calls the thing that owns a path, for its failures. */
  readonly noun: string;
  readonly listing: readonly string[];
  /** The installations the listing describes, or undefined when it cannot be
   * read at all. */
  read(stdout: string): readonly Installation[] | undefined;
  upgrade(name: string): readonly string[];
  /** What this manager's upgrade command runs with, merged over the injected
   * environment. It reaches that one child and nothing else. */
  readonly upgradeEnvironment?: Readonly<Record<string, string>>;
}

/** mise reports one entry per installed version, keyed by tool name. */
function readMiseListing(stdout: string): readonly Installation[] | undefined {
  const parsed = parsedJson(stdout);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const installations: Installation[] = [];
  for (const [name, versions] of Object.entries(parsed)) {
    if (!Array.isArray(versions)) continue;
    for (const installed of versions as readonly unknown[]) {
      const entry = installed as {
        install_path?: unknown;
        version?: unknown;
      };
      if (typeof entry.install_path !== "string") continue;
      const version = entry.version;
      installations.push({
        name,
        path: entry.install_path,
        // An entry naming no version is still an installation, and is simply
        // no evidence of what is installed now.
        ...(typeof version === "string" ? { version } : {}),
      });
    }
  }
  return installations;
}

/** npm's own parseable listing: `<path>:<name>@<version>`, one per line. */
function readNpmListing(stdout: string): readonly Installation[] {
  const installations: Installation[] = [];
  for (const line of stdout.split("\n")) {
    const separator = line.lastIndexOf(":");
    if (separator < 0) continue;
    const label = line.slice(separator + 1);
    // A scoped name keeps its leading `@`; only a later one separates the
    // version this listing appends. A label carrying no version at all is the
    // prefix root npm heads its listing with — a path containing every global
    // package, which would otherwise claim ownership of all of them and name a
    // package (`lib`) nobody installed.
    const at = label.lastIndexOf("@");
    if (at <= 0 || at === label.length - 1) continue;
    installations.push({
      name: label.slice(0, at),
      path: line.slice(0, separator),
      version: label.slice(at + 1),
    });
  }
  return installations;
}

const managers: Readonly<Record<ManagerKind, Manager>> = Object.freeze({
  mise: {
    name: "mise",
    noun: "tool",
    listing: ["mise", "ls", "--installed", "--json"],
    read: readMiseListing,
    upgrade: (name: string) => ["mise", "upgrade", name],
    // mise defers a release until it reaches `minimum_release_age`, which
    // defaults to 24h and which this participant cannot see: it reads the
    // published release from GitHub, so without this the command would name a
    // version and then decline to install it. `tx update` is an explicit
    // request to update this one tool now, and the override reaches this one
    // child — every other tool and every other mise invocation keeps the
    // policy, and the user's configuration is not touched.
    upgradeEnvironment: { MISE_MINIMUM_RELEASE_AGE: "0" },
  },
  npm: {
    name: "npm",
    noun: "package",
    listing: ["npm", "ls", "--global", "--parseable", "--long"],
    read: readNpmListing,
    upgrade: (name: string) => ["npm", "install", "--global", name],
  },
});

/** Where mise keeps its installs when the environment moves them, and the
 * child of each such directory the installs actually live under. */
const miseStoreVariables = [
  ["MISE_INSTALLS_DIR", ""],
  ["MISE_DATA_DIR", "installs"],
] as const;

async function miseStores(
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly string[]> {
  const stores: string[] = [];
  for (const [variable, child] of miseStoreVariables) {
    const configured = env[variable];
    if (!configured) continue;
    const store = child ? join(configured, child) : configured;
    stores.push(store);
    try {
      // The target is compared as its real path, so a store reached through a
      // symlink has to be resolved too or it would not match its own installs.
      stores.push(await realpath(store));
    } catch {
      // Configured but not present: nothing is installed under it.
    }
  }
  return stores;
}

/**
 * The managers the project documents that could own a resolved path, in the
 * order to ask them, or nothing for a location neither owns.
 *
 * A `node_modules` tree inside a mise store carries both markers and the path
 * cannot say which one put it there: mise's own npm backend installs one, and
 * so does `npm install --global` under a Node that mise installed. npm is
 * asked first in that case, because npm can only claim a path it installed
 * into its own global prefix — which mise's backend prefix is not — and mise
 * answers for whatever npm does not claim. Getting this backwards would run
 * `mise upgrade node` for a `tx` npm installed, report it as done, and leave
 * the executable exactly where it was.
 *
 * The environment is read for the same reason: mise's default layout is the
 * only one a path announces on its own, so a store moved to somewhere like
 * `/opt/tool-cache/installs` would look unmanaged and be written into rather
 * than delegated to.
 */
export async function detectManagers(
  target: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<readonly ManagerKind[]> {
  const segments = target.split(sep);
  const mise =
    segments.some(
      (segment, index) =>
        segment === "mise" && segments[index + 1] === "installs",
    ) || (await miseStores(env)).some((store) => isWithin(store, target));
  const npm = segments.includes("node_modules");
  if (mise && npm) return ["npm", "mise"];
  if (mise) return ["mise"];
  if (npm) return ["npm"];
  return [];
}

/** The digest a `sha256sum` document publishes for one asset. */
export function publishedChecksum(
  document: string,
  asset: string,
): string | undefined {
  for (const line of document.split("\n")) {
    const [digest, ...rest] = line.trim().split(/\s+/);
    // `sha256sum` marks a binary-mode entry with `*` before the name.
    if (digest && rest.join(" ").replace(/^\*/, "") === asset) return digest;
  }
  return undefined;
}

/**
 * Whether a published version is strictly newer than what is running, as
 * semantic versions. Both are validated before they are ordered: the runtime's
 * comparison coerces what it cannot parse — reading `v1.2.x` as something
 * above `1.2.0` — and offering an update derived from a tag that cannot be
 * read is worse than offering none. Anything the project did not publish as a
 * semantic version therefore compares as no update at all, which is also how a
 * locally built executable ahead of the last release is left alone.
 */
export function isNewerRelease(published: string, running: string): boolean {
  const left = published.trim();
  const right = running.trim();
  if (!versionPattern.test(left) || !versionPattern.test(right)) return false;
  return Bun.semver.order(left, right) > 0;
}

/** The versions a listing reports for one tool, in the order it reported
 * them, skipping the entries that name none. */
function reportedVersions(
  installations: readonly Installation[],
  name: string,
): readonly string[] {
  return installations
    .filter((installation) => installation.name === name)
    .map((installation) => installation.version)
    .filter((version): version is string => version !== undefined);
}

/**
 * The newest of these versions that can be ordered at all, or undefined when
 * none can be.
 *
 * Selecting among the orderable ones is what makes this answer independent of
 * the order the manager listed them in. Folding every candidate through one
 * accumulator instead would latch on the first unorderable entry — `ref:main`,
 * which mise lists beside released versions — because `isNewerRelease` refuses
 * a comparison either side of which it cannot parse, and then nothing later
 * could displace it.
 */
function newestOrderable(versions: readonly string[]): string | undefined {
  let newest: string | undefined;
  for (const version of versions) {
    if (!versionPattern.test(version.trim())) continue;
    if (newest === undefined || isNewerRelease(version, newest)) {
      newest = version;
    }
  }
  return newest;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class ExecutableUpdater implements UpdateParticipant {
  readonly #version: string;
  readonly #fetch: FetchResource;
  readonly #run: RunCommand;
  readonly #executablePath: string;
  readonly #compiled: boolean;
  readonly #platform: string;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #staging: StagingPath;

  constructor(version: string, options: ExecutableUpdaterOptions = {}) {
    this.#version = version;
    this.#fetch = options.fetch ?? fetch;
    this.#run = options.run ?? runCommand;
    this.#executablePath = options.executablePath ?? process.execPath;
    this.#compiled = options.compiled ?? isCompiledModulePath(import.meta.dir);
    this.#platform = options.platform ?? `${process.platform}-${process.arch}`;
    this.#env = options.env ?? process.env;
    this.#staging = options.staging ?? stagingPath;
  }

  /**
   * Why this executable could not be replaced whatever else is true, or
   * undefined when it could. Both conditions are facts about the running
   * program rather than about its surroundings, so neither can change while
   * the command runs — which is what makes them the only two gates on
   * availability. Everything else that can stop an update is checked when
   * applying, because it can change in between and the user can act on it.
   */
  #irreplaceable(): string | undefined {
    if (!this.#compiled) {
      return "tx is running from a source checkout rather than as a compiled executable";
    }
    if (!publishedPlatforms.includes(this.#platform)) {
      return `no executable is published for ${this.#platform} (published: ${publishedPlatforms.join(", ")})`;
    }
    return undefined;
  }

  async gather(): Promise<readonly UpdateItem[]> {
    const tag = await this.#latestTag();
    // The `v` prefix is required rather than tolerated: applying rebuilds the
    // tag from the version it was handed, so a release tagged any other way
    // would be offered as an update whose assets nothing could then fetch.
    // [Architecture: Runtime and Distribution] requires that prefix of every
    // published version, so this withholds nothing the project publishes.
    if (!tag.startsWith("v") || !isNewerRelease(tag, this.#version)) {
      return [
        { name: itemName, current: this.#version, detail: `latest ${tag}` },
      ];
    }

    const available = tag.slice(1);
    // An available version is withheld where applying it would only be
    // refused, so the driver never manufactures a failure out of a platform or
    // a checkout. The release is still named, as detail.
    const irreplaceable = this.#irreplaceable();
    if (irreplaceable !== undefined) {
      return [
        {
          name: itemName,
          current: this.#version,
          detail: `${available} is published but ${irreplaceable}`,
        },
      ];
    }
    return [{ name: itemName, current: this.#version, available }];
  }

  async apply(item: UpdateItem): Promise<UpdateResult> {
    const irreplaceable = this.#irreplaceable();
    if (irreplaceable !== undefined)
      return { applied: false, detail: irreplaceable };
    const published = item.available;
    if (published === undefined) {
      return { applied: false, detail: "no published version to install" };
    }

    const target = await realpath(this.#executablePath);
    const kinds = await detectManagers(target, this.#env);
    if (kinds.length > 0) return this.#delegate(kinds, target);
    return this.#replace(target, published);
  }

  /** What every request this participant makes identifies itself with. */
  #headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      "user-agent": `tx/${this.#version}`,
    };
  }

  /**
   * The lookup's headers. The token goes on the API request and nowhere else:
   * it exists to raise the rate limit on unauthenticated API access, the
   * release assets are public and need none, and an asset download redirects
   * to a separate host that the token was never issued for.
   */
  #lookupHeaders(): Record<string, string> {
    const headers = this.#headers();
    const token = tokenVariables
      .map((name) => this.#env[name])
      .find((value) => value);
    return token === undefined
      ? headers
      : { ...headers, authorization: `Bearer ${token}` };
  }

  async #get(
    url: string,
    headers: Record<string, string> = this.#headers(),
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, { headers });
    } catch (error) {
      throw new Error(`Request to ${url} failed: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      throw new Error(
        `Request to ${url} failed: ${response.status} ${response.statusText}`,
      );
    }
    return response;
  }

  async #latestTag(): Promise<string> {
    const response = await this.#get(releaseEndpoint, this.#lookupHeaders());
    const payload = (await response.json()) as { tag_name?: unknown };
    const tag = payload.tag_name;
    if (typeof tag !== "string" || tag === "") {
      throw new Error(`Release lookup at ${releaseEndpoint} named no tag`);
    }
    return tag;
  }

  async #download(tag: string, asset: string): Promise<Uint8Array> {
    const response = await this.#get(`${downloadPrefix}/${tag}/${asset}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Runs the manager's own upgrade for whatever it says owns this path, in an
   * environment carrying whatever that manager's upgrade needs, and then asks
   * the manager what it has installed.
   *
   * A zero exit says the command ran, not that anything moved: a manager that
   * withheld the release, a tool the user pinned, and a registry that has not
   * published the version yet all exit successfully having installed nothing.
   * Only a version this upgrade is observed to have installed, and that is
   * strictly newer than the running one, is an update, and it is that observed
   * version that is reported — naming any other would be a claim rather than
   * an observation.
   *
   * The manager is asked rather than the file: the target is the install
   * directory of the version that is running, so after a successful upgrade
   * running it would report the old version or not exist at all.
   */
  async #delegate(
    kinds: readonly ManagerKind[],
    target: string,
  ): Promise<UpdateResult> {
    const { manager, name, installed } = await this.#owningManager(
      kinds,
      target,
    );
    const command = manager.upgrade(name);
    const spelled = command.join(" ");
    const result = await this.#run(command, {
      ...this.#env,
      ...manager.upgradeEnvironment,
    });
    if (result.exitCode !== 0) {
      throw new Error(`"${spelled}" failed: ${oneLine(result)}`);
    }
    const detail = `"${spelled}": ${oneLine(result)}`;
    const after = await this.#installedVersions(manager, name);
    // Measured against what the manager already reported before the upgrade,
    // not only against the running version: mise lists every installed
    // version, so a newer one that was on disk all along — a tool the user
    // pinned to an older version — would otherwise pass for something this
    // upgrade installed. Looking for a version that appeared, rather than
    // requiring the newest reported to have moved, still reports correctly
    // when the manager installs something while an even newer version sits
    // pinned beside it.
    const before = new Set(installed);
    const appeared = newestOrderable(
      after.filter((version) => !before.has(version)),
    );
    if (appeared !== undefined && isNewerRelease(appeared, this.#version)) {
      return { applied: true, version: appeared, detail };
    }
    // An upgrade whose effect was not observed is not success. It is not a
    // failure either: the command the user asked for ran and exited zero, and
    // the manager's own words are in the detail. What the user is still on is
    // the newest version reported that is not newer than the one running — a
    // newer one the manager reports is precisely the one this upgrade did not
    // install — falling back to whatever of those it reported first when none
    // of them can be ordered, and to the running version when it reports only
    // versions newer than that. Every candidate is drawn from the versions
    // that survived the filter, never from the ones it excluded: naming an
    // excluded version would tell the user they are on the very release this
    // upgrade failed to install.
    const remaining = after.filter(
      (version) => !isNewerRelease(version, this.#version),
    );
    const still =
      after.length === 0
        ? `${manager.name} reports no installed version of ${name}`
        : `still ${newestOrderable(remaining) ?? remaining[0] ?? this.#version}`;
    return { applied: false, detail: `${detail}; ${still}` };
  }

  /**
   * Every version the manager now reports for the tool it upgraded, in the
   * order it reported them, and nothing when its listing cannot be read or
   * names none. Unreadable is not an error here: the upgrade already
   * succeeded, and the caller reports an unobserved move as nothing applied
   * rather than exiting non-zero over it.
   */
  async #installedVersions(
    manager: Manager,
    name: string,
  ): Promise<readonly string[]> {
    const listing = await this.#run(manager.listing);
    return reportedVersions(manager.read(listing.stdout) ?? [], name);
  }

  /**
   * The first candidate manager that claims this path, what it says owns it,
   * and the versions it already reports for that name — the baseline a later
   * upgrade is observed against, read here because this interrogation reads
   * the listing anyway.
   *
   * Only a manager that answered and did not claim the path is passed over. An
   * interrogation that failed throws straight out of here rather than moving
   * on: the next candidate would answer about something else — the Node a
   * global npm install sits inside, say — and running an upgrade for that
   * would report success while leaving `tx` exactly where it was.
   */
  async #owningManager(
    kinds: readonly ManagerKind[],
    target: string,
  ): Promise<{
    manager: Manager;
    name: string;
    installed: readonly string[];
  }> {
    let refusal = new Error(`No version manager owns "${target}"`);
    for (const kind of kinds) {
      const manager = managers[kind];
      const owning = await this.#owningName(manager, target);
      if (owning !== undefined) return { manager, ...owning };
      refusal = new Error(
        `${manager.name} reported no ${manager.noun} owning "${target}"`,
      );
    }
    throw refusal;
  }

  /**
   * What the manager says owns this path, read from the manager's own
   * listing. The path is not asked to answer for itself: a backend, an owner,
   * and a repository collapse into one directory component through a
   * flattening that is not invertible, so reconstructing the name would
   * upgrade something the user may not have. The versions that listing already
   * reports for that name come back with it, so the state before an upgrade
   * costs no further command.
   *
   * The listing is read before its exit status is judged, because npm exits
   * non-zero for any problem anywhere in a global tree — an extraneous package
   * somebody else installed — after printing the very answer being asked for.
   * Undefined means the manager answered and does not own the path; a manager
   * that could not answer at all throws instead.
   */
  async #owningName(
    manager: Manager,
    target: string,
  ): Promise<{ name: string; installed: readonly string[] } | undefined> {
    const listing = await this.#run(manager.listing);
    const installations = manager.read(listing.stdout);
    if (installations !== undefined) {
      const owning = await owner(target, installations);
      if (owning !== undefined) {
        return {
          name: owning,
          installed: reportedVersions(installations, owning),
        };
      }
    }
    if (listing.exitCode !== 0) {
      throw new Error(
        `${manager.name} could not report which ${manager.noun} owns "${target}": ${oneLine(listing)}`,
      );
    }
    if (installations === undefined) {
      throw new Error(
        `${manager.name} did not report a readable list of installed ${manager.noun}s`,
      );
    }
    return undefined;
  }

  /**
   * Downloads the published executable, verifies it against the published
   * digest, stages it beside the target, confirms it runs and reports the
   * published version, and then moves it onto the target in one rename.
   *
   * The digest is checked before anything is written, so a mismatch leaves no
   * file to clean up; the run catches everything a digest cannot — an asset
   * built for another platform, a release rebuilt after its tag moved — while
   * there is still a working `tx` to fix it with.
   *
   * The small checksum document is fetched first, so a release that publishes
   * no asset for this platform is refused before an executable is pulled down
   * to be thrown away.
   */
  async #replace(target: string, published: string): Promise<UpdateResult> {
    // The release tag carries a `v`, which [Architecture: Runtime and
    // Distribution] requires of every published version.
    const tag = `v${published}`;
    const asset = `tx-${this.#platform}`;
    const document = new TextDecoder().decode(
      await this.#download(tag, checksumAsset),
    );
    const expected = publishedChecksum(document, asset);
    if (expected === undefined) {
      throw new Error(`${checksumAsset} for ${tag} publishes no ${asset}`);
    }

    const executable = await this.#download(tag, asset);
    const digest = createHash("sha256").update(executable).digest("hex");
    if (digest !== expected) {
      throw new Error(
        `Downloaded ${asset} does not match its published checksum: expected ${expected}, got ${digest}`,
      );
    }

    const staged = this.#staging(target);
    try {
      try {
        // Exclusive creation, so the staged name is one this process made:
        // opening it any other way would follow a symlink somebody planted at
        // the path and write the download through it. Owner-only until it is
        // verified, so nobody else holds a writable descriptor on the bytes
        // between the digest that vouched for them and the rename that
        // installs them; the mode a user runs it under is set after that.
        await writeFile(staged, executable, { flag: "wx", mode: 0o700 });
      } catch (error) {
        // Named rather than forced: acquiring privileges to write somewhere
        // the user cannot is not this command's call to make.
        throw new Error(
          `Cannot stage a replacement beside "${target}": ${errorMessage(error)}`,
        );
      }

      const check = await this.#run([staged, "--version"]);
      const reported = check.stdout.trim();
      if (check.exitCode !== 0 || reported !== published) {
        throw new Error(
          `Downloaded ${asset} reported "${reported || oneLine(check)}" rather than ${published}`,
        );
      }
      await chmod(staged, 0o755);
      await rename(staged, target);
    } finally {
      await discardStaged(staged);
    }
    return { applied: true, version: published };
  }
}
