import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

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
export type PrepareMarketplace = (checkout: string) => void | Promise<void>;

export interface MarketplaceManagerOptions {
  readonly runGit?: RunGit;
  readonly prepareMarketplace?: PrepareMarketplace;
}

const marketplaceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

  return paths.join(
    environmentValue(env, "XDG_DATA_HOME") ??
      paths.join(requiredHome(home), ".local", "share"),
    "tx",
  );
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
  const process = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(`Git command failed${detail ? `: ${detail}` : ""}`);
  }
  return { stdout };
}

export const prepareMarketplace: PrepareMarketplace = async () => {};

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const listings: MarketplaceListing[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      if (!isSafeMarketplaceName(entry.name)) continue;
      const checkout = containedMarketplacePath(this.#root, entry.name);
      try {
        const metadata = await lstat(checkout);
        if (!metadata.isDirectory()) continue;
      } catch {
        continue;
      }

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
      listings.push({ name: entry.name, source });
    }
    return listings;
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
