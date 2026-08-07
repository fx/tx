import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readlink, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  add(repository: string, requestedName?: string): Promise<string>;
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
}

const githubRepositoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const unknownSource = "<unknown>";

export function normalizeMarketplaceRepository(repository: string): string {
  if (!githubRepositoryPattern.test(repository)) return repository;
  return `https://github.com/${repository}${repository.endsWith(".git") ? "" : ".git"}`;
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

  constructor(root: string, options: MarketplaceManagerOptions = {}) {
    this.#root = root;
    this.#runGit = options.runGit ?? runGit;
    this.#prepare = options.prepare;
    this.#env = options.env ?? process.env;
  }

  async add(repository: string, requestedName?: string): Promise<string> {
    let name = requestedName;
    if (name === undefined) {
      try {
        name = deriveMarketplaceName(repository);
      } catch (error) {
        throw new Error(
          `Cannot derive a safe marketplace name from "${repository}"; pass --name <name>`,
          { cause: error },
        );
      }
    }
    const target = containedMarketplacePath(this.#root, name);
    await mkdir(this.#root, { recursive: true });
    if (await pathExists(target)) {
      throw new Error(`Marketplace "${name}" is already installed`);
    }

    const staging = await mkdtemp(join(dirname(target), `.${name}-staging-`));
    try {
      await this.#runGit(
        ["clone", "--", normalizeMarketplaceRepository(repository), staging],
        { env: this.#env },
      );
      if (this.#prepare) await this.#prepare(staging);
      else await prepareMarketplace(staging, { env: this.#env });
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
