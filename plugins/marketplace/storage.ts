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
  readonly packagePaths: readonly string[];
}

interface ResolvedPath {
  readonly metadata: Stats;
  readonly path: string;
}

type PackagePathInspection =
  | { readonly existing: ResolvedPath; readonly resolvedAncestor?: never }
  | { readonly existing?: never; readonly resolvedAncestor: string };

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

async function resolveExistingPath(
  path: string,
): Promise<ResolvedPath | undefined> {
  try {
    const [metadata, resolvedPath] = await Promise.all([
      stat(path),
      realpath(path),
    ]);
    return { metadata, path: resolvedPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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

  const resolvedEntry = await resolveExistingPath(entryPath);
  if (resolvedEntry === undefined) {
    throw new Error(`Plugin "${pluginName}" entry does not exist: ${entry}`);
  }
  if (!resolvedEntry.metadata.isFile()) {
    throw new Error(
      `Plugin "${pluginName}" entry is not a regular file: ${entry}`,
    );
  }
  if (!isContainedPath(checkoutPath, resolvedEntry.path)) {
    throw new Error(`Plugin "${pluginName}" entry escapes the marketplace`);
  }
  return resolvedEntry.path;
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

function selectPackageCandidate(
  checkoutPath: string,
  pluginName: string,
  entryPath: string,
  packageValue: string | undefined,
): string {
  if (packageValue === undefined) {
    return resolve(dirname(entryPath), "package.json");
  }
  if (!packageValue || isAbsolute(packageValue)) {
    throw new Error(
      `Plugin "${pluginName}" package must be a repository-relative path to package.json`,
    );
  }
  const candidate = resolve(checkoutPath, packageValue);
  if (!isContainedPath(checkoutPath, candidate)) {
    throw new Error(`Plugin "${pluginName}" package escapes the marketplace`);
  }
  if (basename(candidate) !== "package.json") {
    throw new Error(
      `Plugin "${pluginName}" package must name package.json exactly`,
    );
  }
  return candidate;
}

async function inspectPackageCandidate(
  candidate: string,
): Promise<PackagePathInspection> {
  const existing = await resolveExistingPath(candidate);
  if (existing !== undefined) return { existing };
  const ancestor = await deepestExistingAncestor(candidate);
  return { resolvedAncestor: await realpath(ancestor) };
}

function resolvePackageCandidate(
  checkoutPath: string,
  pluginName: string,
  candidate: string,
  packageValue: string | undefined,
  inspection: PackagePathInspection,
): string | undefined {
  if (inspection.existing === undefined) {
    if (!isContainedPath(checkoutPath, inspection.resolvedAncestor)) {
      throw new Error(`Plugin "${pluginName}" package escapes the marketplace`);
    }
    return undefined;
  }

  if (!inspection.existing.metadata.isFile()) {
    throw new Error(
      `Plugin "${pluginName}" package is not a regular file: ${packageValue ?? candidate}`,
    );
  }
  if (!isContainedPath(checkoutPath, inspection.existing.path)) {
    throw new Error(`Plugin "${pluginName}" package escapes the marketplace`);
  }
  if (basename(inspection.existing.path) !== "package.json") {
    throw new Error(
      `Plugin "${pluginName}" package must resolve to package.json`,
    );
  }
  return inspection.existing.path;
}

async function resolveMarketplaceManifest(
  checkout: string,
  resolvePackages: boolean,
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
  const candidates = pluginValues.map((value, index) => {
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
    let packageValue: string | undefined;
    if (Object.hasOwn(value, "package")) {
      if (typeof candidate.package !== "string") {
        throw new Error(`Plugin "${candidate.name}" package must be a string`);
      }
      packageValue = candidate.package;
    }
    names.add(candidate.name);
    return {
      name: candidate.name,
      entry: candidate.entry,
      package: packageValue,
    };
  });

  const resolvedPlugins = await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      entryPath: await resolvePluginEntry(
        checkoutPath,
        candidate.name,
        candidate.entry,
      ),
    })),
  );
  const packageCandidates = resolvedPlugins.map((plugin) => ({
    candidate: selectPackageCandidate(
      checkoutPath,
      plugin.name,
      plugin.entryPath,
      plugin.package,
    ),
    plugin,
  }));
  const packageInspections = new Map<string, Promise<PackagePathInspection>>();
  const resolvedPackages = resolvePackages
    ? await Promise.all(
        packageCandidates.map(async ({ candidate, plugin }) => {
          let inspection = packageInspections.get(candidate);
          if (inspection === undefined) {
            inspection = inspectPackageCandidate(candidate);
            packageInspections.set(candidate, inspection);
          }
          return resolvePackageCandidate(
            checkoutPath,
            plugin.name,
            candidate,
            plugin.package,
            await inspection,
          );
        }),
      )
    : [];

  const plugins = resolvedPlugins.map(
    ({ name, entry, entryPath, package: packageValue }) =>
      Object.freeze({
        name,
        entry,
        entryPath,
        ...(packageValue === undefined ? {} : { package: packageValue }),
      }),
  );
  const installed = new Set<string>();
  const packagePaths = resolvedPackages.flatMap((packagePath) => {
    if (packagePath === undefined || installed.has(packagePath)) return [];
    installed.add(packagePath);
    return [packagePath];
  });

  return Object.freeze({
    manifest: Object.freeze({ plugins: Object.freeze(plugins) }),
    packagePaths: Object.freeze(packagePaths),
  });
}

export async function readMarketplaceManifest(
  checkout: string,
): Promise<MarketplaceManifest> {
  return (await resolveMarketplaceManifest(checkout, false)).manifest;
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
  const { packagePaths } = await resolveMarketplaceManifest(checkout, true);
  for (const packagePath of packagePaths) {
    await (options.runBun ?? runBun)(["install"], {
      cwd: dirname(packagePath),
      env: options.env ?? process.env,
    });
  }
}

/**
 * Whether an installed marketplace is a live reference rather than a checkout
 * tx owns. One predicate, because listing and updating have to agree about
 * which marketplaces have a remote at all.
 */
export async function isMarketplaceReference(
  checkout: string,
): Promise<boolean> {
  return (await lstat(checkout)).isSymbolicLink();
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

/**
 * A marketplace is a real directory or a reference to one. A reference is kept
 * whatever it now resolves to — a directory, a non-directory, or nothing —
 * because it still occupies its name. Dropping a degraded one would hide an
 * installed marketplace from listing and recovery instead of diagnosing it.
 */
function isInstalledMarketplaceEntry(entry: Dirent<string>): boolean {
  return (
    isSafeMarketplaceName(entry.name) &&
    (entry.isDirectory() || entry.isSymbolicLink())
  );
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
    .filter(isInstalledMarketplaceEntry)
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    .map((entry) => ({
      name: entry.name,
      checkout: containedMarketplacePath(root, entry.name),
    }));
}
