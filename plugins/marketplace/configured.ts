import type { MarketplaceOperations, ResolvedMarketplace } from "./manager.ts";

export type ConfigValidator<T> = (value: unknown) => value is T;

export interface Config {
  define<T>(key: string, isValid: ConfigValidator<T>): void;
  read<T>(key: string): Promise<T | undefined>;
  write<T>(key: string, value: T): Promise<void>;
}

export interface ConfiguredMarketplace {
  readonly source: string;
  readonly name?: string;
}

export const marketplaceConfigKey = "marketplace";

export class ConfiguredMarketplaceNameCollisionError extends Error {
  readonly marketplaceName: string;

  constructor(name: string) {
    super(
      `Configured marketplace name "${name}" appears more than once; keep only one entry for each marketplace name`,
    );
    this.name = "ConfiguredMarketplaceNameCollisionError";
    this.marketplaceName = name;
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isConfiguredMarketplaceList(
  value: unknown,
): value is readonly ConfiguredMarketplace[] {
  if (!Array.isArray(value)) return false;

  const names = new Set<string>();
  for (const entry of value) {
    if (!isObject(entry)) return false;
    const source = Reflect.get(entry, "source");
    const name = Reflect.get(entry, "name");
    if (
      typeof source !== "string" ||
      (name !== undefined && typeof name !== "string")
    ) {
      return false;
    }
    if (name !== undefined) {
      if (names.has(name)) {
        throw new ConfiguredMarketplaceNameCollisionError(name);
      }
      names.add(name);
    }
  }
  return true;
}

export function requireConfigCapability(
  registrations: <T>(key: string) => readonly T[],
): Config {
  const configs = registrations<Config>("config");
  if (configs.length !== 1) {
    throw new Error(
      `Expected exactly one config capability, but found ${configs.length}`,
    );
  }
  return configs[0] as Config;
}

export async function readConfiguredMarketplaces(
  config: Config,
): Promise<readonly ConfiguredMarketplace[]> {
  config.define(marketplaceConfigKey, isConfiguredMarketplaceList);
  return (await config.read(marketplaceConfigKey)) ?? [];
}

async function effectiveName(
  entry: ConfiguredMarketplace,
  manager: MarketplaceOperations,
): Promise<string> {
  return entry.name ?? (await manager.resolve(entry.source)).name;
}

export async function recordConfiguredMarketplace(
  config: Config,
  manager: MarketplaceOperations,
  added: ResolvedMarketplace,
): Promise<void> {
  const entries = await readConfiguredMarketplaces(config);
  const next: ConfiguredMarketplace[] = [];
  let replaced = false;

  for (const entry of entries) {
    if ((await effectiveName(entry, manager)) === added.name) {
      if (!replaced) next.push(added);
      replaced = true;
    } else {
      next.push(entry);
    }
  }
  if (!replaced) next.push(added);
  await config.write(marketplaceConfigKey, next);
}

export async function forgetConfiguredMarketplace(
  config: Config,
  manager: MarketplaceOperations,
  removedName: string,
): Promise<void> {
  const entries = await readConfiguredMarketplaces(config);
  const next: ConfiguredMarketplace[] = [];

  for (const entry of entries) {
    if ((await effectiveName(entry, manager)) !== removedName) next.push(entry);
  }
  await config.write(marketplaceConfigKey, next);
}

export async function resolveConfiguredMarketplaces(
  entries: readonly ConfiguredMarketplace[],
  manager: MarketplaceOperations,
): Promise<readonly ResolvedMarketplace[]> {
  const resolved = await Promise.all(
    entries.map((entry) => manager.resolve(entry.source, entry.name)),
  );
  const names = new Set<string>();
  for (const marketplace of resolved) {
    if (names.has(marketplace.name)) {
      throw new ConfiguredMarketplaceNameCollisionError(marketplace.name);
    }
    names.add(marketplace.name);
  }
  return resolved;
}
