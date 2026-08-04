import { execFile } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface UserDataDirectoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
}

export interface MarketplaceCheckout {
  readonly name: string;
  readonly checkout: string;
}

export interface MarketplacePluginEntry {
  readonly name: string;
  readonly entry: string;
  readonly entryPath: string;
  readonly package?: string;
}

export interface MarketplaceManifest {
  readonly plugins: readonly MarketplacePluginEntry[];
}

interface ResolvedMarketplaceManifest {
  readonly manifest: MarketplaceManifest;
  readonly packagePaths: readonly (string | undefined)[];
}

export type RunBun = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
) => Promise<void>;

export interface PrepareMarketplaceOptions {
  readonly runBun?: RunBun;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const marketplaceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const manifestFilename = ".tx/config.json";
const legacyManifestFilename = "tx.marketplace.json";

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
  const home = () => requiredHome(options.home ?? homedir());
  const paths = pathImplementation(platform);

  if (platform === "win32") {
    const base =
      environmentValue(env, "LOCALAPPDATA") ?? environmentValue(env, "APPDATA");
    if (base) return paths.join(base, "tx");
    return paths.join(home(), "AppData", "Local", "tx");
  }

  if (platform === "darwin") {
    return paths.join(home(), "Library", "Application Support", "tx");
  }

  const xdgDataHome = environmentValue(env, "XDG_DATA_HOME");
  const base =
    xdgDataHome && paths.isAbsolute(xdgDataHome)
      ? xdgDataHome
      : paths.join(home(), ".local", "share");
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

export function containedMarketplacePath(root: string, name: string): string {
  validateMarketplaceName(name);
  return pathImplementation(process.platform).resolve(root, name);
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

async function deepestExistingAncestor(path: string): Promise<string> {
  try {
    await lstat(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return deepestExistingAncestor(dirname(path));
  }
}

async function resolvePackageCandidate(
  checkoutPath: string,
  pluginName: string,
  entryPath: string,
  packageValue: unknown,
  hasPackageOverride: boolean,
): Promise<string | undefined> {
  let candidate: string;
  if (hasPackageOverride) {
    if (
      typeof packageValue !== "string" ||
      !packageValue ||
      isAbsolute(packageValue)
    ) {
      throw new Error(
        `Plugin "${pluginName}" package must be a repository-relative path to package.json`,
      );
    }
    candidate = resolve(checkoutPath, packageValue);
    if (!isContainedPath(checkoutPath, candidate)) {
      throw new Error(`Plugin "${pluginName}" package escapes the marketplace`);
    }
    if (basename(candidate) !== "package.json") {
      throw new Error(
        `Plugin "${pluginName}" package must name package.json exactly`,
      );
    }
  } else {
    candidate = resolve(dirname(entryPath), "package.json");
  }

  let metadata: Stats;
  let resolvedPackage: string;
  try {
    [metadata, resolvedPackage] = await Promise.all([
      stat(candidate),
      realpath(candidate),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const existingAncestor = await deepestExistingAncestor(candidate);
    const resolvedAncestor = await realpath(existingAncestor);
    if (!isContainedPath(checkoutPath, resolvedAncestor)) {
      throw new Error(`Plugin "${pluginName}" package escapes the marketplace`);
    }
    return undefined;
  }

  if (!metadata.isFile()) {
    throw new Error(
      `Plugin "${pluginName}" package is not a regular file: ${hasPackageOverride ? packageValue : candidate}`,
    );
  }
  if (!isContainedPath(checkoutPath, resolvedPackage)) {
    throw new Error(`Plugin "${pluginName}" package escapes the marketplace`);
  }
  if (basename(resolvedPackage) !== "package.json") {
    throw new Error(
      `Plugin "${pluginName}" package must resolve to package.json`,
    );
  }
  return resolvedPackage;
}

async function resolveMarketplaceManifest(
  checkout: string,
): Promise<ResolvedMarketplaceManifest> {
  let checkoutPath: string;
  let selectedManifestFilename = manifestFilename;
  let document: unknown;
  try {
    checkoutPath = await realpath(checkout);
    const preferredManifestPath = resolve(checkoutPath, manifestFilename);
    if (!(await pathExists(preferredManifestPath))) {
      const legacyManifestPath = resolve(checkoutPath, legacyManifestFilename);
      if (!(await pathExists(legacyManifestPath))) {
        throw new Error(`Missing ${manifestFilename}`);
      }
      selectedManifestFilename = legacyManifestFilename;
    }
    const resolvedManifestPath = await realpath(
      resolve(checkoutPath, selectedManifestFilename),
    );
    if (!isContainedPath(checkoutPath, resolvedManifestPath)) {
      throw new Error(`${selectedManifestFilename} escapes the marketplace`);
    }
    document = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing ${selectedManifestFilename}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ${selectedManifestFilename}: ${error.message}`);
    }
    if (typeof (error as NodeJS.ErrnoException).code === "string") {
      throw new Error(
        `Unable to read ${selectedManifestFilename}: ${(error as Error).message}`,
      );
    }
    throw error;
  }

  if (!isRecord(document)) {
    throw new Error(`${selectedManifestFilename} must contain a plugins array`);
  }
  const pluginValues = (document as { plugins?: unknown }).plugins;
  if (!Array.isArray(pluginValues)) {
    throw new Error(`${selectedManifestFilename} must contain a plugins array`);
  }
  if (pluginValues.length === 0) {
    throw new Error(`${selectedManifestFilename} plugins must not be empty`);
  }

  const names = new Set<string>();
  const plugins: MarketplacePluginEntry[] = [];
  const packagePaths: (string | undefined)[] = [];
  for (const [index, value] of pluginValues.entries()) {
    if (!isRecord(value)) {
      throw new Error(
        `${selectedManifestFilename} plugin ${index + 1} must be an object`,
      );
    }
    const candidate = value as {
      name?: unknown;
      entry?: unknown;
      package?: unknown;
    };
    if (
      typeof candidate.name !== "string" ||
      !isSafeMarketplaceName(candidate.name)
    ) {
      throw new Error(
        `${selectedManifestFilename} plugin ${index + 1} must have a safe non-empty name`,
      );
    }
    if (names.has(candidate.name)) {
      throw new Error(`Duplicate plugin name "${candidate.name}"`);
    }
    if (typeof candidate.entry !== "string") {
      throw new Error(`Plugin "${candidate.name}" entry must be a string`);
    }

    const hasPackageOverride = Object.hasOwn(value, "package");
    if (hasPackageOverride && typeof candidate.package !== "string") {
      throw new Error(`Plugin "${candidate.name}" package must be a string`);
    }
    const entryPath = await resolvePluginEntry(
      checkoutPath,
      candidate.name,
      candidate.entry,
    );
    const packagePath = await resolvePackageCandidate(
      checkoutPath,
      candidate.name,
      entryPath,
      candidate.package,
      hasPackageOverride,
    );

    names.add(candidate.name);
    plugins.push(
      Object.freeze({
        name: candidate.name,
        entry: candidate.entry,
        entryPath,
        ...(hasPackageOverride ? { package: candidate.package as string } : {}),
      }),
    );
    packagePaths.push(packagePath);
  }

  return Object.freeze({
    manifest: Object.freeze({ plugins: Object.freeze(plugins) }),
    packagePaths: Object.freeze(packagePaths),
  });
}

export async function readMarketplaceManifest(
  checkout: string,
): Promise<MarketplaceManifest> {
  return (await resolveMarketplaceManifest(checkout)).manifest;
}

export async function runBun(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): Promise<void> {
  try {
    await executeFile(process.execPath, [...args], {
      cwd: options.cwd,
      env: { ...options.env, BUN_BE_BUN: "1" },
    });
  } catch (error) {
    const detail =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim()
        : "";
    throw new Error(
      `Bun dependency installation failed${detail ? `: ${detail}` : ""}`,
    );
  }
}

export async function prepareMarketplace(
  checkout: string,
  options: PrepareMarketplaceOptions = {},
): Promise<void> {
  const { packagePaths } = await resolveMarketplaceManifest(checkout);
  const installed = new Set<string>();
  for (const packagePath of packagePaths) {
    if (packagePath === undefined || installed.has(packagePath)) continue;
    installed.add(packagePath);
    await (options.runBun ?? runBun)(["install"], {
      cwd: dirname(packagePath),
      env: options.env ?? process.env,
    });
  }
}

export async function pathExists(path: string): Promise<boolean> {
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
): Promise<readonly MarketplaceCheckout[]> {
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
