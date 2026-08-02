import type { Dirent, Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

export interface UserDataDirectoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
}

export interface AddMarketplaceArguments {
  readonly repository: string;
  readonly name?: string;
}

export interface MarketplaceListing {
  readonly name: string;
  readonly source: string;
}

export interface GitResult {
  readonly stdout: string;
}

export type RunGit = (args: readonly string[]) => Promise<GitResult>;
export type RunBun = (
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<void>;
export type PrepareMarketplace = (checkout: string) => void | Promise<void>;

export interface MarketplaceManagerOptions {
  readonly runGit?: RunGit;
  readonly prepareMarketplace?: PrepareMarketplace;
}

export interface MarketplacePluginEntry {
  readonly name: string;
  readonly entry: string;
  readonly entryPath: string;
}

export interface MarketplaceManifest {
  readonly plugins: readonly MarketplacePluginEntry[];
}

export interface PrepareMarketplaceOptions {
  readonly runBun?: RunBun;
}

const marketplaceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const manifestFilename = "tx.marketplace.json";

function pathImplementation(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function isSafeMarketplaceName(name: string): boolean {
  return marketplaceNamePattern.test(name);
}

function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return env[name] || undefined;
}

function requiredHome(home: string | undefined): string {
  if (!home)
    throw new Error(
      "Cannot resolve the user data directory without a home directory",
    );
  return home;
}

export function resolveUserDataDirectory(
  options: UserDataDirectoryOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const paths = pathImplementation(platform);

  if (platform === "win32") {
    const base =
      environmentValue(env, "LOCALAPPDATA") ?? environmentValue(env, "APPDATA");
    return paths.join(
      base ?? requiredHome(home),
      base ? "tx" : "AppData",
      ...(base ? [] : ["Local", "tx"]),
    );
  }

  if (platform === "darwin") {
    return paths.join(
      requiredHome(home),
      "Library",
      "Application Support",
      "tx",
    );
  }

  const xdgDataHome = environmentValue(env, "XDG_DATA_HOME");
  const base =
    xdgDataHome && paths.isAbsolute(xdgDataHome)
      ? xdgDataHome
      : paths.join(requiredHome(home), ".local", "share");
  return paths.join(base, "tx");
}

export function resolveMarketplaceDirectory(
  options: UserDataDirectoryOptions = {},
): string {
  const paths = pathImplementation(options.platform ?? process.platform);
  return paths.join(resolveUserDataDirectory(options), "marketplaces");
}

export function validateMarketplaceName(name: string): string {
  if (!isSafeMarketplaceName(name)) {
    throw new Error(
      `Invalid marketplace name "${name}"; expected one safe path component`,
    );
  }
  return name;
}

function containedMarketplacePath(root: string, name: string): string {
  validateMarketplaceName(name);
  const paths = pathImplementation(process.platform);
  const resolvedRoot = paths.resolve(root);
  const target = paths.resolve(resolvedRoot, name);
  const relation = paths.relative(resolvedRoot, target);
  if (
    !relation ||
    relation.startsWith(`..${paths.sep}`) ||
    relation === ".." ||
    paths.isAbsolute(relation)
  ) {
    throw new Error(
      `Marketplace path for "${name}" escapes marketplace storage`,
    );
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContainedPath(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

async function resolvePluginEntry(
  checkoutPath: string,
  pluginName: string,
  entry: string,
): Promise<string> {
  if (!entry || isAbsolute(entry)) {
    throw new Error(
      `Plugin "${pluginName}" entry must be a repository-relative path`,
    );
  }

  const entryPath = resolve(checkoutPath, entry);
  if (!isContainedPath(checkoutPath, entryPath)) {
    throw new Error(`Plugin "${pluginName}" entry escapes the marketplace`);
  }

  let metadata: Stats;
  let resolvedEntry: string;
  try {
    [metadata, resolvedEntry] = await Promise.all([
      stat(entryPath),
      realpath(entryPath),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Plugin "${pluginName}" entry does not exist: ${entry}`);
    }
    throw error;
  }

  if (!metadata.isFile()) {
    throw new Error(
      `Plugin "${pluginName}" entry is not a regular file: ${entry}`,
    );
  }
  if (!isContainedPath(checkoutPath, resolvedEntry)) {
    throw new Error(`Plugin "${pluginName}" entry escapes the marketplace`);
  }
  return resolvedEntry;
}

export async function readMarketplaceManifest(
  checkout: string,
): Promise<MarketplaceManifest> {
  const checkoutPath = await realpath(checkout);
  const manifestPath = resolve(checkoutPath, manifestFilename);
  let document: unknown;
  try {
    const resolvedManifestPath = await realpath(manifestPath);
    if (!isContainedPath(checkoutPath, resolvedManifestPath)) {
      throw new Error(`${manifestFilename} escapes the marketplace`);
    }
    document = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing ${manifestFilename}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ${manifestFilename}: ${error.message}`);
    }
    throw error;
  }

  if (!isRecord(document)) {
    throw new Error(`${manifestFilename} must contain a plugins array`);
  }
  const pluginValues = (document as { plugins?: unknown }).plugins;
  if (!Array.isArray(pluginValues)) {
    throw new Error(`${manifestFilename} must contain a plugins array`);
  }
  if (pluginValues.length === 0) {
    throw new Error(`${manifestFilename} plugins must not be empty`);
  }

  const names = new Set<string>();
  const plugins: MarketplacePluginEntry[] = [];
  for (const [index, value] of pluginValues.entries()) {
    if (!isRecord(value)) {
      throw new Error(
        `${manifestFilename} plugin ${index + 1} must be an object`,
      );
    }
    const candidate = value as { name?: unknown; entry?: unknown };
    if (
      typeof candidate.name !== "string" ||
      !isSafeMarketplaceName(candidate.name)
    ) {
      throw new Error(
        `${manifestFilename} plugin ${index + 1} must have a safe non-empty name`,
      );
    }
    if (names.has(candidate.name)) {
      throw new Error(`Duplicate plugin name "${candidate.name}"`);
    }
    if (typeof candidate.entry !== "string") {
      throw new Error(`Plugin "${candidate.name}" entry must be a string`);
    }

    names.add(candidate.name);
    plugins.push(
      Object.freeze({
        name: candidate.name,
        entry: candidate.entry,
        entryPath: await resolvePluginEntry(
          checkoutPath,
          candidate.name,
          candidate.entry,
        ),
      }),
    );
  }

  return Object.freeze({ plugins: Object.freeze(plugins) });
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

export function parseAddMarketplaceArguments(
  args: readonly string[],
): AddMarketplaceArguments {
  let repository: string | undefined;
  let name: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--name") {
      if (name !== undefined)
        throw new Error("--name may only be specified once");
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--name requires a value");
      }
      name = validateMarketplaceName(value);
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option "${argument}"`);
    } else if (repository === undefined) {
      repository = argument;
    } else {
      throw new Error("marketplace add accepts exactly one repository");
    }
  }

  if (repository === undefined) {
    throw new Error("Usage: tx marketplace add <repository> [--name <name>]");
  }
  return name === undefined ? { repository } : { repository, name };
}

export function parseListMarketplaceArguments(args: readonly string[]): void {
  if (args.length !== 0) throw new Error("Usage: tx marketplace list");
}

export function parseRemoveMarketplaceArguments(
  args: readonly string[],
): string {
  if (args.length !== 1) throw new Error("Usage: tx marketplace remove <name>");
  return validateMarketplaceName(args[0] as string);
}

export async function runGit(args: readonly string[]): Promise<GitResult> {
  const gitProcess = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    gitProcess.exited,
    new Response(gitProcess.stdout).text(),
    new Response(gitProcess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(`Git command failed${detail ? `: ${detail}` : ""}`);
  }
  return { stdout };
}

export async function runBun(
  args: readonly string[],
  options: { readonly cwd: string },
): Promise<void> {
  const bunProcess = Bun.spawn(["bun", ...args], {
    cwd: options.cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    bunProcess.exited,
    new Response(bunProcess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(
      `Bun dependency installation failed${detail ? `: ${detail}` : ""}`,
    );
  }
}

export async function prepareMarketplace(
  checkout: string,
  options: PrepareMarketplaceOptions = {},
): Promise<void> {
  await readMarketplaceManifest(checkout);
  if (await pathExists(resolve(checkout, "package.json"))) {
    await (options.runBun ?? runBun)(["install"], { cwd: checkout });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function discoverInstalledMarketplaces(
  root: string,
): Promise<readonly { readonly name: string; readonly checkout: string }[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => isSafeMarketplaceName(entry.name) && entry.isDirectory())
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    .map((entry) => ({
      name: entry.name,
      checkout: containedMarketplacePath(root, entry.name),
    }));
}

export class MarketplaceManager {
  readonly #root: string;
  readonly #runGit: RunGit;
  readonly #prepareMarketplace: PrepareMarketplace;

  constructor(root: string, options: MarketplaceManagerOptions = {}) {
    this.#root = root;
    this.#runGit = options.runGit ?? runGit;
    this.#prepareMarketplace = options.prepareMarketplace ?? prepareMarketplace;
  }

  async add(repository: string, requestedName?: string): Promise<string> {
    const name = requestedName ?? deriveMarketplaceName(repository);
    const target = containedMarketplacePath(this.#root, name);
    await mkdir(this.#root, { recursive: true });
    if (await pathExists(target)) {
      throw new Error(`Marketplace "${name}" is already installed`);
    }

    const paths = pathImplementation(process.platform);
    const staging = await mkdtemp(
      paths.join(paths.dirname(target), `.${name}-staging-`),
    );
    try {
      await this.#runGit(["clone", "--", repository, staging]);
      await this.#prepareMarketplace(staging);
      if (await pathExists(target)) {
        throw new Error(`Marketplace "${name}" is already installed`);
      }
      await rename(staging, target);
      return name;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async list(): Promise<readonly MarketplaceListing[]> {
    const marketplaces = await discoverInstalledMarketplaces(this.#root);
    return Promise.all(
      marketplaces.map(
        async ({ name, checkout }): Promise<MarketplaceListing> => {
          let source = "<unknown>";
          try {
            const result = await this.#runGit([
              "-C",
              checkout,
              "config",
              "--get",
              "remote.origin.url",
            ]);
            source = result.stdout.trim() || "<unknown>";
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
