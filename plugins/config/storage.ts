import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";

export interface UserDataDirectoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
}

export type ConfigDocument = Record<string, unknown>;

interface ConfigFileSystem {
  mkdir(
    path: string,
    options: { readonly recursive: true },
  ): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
  writeFile(
    path: string,
    contents: string,
    options: { readonly encoding: "utf8"; readonly flag: "wx" },
  ): Promise<void>;
}

export type ConfigStorageOverrides = Partial<ConfigFileSystem>;

export interface ConfigStorage {
  readonly path: string;
  read(): Promise<ConfigDocument>;
  write(document: ConfigDocument): Promise<void>;
}

const fileSystem: ConfigFileSystem = {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
};

function pathImplementation(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return env[name] || undefined;
}

function requiredHome(home: string | undefined): string {
  if (!home) {
    throw new Error(
      "Cannot resolve the user data directory without a home directory",
    );
  }
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

export function resolveConfigPath(
  options: UserDataDirectoryOptions = {},
): string {
  const paths = pathImplementation(options.platform ?? process.platform);
  return paths.join(resolveUserDataDirectory(options), "config.json");
}

function isDocument(value: unknown): value is ConfigDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(contents: string): ConfigDocument {
  const value: unknown = JSON.parse(contents);
  if (!isDocument(value)) {
    throw new Error("The config document must contain a JSON object");
  }
  return value;
}

export function createConfigStorage(
  path = resolveConfigPath(),
  overrides: ConfigStorageOverrides = {},
): ConfigStorage {
  const files = { ...fileSystem, ...overrides };

  return {
    path,
    async read() {
      try {
        return parseDocument(await files.readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
    },
    async write(document) {
      const parent = dirname(path);
      await files.mkdir(parent, { recursive: true });
      const temporaryPath = join(
        parent,
        `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        await files.writeFile(
          temporaryPath,
          `${JSON.stringify(document, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        await files.rename(temporaryPath, path);
      } finally {
        await files.rm(temporaryPath, { force: true });
      }
    },
  };
}
