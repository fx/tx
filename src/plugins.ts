import { pathToFileURL } from "node:url";
import * as ink from "ink";
import * as react from "react";
import packageMetadata from "../package.json" with { type: "json" };
import marketplacePlugin from "../plugins/marketplace/index.ts";
import type { CommandRegistration, CommandRegistry } from "./commands.ts";
import type { CommandOwner } from "./context.ts";
import {
  discoverInstalledMarketplaces,
  type MarketplaceManifest,
  prepareMarketplace,
  readMarketplaceManifest,
  resolveMarketplaceDirectory,
  validateMarketplaceName,
} from "./marketplaces.ts";
import type {
  CommandHandler,
  CoreDependencies,
  Plugin,
  PluginAPI,
} from "./plugin.ts";

export const coreDependencies: CoreDependencies = Object.freeze({
  tx: Object.freeze({ version: packageMetadata.version }),
  react,
  ink,
  versions: Object.freeze({
    react: packageMetadata.dependencies.react,
    ink: packageMetadata.dependencies.ink,
  }),
  marketplace: Object.freeze({
    resolveDirectory: resolveMarketplaceDirectory,
    validateName: validateMarketplaceName,
    discover: discoverInstalledMarketplaces,
    prepare: prepareMarketplace,
  }),
});

export interface PluginModule {
  readonly default?: unknown;
}

export type PluginSource = Plugin | PluginModule;
export type ImportPlugin = (entryPath: string) => Promise<PluginModule>;

export type PluginLoadFailure =
  | {
      readonly kind: "marketplace";
      readonly marketplace: string;
      readonly message: string;
    }
  | {
      readonly kind: "plugin";
      readonly marketplace: string;
      readonly plugin: string;
      readonly message: string;
    };

export interface InitializeMarketplacePluginsOptions {
  readonly importPlugin?: ImportPlugin;
}

function pluginName(owner: CommandOwner): string {
  return `${owner.marketplace}/${owner.plugin}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  const valueType = typeof value;
  return (
    value !== null &&
    (valueType === "object" || valueType === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function resolvePlugin(source: PluginSource, owner: CommandOwner): Plugin {
  const candidate = typeof source === "function" ? source : source.default;
  if (typeof candidate !== "function") {
    throw new Error(
      `Plugin ${pluginName(owner)} must default-export a function`,
    );
  }
  return candidate as Plugin;
}

export async function initializeFirstPartyPlugins(
  registry: CommandRegistry,
): Promise<void> {
  await initializePlugin(
    registry,
    { marketplace: "core", plugin: "marketplace" },
    marketplacePlugin,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function importPlugin(entryPath: string): Promise<PluginModule> {
  return import(pathToFileURL(entryPath).href);
}

export async function initializeMarketplacePlugins(
  registry: CommandRegistry,
  root: string,
  options: InitializeMarketplacePluginsOptions = {},
): Promise<readonly PluginLoadFailure[]> {
  const failures: PluginLoadFailure[] = [];
  const marketplaces = await discoverInstalledMarketplaces(root);

  for (const { name: marketplace, checkout } of marketplaces) {
    let manifest: MarketplaceManifest;
    try {
      manifest = await readMarketplaceManifest(checkout);
    } catch (error) {
      failures.push({
        kind: "marketplace",
        marketplace,
        message: errorMessage(error),
      });
      continue;
    }

    for (const plugin of manifest.plugins) {
      try {
        const source = await (options.importPlugin ?? importPlugin)(
          plugin.entryPath,
        );
        await initializePlugin(
          registry,
          { marketplace, plugin: plugin.name },
          source,
        );
      } catch (error) {
        failures.push({
          kind: "plugin",
          marketplace,
          plugin: plugin.name,
          message: errorMessage(error),
        });
      }
    }
  }

  return Object.freeze(failures);
}

export async function initializePlugin(
  registry: CommandRegistry,
  owner: CommandOwner,
  source: PluginSource,
): Promise<void> {
  const scopedOwner = Object.freeze({ ...owner });
  const plugin = resolvePlugin(source, scopedOwner);
  let registrations: CommandRegistration[] | undefined = [];
  const api: PluginAPI = Object.freeze({
    command(path: string | readonly string[], handler: CommandHandler) {
      if (!registrations) {
        throw new Error(
          `Plugin ${pluginName(scopedOwner)} cannot register commands after initialization`,
        );
      }
      registrations.push({ path, owner: scopedOwner, handler });
    },
    dependencies: coreDependencies,
  });

  let batch: CommandRegistration[] = [];
  try {
    const result = plugin(api);
    if (isPromiseLike(result)) await result;
  } finally {
    batch = registrations ?? [];
    registrations = undefined;
  }

  registry.registerBatch(batch);
}
